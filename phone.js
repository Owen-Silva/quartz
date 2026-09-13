'use strict';

/*
 * phone.js — the Phone workspace's brain (main process): the tools (adb + the
 * scrcpy server), the device (pairing, connecting, pinning), the stream (the
 * scrcpy server running ON the phone, its three sockets tunnelled over adb),
 * and the relay that hands those sockets to the Phone page over a localhost
 * WebSocket. The user's phone is an Android phone (2025), Android 15, reached over
 * Tailscale (100.64.0.1) — never a cable, never the open internet.
 *
 * CONTRACT (the single source of truth for phone.js, phone-page.js, and the
 * Settings → Phone section; change it here first, then everywhere)
 *
 *   create({ app, ipcMain, isChromeSender, isBundledPage, send })
 *     -> { stop(), describe() }
 *
 *   IPC (chrome only, gated by isChromeSender):
 *     'phone:describe'            -> state (below)
 *     'phone:command', name, arg  -> { ok: true, ... } | { ok: false, reason }
 *        names: 'install-tools'                 download adb + scrcpy-server (idempotent; re-verifies)
 *               'pair'      { host, port, code } one-time Wireless-debugging pairing (pairing port + 6 digits)
 *               'connect'   { host, port }       adb connect host:port (the connect port, or 5555 once pinned)
 *               'disconnect'                     adb disconnect; stream stops first
 *               'pin-tcpip'                      adb tcpip 5555 on the connected device (survives on cellular until reboot)
 *               'start'                          push + start the scrcpy server, open the sockets, relay
 *               'stop'                           stop the stream, keep the adb connection
 *               'set-settings' { ...partial }    any of settings.* below; persisted; a running stream restarts if quality changed
 *               'forget'                         drop stored host/port/pairing state (adb keys stay)
 *               'open-settings'                  ask the chrome to open Settings → Phone (send('phone:open-settings'))
 *   Push (chrome): send('phone:update', state) on every change (debounced ≤ 100 ms).
 *   Push (chrome): send('phone:open-settings') when the page asks for Settings.
 *
 *   state = {
 *     ready: boolean, reason: string,           // false + reason while unbuilt / tools missing / broken
 *     tools: { state: 'missing'|'downloading'|'ready'|'error', reason: string,
 *              dir: string, adbPath: string|null, serverPath: string|null,
 *              serverVersion: '4.1', adbVersion: string|null,
 *              progress: { item: 'adb'|'server'|'', received: number, total: number } ,
 *              sha: { adb: string|null, server: string|null, serverExpected: string } },
 *     device: { state: 'unpaired'|'pairing'|'paired'|'connecting'|'connected'|'unreachable'|'error',
 *               reason: string, host: string, port: number, serial: string|null,
 *               name: string|null, model: string|null, android: string|null,
 *               paired: boolean, tcpipPinned: boolean|null,      // null = unknown
 *               latencyMs: number|null, lastSeenAt: number,
 *                 // latencyMs is a TCP round trip to the phone's adb port (connect()
 *                 // -> 'connect', best of two), probed every few s while connected —
 *                 // NOT an `adb shell` round trip: spawning adb costs ~170 ms on a
 *                 // 7 ms LAN and that number made 'auto' pick Away for ever.
 *               battery: { level: number, charging: boolean } | null },
 *     stream: { state: 'off'|'starting'|'running'|'stalled'|'error', reason: string,
 *               codec: string|null, width: number, height: number, fps: number, kbps: number,
 *               profile: 'lan'|'away'|'auto', bitrate: number, maxSize: number, maxFps: number,
 *               audio: boolean, audioCodec: string|null, scid: string|null, since: number,
 *               lastVideoAt: number },
 *                 // lastVideoAt: epoch ms of the last video packet, 0 while off. A
 *                 // still phone screen sends NOTHING (scrcpy encodes only on change),
 *                 // so this is a quiet "still for N s" readout — never a fault.
 *                 // 'stalled' is NOT derived from video silence: it needs the scrcpy
 *                 // shell still alive AND > 15 s of silence AND the control socket
 *                 // dead (the device-message path), which is a real broken link.
 *     ws: { port: number, clients: number },
 *     settings: { host: string, port: number, pairPort: number, profile: 'lan'|'away'|'auto',
 *                 audio: boolean, lanBitrate: number, awayBitrate: number, maxSize: number,
 *                 maxFps: number, autoConnect: boolean, screenOffWhileMirroring: boolean }
 *   }
 *
 * THE PAGE SIDE (phone.html is a bundled, preload-less file:// guest like
 * newtab.html — it has no window.api, so it bootstraps on a console line, the
 * way stocks.js's guest hook works; see stocks.js:1060-1166 before adding a
 * console-message listener):
 *   1. The page prints `phone:hello`. phone.js answers every phone.html guest
 *      with contents.executeJavaScript('window.__applyPhone(' + JSON.stringify({ ws, state }) + ')')
 *      where ws = 'ws://127.0.0.1:<port>/?t=<token>' (token random per run,
 *      never persisted, never shown in the chrome). If nothing answers, the
 *      page says so itself ("the browser did not answer: phone.js not wired").
 *   2. Everything after that flows over the WebSocket (server: `ws` on
 *      127.0.0.1, ephemeral port, perMessageDeflate off, and ?t= must match.
 *      Origin must be absent, '' , 'null' or 'file://' — MEASURED, not
 *      guessed: an Electron 44 file:// guest sends `Origin: file://` on the
 *      upgrade, so a 'null'-only check refuses the real Phone page and the
 *      page can only report close code 1006. Anything else is refused and the
 *      refusal is named in state.reason.):
 *      TEXT frames are JSON:
 *        page -> main : { type: 'command', id, name, arg }        (same names as IPC)
 *                       { type: 'ping', t }
 *        main -> page : { type: 'result', id, ok, reason, ... }
 *                       { type: 'state', state }                   (every change, and once on connect)
 *                       { type: 'stream', channel: 0|1, codec, deviceName }  (before a channel's first packet)
 *                       { type: 'pong', t }
 *      BINARY frames: first byte = channel, rest = payload:
 *        0 video   main -> page : ONE scrcpy packet per frame, header verbatim.
 *                  A session packet is the 12-byte header alone (MSB of byte 0 set;
 *                  width u32 at 4..7, height u32 at 8..11; bit 0 of byte 3 is the
 *                  server's "client resized" flag — Streamer.writeSessionMeta).
 *                  A media packet is the 12-byte header (u64 BE ptsAndFlags: bit
 *                  62 = config, bit 61 = key frame; u32 BE size) followed by
 *                  exactly `size` payload bytes (H.264 Annex B — the config
 *                  packet is SPS/PPS). main splits the TCP stream on those
 *                  headers; it never parses the payload.
 *        1 audio   main -> page : same framing (no session packets). Codec from
 *                  the stream meta: 'opus' or 'raw'. NOTE (v4.1 Streamer.writeDisableStream):
 *                  the u32 in the codec-id slot may instead be 0 ("the phone could
 *                  not capture audio — carry on with video only") or 1 ("fatal
 *                  configuration error"); both arrive as { type: 'stream',
 *                  channel: 1, codec: null, reason } and no audio frames follow.
 *                  ('raw' is PCM s16le 48 kHz stereo per scrcpy's own docs;
 *                  AudioConfig.java is not among the pinned sources here, so the
 *                  page must not hard-code that without checking it — we ask for
 *                  opus by default.)
 *        2 device  main -> page : one complete DeviceMessage (control socket,
 *                  device -> client) verbatim: type u8, then per DeviceMessageWriter
 *                  (0 clipboard: u32 len + utf8; 1 ack clipboard: u64 seq;
 *                  2 uhid output: u16 id, u16 size, data).
 *        3 control page -> main : one complete ControlMessage verbatim; main
 *                  writes it to the control socket as-is and never parses it.
 *      Backpressure: a client whose bufferedAmount passes 4 MB stops receiving
 *      non-key video packets until the next key/config/session packet; the drop
 *      count is named in stream.reason. Nothing else is ever dropped.
 *      The pinned server is scrcpy v4.1 (sources for THAT tag are the only
 *      authority on the bytes: Streamer.java, DesktopConnection.java,
 *      ControlMessageReader(Test).java, DeviceMessageWriter(Test).java,
 *      Options.java). Never guess a byte from memory.
 *
 * HOW IT WORKS (and what can go wrong, because none of it may fail silently)
 *
 * TOOLS. Into <userData>/tools/: Google's platform-tools zip (adb.exe + its
 * two DLLs; the `latest` URL publishes no checksum, so sha.adb is the sha256
 * of the ZIP WE downloaded, persisted in phone.json because the zip is deleted
 * after unpacking — it is null when adb was already on disk from before) and
 * scrcpy-server-v4.1 from the GitHub release (sha256 MUST equal
 * deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae, from the
 * release's SHA256SUMS.txt; a mismatch is tools.state 'error' with the reason,
 * never a silent retry). Progress is state, not a log line. The download starts
 * on its own the first time a Phone page says hello; opening Settings only
 * describes, it never downloads.
 *
 * DEVICE. unpaired -> pairing (`adb pair host:pairPort code`) -> paired ->
 * connecting (`adb connect host:port`) -> connected -> (start) ... Wireless
 * debugging only runs while the phone is on SOME Wi-Fi and its connect port
 * changes every time it is toggled; `adb tcpip 5555` pins a fixed port that
 * phone.js sets after any successful connect on another port. MEASURED
 * 2026-09-13, correcting an earlier claim here: that pin holds on cellular and
 * across ordinary reconnects, but it is LOST whenever the phone changes Wi-Fi
 * network (and on reboot), because Wireless debugging restarts adbd on a fresh
 * random port — the old serial then shows up `offline` and 5555 answers
 * "actively refused". So: when the phone is listed offline, `adb disconnect`
 * before connecting (otherwise `adb connect` answers "already connected", a
 * lie); when 5555 is refused, ask `adb mdns services` where Wireless debugging
 * moved to, connect on that LAN ip:port, re-pin 5555 and reconnect on the
 * Tailscale address so it keeps working away from home; and if discovery finds
 * nothing, say in plain words that the port must be read off the phone. Every
 * adb call's stderr becomes the reason. All adb calls are serialised: one child
 * process at a time, each with its own timeout.
 *
 * STREAM. `adb push` the server to /data/local/tmp/scrcpy-server.jar (skipped
 * when the size already matches), then
 *   adb forward tcp:<free local port> localabstract:scrcpy_<scid>
 *   adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process /
 *     com.genymobile.scrcpy.Server 4.1 scid=<hex> tunnel_forward=true
 *     video=true video_codec=h264 audio=<true|false> audio_codec=<opus|raw>
 *     max_size=<n> max_fps=<n> video_bit_rate=<n> control=true cleanup=true
 *     log_level=info
 * (Options.parse: `scid` is read with Integer.parseInt(value, 16) — 8 lowercase
 * hex digits, no 0x, 31-bit — and the device socket is named scrcpy_%08x;
 * booleans are Boolean.parseBoolean, i.e. the literal "true"/"false"; `audio`
 * defaults to TRUE so turning audio off means passing audio=false; max_fps is a
 * float in 4.1.) Then three TCP connects in order (video, audio, control); the
 * first socket yields a dummy byte then a 64-byte NUL-padded device name; each
 * media socket then yields its u32 codec id. The version argument must equal
 * the jar's BuildConfig.VERSION_NAME ("4.1") or the server refuses — that
 * refusal is a visible reason too (the server's own stderr becomes it).
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');

/* `ws` is a dependency (package.json), but a missing/broken install must be a
   visible reason on the page, not a crash on require. */
let WebSocketServer = null;
let wsLoadError = '';
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch (err) {
  wsLoadError = (err && err.message) || 'the ws module failed to load';
}

/* --- constants, all of them checked against the pinned v4.1 sources ------ */

const SERVER_VERSION = '4.1';
const SERVER_SHA256 = 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae';
const SERVER_URL = 'https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1';
const SERVER_FILE = 'scrcpy-server-v4.1';
const PLATFORM_TOOLS_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';

/* Codec ids are the 4-byte ASCII of the name (VideoCodec.java / AudioCodec.java). */
const VIDEO_CODECS = { 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1', 0x00767038: 'vp8', 0x00767039: 'vp9' };
const AUDIO_CODECS = { 0x6f707573: 'opus', 0x00616163: 'aac', 0x666c6163: 'flac', 0x00726177: 'raw' };

/* Streamer.java: the three flag bits live in the top byte of the u64 header. */
const FLAG_SESSION = 0x80;
const FLAG_CONFIG = 0x40;
const FLAG_KEY_FRAME = 0x20;

const CH_VIDEO = 0;
const CH_AUDIO = 1;
const CH_DEVICE = 2;
const CH_CONTROL = 3;

/* DeviceMessage.java */
const DEV_CLIPBOARD = 0;
const DEV_ACK_CLIPBOARD = 1;
const DEV_UHID_OUTPUT = 2;

/* ControlMessage.java: type 10 = SET_DISPLAY_POWER, then one boolean byte. */
const CTRL_SET_DISPLAY_POWER = 10;
/* ControlMessage.java: type 17 = RESET_VIDEO, and ControlMessageReader.java:49
   makes it with createEmpty(type) — the byte on its own, no payload. It asks the
   encoder for a new key frame, which is the only way out of a frozen picture
   before scrcpy's own key-frame interval (up to 10 s) comes round. */
const CTRL_RESET_VIDEO = 17;

const PUSH_MS = 100;          // state push debounce (the contract's ceiling)
const PROBE_MS = 5000;        // latency + `adb devices` tick while connected
const BATTERY_EVERY = 6;      // ... and the battery every 6th tick (30 s)
const STILL_NOTE_MS = 2000;   // quiet "still for N s" readout (NOT a fault)
const STALL_MS = 15000;       // silence this long is *necessary* for 'stalled'…
                              // …and never sufficient on its own: see stallCheck()
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const KEY_REQUEST_MS = 500;   // at most one RESET_VIDEO per this, across all clients
const AWAY_LATENCY_MS = 60;   // profile 'auto' picks 'away' above this
const AUTO_SWITCH_TICKS = 3;  // …after this many probes agree, mid-stream
const RTT_TIMEOUT_MS = 2500;  // one TCP round-trip probe's own ceiling

/* What the page must say when the phone has changed Wi-Fi network, 5555 is
   refused and adb's mDNS discovery found nothing: there is genuinely nothing
   left but reading the new port off the phone. Word for word, because it is the
   only instruction that gets the mirror back. */
const NEW_PORT_MESSAGE = 'Wireless debugging is on a new port since the phone changed networks'
  + " — read the port on the phone's Wireless debugging screen and press Connect"
  + ' (the 5555 pin is lost whenever the phone changes Wi-Fi)';

/* --- pure helpers, shared with the harness ------------------------------ */

/**
 * Split a media socket's byte stream into whole scrcpy packets. Returns the
 * bytes that are left over (an incomplete packet); calls emit(packet, info)
 * once per complete packet, where `packet` is the 12-byte header plus its
 * payload, verbatim, and `info` says what kind it is. Throws only on a frame
 * that cannot be a scrcpy packet at all — which is a visible stream error.
 */
function parseMediaPackets(buf, isVideo, emit) {
  let at = 0;
  while (buf.length - at >= 12) {
    const flags = buf[at];
    if (flags & FLAG_SESSION) {
      /* A session packet is the 12-byte header on its own: flags u32 (MSB set,
         bit 0 = the server resized for the client), width u32, height u32. */
      if (!isVideo) throw new Error('a session packet arrived on the audio socket');
      const packet = buf.subarray(at, at + 12);
      emit(packet, { session: true, width: packet.readUInt32BE(4), height: packet.readUInt32BE(8) });
      at += 12;
      continue;
    }
    const size = buf.readUInt32BE(at + 8);
    if (size > 64 * 1024 * 1024) throw new Error('absurd packet size ' + size + ' — the stream is out of sync');
    if (buf.length - at < 12 + size) break;
    const packet = buf.subarray(at, at + 12 + size);
    emit(packet, {
      session: false,
      config: (flags & FLAG_CONFIG) !== 0,
      key: (flags & FLAG_KEY_FRAME) !== 0,
      size
    });
    at += 12 + size;
  }
  return at === 0 ? buf : buf.subarray(at);
}

/**
 * Split the control socket's device -> client stream into whole DeviceMessages
 * (DeviceMessageWriter.java). Same shape as above.
 */
function parseDeviceMessages(buf, emit) {
  let at = 0;
  for (;;) {
    const left = buf.length - at;
    if (left < 1) break;
    const type = buf[at];
    let length = 0;
    if (type === DEV_CLIPBOARD) {
      if (left < 5) break;
      length = 5 + buf.readUInt32BE(at + 1);
    } else if (type === DEV_ACK_CLIPBOARD) {
      length = 9;
    } else if (type === DEV_UHID_OUTPUT) {
      if (left < 5) break;
      length = 5 + buf.readUInt16BE(at + 3);
    } else {
      throw new Error('unknown device message type ' + type);
    }
    if (left < length) break;
    emit(buf.subarray(at, at + length), { type });
    at += length;
  }
  return at === 0 ? buf : buf.subarray(at);
}

function msgOf(err) {
  if (!err) return 'failed';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function human(bytes) {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' kB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, low, high, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, n));
}

/**
 * How long the phone's adb port takes to answer a TCP handshake: connect() to
 * the 'connect' event, then the socket is destroyed at once. This is the real
 * network round trip. `adb -s … shell echo 1` is NOT: it spawns a process, talks
 * to the local adb server and starts a shell on the phone, which measured
 * 166-195 ms over a 7 ms LAN — enough to make profile 'auto' choose the Away
 * bitrate for ever, which is exactly what happened on the first live run.
 * Resolves { ms, reason }: ms is null when it did not answer, and reason then
 * says why in plain words.
 */
function tcpRoundTrip(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const socket = new net.Socket();
    const started = process.hrtime.bigint();
    const finish = (ms, reason) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve({ ms, reason });
    };
    socket.setTimeout(timeoutMs, () => finish(null, 'no answer within ' + timeoutMs + ' ms'));
    socket.once('connect', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      finish(Math.round(ms * 10) / 10, '');
    });
    socket.once('error', (err) => finish(null, msgOf(err)));
    try { socket.connect(port, host); } catch (err) { finish(null, msgOf(err)); }
  });
}

/**
 * Parse `adb mdns services`. adb prints a header line and then one line per
 * service: `<instance>\t_adb-tls-connect._tcp\t<ip>:<port>` (the pairing
 * service `_adb-tls-pairing._tcp` is a different thing and is ignored here).
 * Anything that is not such a line — including Windows adb's "mdns daemon
 * unavailable", or nothing at all — yields an empty list, never a throw.
 */
function parseMdnsServices(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.indexOf('_adb-tls-connect._tcp') < 0) continue;
    const addr = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?!\d)/.exec(line);
    if (!addr) continue;
    const octets = addr[1].split('.').map(Number);
    if (octets.some((n) => n > 255)) continue;
    const port = Number(addr[2]);
    if (!(port >= 1 && port <= 65535)) continue;
    const instance = (line.split(/\s+/)[0] || '').replace(/\.?_adb-tls-connect\._tcp\.?$/, '');
    out.push({ instance, host: addr[1], port });
  }
  return out;
}

/**
 * Profile 'auto', decided again on every probe while the stream runs: the tier
 * the measured latency asks for, and whether it has asked long enough (three
 * probes in a row) to be worth restarting the stream for. Pure, so the harness
 * can walk it tick by tick.
 */
function autoDecision(latencyMs, currentTier, crossings) {
  if (latencyMs == null || !Number.isFinite(latencyMs)) return { tier: currentTier, crossings: 0, restart: false };
  const wanted = latencyMs > AWAY_LATENCY_MS ? 'away' : 'lan';
  if (wanted === currentTier) return { tier: wanted, crossings: 0, restart: false };
  const next = crossings + 1;
  return { tier: wanted, crossings: next >= AUTO_SWITCH_TICKS ? 0 : next, restart: next >= AUTO_SWITCH_TICKS };
}

/**
 * Electron has changed console-message's shape: ≥36 emits one details object,
 * older builds emit (event, level, message, …). Both are read, so the module
 * does not break on an Electron bump in either direction. (Copied from
 * stocks.js:1060-1075 — Electron 44 deprecation-warns on any console-message
 * listener declared with more than one parameter, hence `arguments`.)
 */
function messageOf(first, args) {
  if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
  if (typeof args[2] === 'string') return args[2];
  if (typeof args[1] === 'string') return args[1];
  return '';
}

/* --- the module ---------------------------------------------------------- */

function create(deps) {
  const d = deps || {};
  const electronApp = d.app || null;
  const ipcMain = d.ipcMain || null;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const isBundledPage = typeof d.isBundledPage === 'function' ? d.isBundledPage : () => false;
  const sendToChrome = typeof d.send === 'function' ? d.send : () => {};

  const state = {
    ready: false,
    reason: 'starting up',
    tools: {
      state: 'missing',
      reason: 'adb and the scrcpy server are not downloaded yet',
      dir: '',
      adbPath: null,
      serverPath: null,
      serverVersion: SERVER_VERSION,
      adbVersion: null,
      progress: { item: '', received: 0, total: 0 },
      sha: { adb: null, server: null, serverExpected: SERVER_SHA256 }
    },
    device: {
      state: 'unpaired',
      reason: 'not paired: Settings → Phone',
      host: '100.64.0.1',
      port: 5555,
      serial: null,
      name: null,
      model: null,
      android: null,
      paired: false,
      tcpipPinned: null,
      latencyMs: null,
      lastSeenAt: 0,
      battery: null
    },
    stream: {
      state: 'off',
      reason: 'not started',
      codec: null,
      width: 0,
      height: 0,
      fps: 0,
      kbps: 0,
      profile: 'auto',
      bitrate: 0,
      maxSize: 1280,
      maxFps: 60,
      audio: true,
      audioCodec: null,
      scid: null,
      since: 0,
      /* Epoch ms of the last video packet (0 while off). A still phone screen is
         silent for minutes on purpose, so this is a readout, never a fault. */
      lastVideoAt: 0
    },
    ws: { port: 0, clients: 0 },
    settings: {
      host: '100.64.0.1',
      port: 5555,
      pairPort: 0,
      profile: 'auto',
      audio: true,
      lanBitrate: 8000000,
      awayBitrate: 2000000,
      maxSize: 1280,
      maxFps: 60,
      autoConnect: true,
      screenOffWhileMirroring: false
    }
  };

  /* Everything the stream owns while it runs, in one bag so stopStream() can
     be sure it left nothing behind. */
  let live = null;

  const guests = new Set();       // live phone.html <webview> WebContents
  const clients = new Set();      // ws clients, each { ws, dropping, drops }
  let wss = null;
  let wsStarting = null;
  /* Why the last relay handshake was refused. A browser only shows the page
     close code 1006, so this is the only place that can say what happened;
     cleared the moment a client does get in. */
  let relayNote = '';
  const token = crypto.randomBytes(24).toString('hex');

  let adbChain = Promise.resolve();
  let adbServerStarted = false;
  let installing = null;
  let installingVerifyOnly = false;
  let probeTimer = null;
  let probeTick = 0;
  let reconnectTimer = null;
  let reconnectTries = 0;
  let autoBusy = false;
  let stopped = false;
  /* profile 'auto', re-decided live: how many probes in a row have asked for
     the other bitrate, and whether a restart for it is already under way. */
  let autoCrossings = 0;
  let autoSwitching = false;
  /* TEST HOOK ONLY (set through _test.setAdbRunner): when set, every adb call
     goes here instead of spawning adb.exe. Nothing in the app ever sets it. */
  let adbRunner = null;

  function log() {
    const parts = ['[phone]'];
    for (let i = 0; i < arguments.length; i += 1) parts.push(arguments[i]);
    try { console.log.apply(console, parts); } catch { /* no console in a packaged build */ }
  }

  /* --- persistence ------------------------------------------------------ */

  function storePath() {
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return path.join(electronApp.getPath('userData'), 'phone.json'); } catch { return ''; }
  }

  function loadStore() {
    const file = storePath();
    if (!file) return;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.settings && typeof parsed.settings === 'object') {
      Object.assign(state.settings, sanitiseSettings(parsed.settings, state.settings));
    }
    state.device.host = state.settings.host;
    state.device.port = state.settings.port;
    if (typeof parsed.adbSha === 'string') state.tools.sha.adb = parsed.adbSha;
    state.device.paired = parsed.paired === true;
    state.device.tcpipPinned = typeof parsed.tcpipPinned === 'boolean' ? parsed.tcpipPinned : null;
    state.stream.profile = state.settings.profile;
    state.stream.audio = state.settings.audio;
    state.stream.maxSize = state.settings.maxSize;
    state.stream.maxFps = state.settings.maxFps;
    if (state.device.paired) {
      state.device.state = 'paired';
      state.device.reason = 'paired; not connected yet';
    }
  }

  function saveStore() {
    const file = storePath();
    if (!file) return;
    const body = JSON.stringify({
      settings: state.settings,
      paired: state.device.paired,
      tcpipPinned: state.device.tcpipPinned,
      adbSha: state.tools.sha.adb
    }, null, 2);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
    } catch (err) {
      /* Not fatal, but it must not be silent: the next launch will have
         forgotten the phone and the reason says why. */
      state.device.reason = 'could not save phone.json: ' + msgOf(err);
      log('store save failed:', msgOf(err));
    }
  }

  function sanitiseSettings(raw, base) {
    const out = Object.assign({}, base);
    if (typeof raw.host === 'string' && raw.host.trim()) out.host = raw.host.trim();
    if (raw.port != null) out.port = clampInt(raw.port, 1, 65535, base.port);
    if (raw.pairPort != null) out.pairPort = clampInt(raw.pairPort, 0, 65535, base.pairPort);
    if (raw.profile === 'lan' || raw.profile === 'away' || raw.profile === 'auto') out.profile = raw.profile;
    if (typeof raw.audio === 'boolean') out.audio = raw.audio;
    if (raw.lanBitrate != null) out.lanBitrate = clampInt(raw.lanBitrate, 200000, 50000000, base.lanBitrate);
    if (raw.awayBitrate != null) out.awayBitrate = clampInt(raw.awayBitrate, 200000, 50000000, base.awayBitrate);
    if (raw.maxSize != null) out.maxSize = clampInt(raw.maxSize, 0, 4096, base.maxSize);
    if (raw.maxFps != null) out.maxFps = clampInt(raw.maxFps, 1, 120, base.maxFps);
    if (typeof raw.autoConnect === 'boolean') out.autoConnect = raw.autoConnect;
    if (typeof raw.screenOffWhileMirroring === 'boolean') out.screenOffWhileMirroring = raw.screenOffWhileMirroring;
    return out;
  }

  /* --- the one sentence the whole UI leans on --------------------------- */

  /**
   * `ready` is tools + device; `reason` always names the NEXT thing that has to
   * happen, in the user's words, never a code. Recomputed on every push.
   */
  function refreshReady() {
    state.ready = state.tools.state === 'ready' && state.device.state === 'connected';
    if (relayNote) { state.reason = relayNote; return; }
    if (wsLoadError) {
      state.reason = 'the ws module did not load (' + wsLoadError + ') — run npm install in the browser folder';
      return;
    }
    if (state.tools.state === 'downloading') {
      const p = state.tools.progress;
      const what = p.item === 'adb' ? 'adb' : 'the scrcpy server';
      state.reason = p.total
        ? 'downloading ' + what + ', ' + human(p.received) + ' of ' + human(p.total)
        : 'downloading ' + what + ', ' + human(p.received);
      return;
    }
    if (state.tools.state === 'error') { state.reason = state.tools.reason; return; }
    if (state.tools.state !== 'ready') { state.reason = state.tools.reason; return; }
    if (!state.device.paired) {
      state.reason = 'not paired: Settings → Phone, then Wireless debugging → Pair device with pairing code';
      return;
    }
    if (state.device.state === 'unreachable') {
      /* device.reason is the specific one (which port was refused, what mDNS
         found, what to do about it); only fall back to the general line. */
      state.reason = state.device.reason
        || ('phone unreachable at ' + state.device.host + ':' + state.device.port
          + ' — is Tailscale on, and Wireless debugging still enabled?');
      return;
    }
    if (state.device.state === 'error') { state.reason = state.device.reason; return; }
    if (state.device.state !== 'connected') { state.reason = state.device.reason; return; }
    if (state.device.tcpipPinned === false) {
      state.reason = 'adb not pinned on cellular: press Pin port 5555 so the phone keeps working off Wi-Fi';
      return;
    }
    if (state.stream.state === 'running') { state.reason = state.stream.reason || 'mirroring'; return; }
    if (state.stream.state === 'error' || state.stream.state === 'stalled') { state.reason = state.stream.reason; return; }
    state.reason = state.stream.state === 'starting' ? state.stream.reason : 'connected; press Start to mirror';
  }

  let pushTimer = null;
  function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushNow();
    }, PUSH_MS);
  }

  function pushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    refreshReady();
    try { sendToChrome('phone:update', state); } catch { /* the chrome went away */ }
    const text = safeJson({ type: 'state', state });
    if (text) for (const c of clients) sendText(c, text);
  }

  function safeJson(value) {
    try { return JSON.stringify(value); } catch { return ''; }
  }

  /* --- adb: one child at a time, every one with a timeout --------------- */

  function runAdb(args, timeoutMs) {
    if (adbRunner) {
      /* TEST HOOK: a stub stands in for adb.exe so the harness can assert the
         exact argv order (disconnect before connect) without a phone. */
      return Promise.resolve(adbRunner(args, timeoutMs)).then(
        (res) => Object.assign({ ok: false, out: '', err: '', code: -1, ms: 0 }, res || {}),
        (err) => ({ ok: false, out: '', err: msgOf(err), code: -1, ms: 0 })
      );
    }
    return new Promise((resolve) => {
      const adbPath = state.tools.adbPath;
      if (!adbPath) {
        resolve({ ok: false, out: '', err: 'adb is not downloaded yet', code: -1, ms: 0 });
        return;
      }
      const started = Date.now();
      let child = null;
      try {
        child = spawn(adbPath, args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, out: '', err: msgOf(err), code: -1, ms: 0 });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({
          ok: false,
          out: out.trim(),
          err: (err.trim() || ('adb ' + args.join(' ') + ' did not answer')) + ' (timed out after ' + Math.round(timeoutMs / 1000) + ' s)',
          code: -1,
          ms: Date.now() - started,
          timedOut: true
        });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 64000) out = out.slice(-64000); });
      child.stderr.on('data', (chunk) => { err += chunk; if (err.length > 64000) err = err.slice(-64000); });
      child.on('error', (e) => finish({ ok: false, out: out.trim(), err: msgOf(e), code: -1, ms: Date.now() - started }));
      child.on('close', (code) => finish({
        ok: code === 0,
        out: out.trim(),
        err: err.trim(),
        code,
        ms: Date.now() - started
      }));
    });
  }

  /** Every adb call goes through here, so two of them never race the server. */
  function adb(args, timeoutMs) {
    const run = () => runAdb(args, timeoutMs || 15000);
    const next = adbChain.then(run, run);
    adbChain = next.then(() => {}, () => {});
    return next;
  }

  /** The reason text a failed adb call leaves behind. */
  function adbReason(res, fallback) {
    const text = (res && (res.err || res.out) || '').split('\n').map((s) => s.trim()).filter(Boolean).pop();
    return text || fallback;
  }

  async function ensureAdbServer() {
    if (adbServerStarted || !state.tools.adbPath) return;
    adbServerStarted = true;
    const res = await adb(['start-server'], 20000);
    if (!res.ok) {
      state.device.reason = 'adb server would not start: ' + adbReason(res, 'unknown error');
      push();
    }
  }

  /* --- tools: download, verify, unpack ---------------------------------- */

  function toolsDir() {
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return path.join(electronApp.getPath('userData'), 'tools'); } catch { return ''; }
  }

  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('error', reject);
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * GET with the redirect GitHub always answers with, hashing as it goes and
   * writing progress into state (never a log line only). Resolves the sha256.
   */
  function download(url, destPath, item, hops) {
    const at = hops || 0;
    return new Promise((resolve, reject) => {
      if (at > 5) { reject(new Error('too many redirects')); return; }
      const req = https.get(url, { headers: { 'user-agent': 'browser-phone/1.0', accept: '*/*' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          let next = '';
          try { next = new URL(res.headers.location, url).href; } catch { next = ''; }
          if (!next) { reject(new Error('a redirect with no location')); return; }
          resolve(download(next, destPath, item, at + 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          let host = url;
          try { host = new URL(url).host; } catch { /* keep the url */ }
          reject(new Error('HTTP ' + code + ' from ' + host));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        state.tools.progress = { item, received: 0, total };
        push();
        const hash = crypto.createHash('sha256');
        const part = destPath + '.part';
        let out = null;
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          out = fs.createWriteStream(part);
        } catch (err) { res.destroy(); reject(err); return; }
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          state.tools.progress = { item, received, total };
          push();
        });
        res.on('error', (err) => { try { out.destroy(); } catch { /* ignore */ } reject(err); });
        out.on('error', (err) => { res.destroy(); reject(err); });
        out.on('finish', () => {
          try {
            fs.rmSync(destPath, { force: true });
            fs.renameSync(part, destPath);
          } catch (err) { reject(err); return; }
          resolve(hash.digest('hex'));
        });
        res.pipe(out);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('the download stalled for 60 s')));
    });
  }

  function psQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  /** Unzip with PowerShell's Expand-Archive — no window, no GUI, no shell. */
  function expandArchive(zipFile, intoDir) {
    return new Promise((resolve, reject) => {
      const command = 'Expand-Archive -LiteralPath ' + psQuote(zipFile) + ' -DestinationPath ' + psQuote(intoDir) + ' -Force';
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || stdout || '').trim().split('\n')[0] || msgOf(err);
            reject(new Error('could not unzip platform-tools: ' + detail));
            return;
          }
          resolve();
        }
      );
    });
  }

  function toolsError(reason) {
    state.tools.state = 'error';
    state.tools.reason = reason;
    state.tools.progress = { item: '', received: 0, total: 0 };
    pushNow();
    return { ok: false, reason };
  }

  /**
   * Idempotent: an existing file is re-hashed rather than re-downloaded, and a
   * bad scrcpy server is deleted rather than kept. `verifyOnly` is the startup
   * pass: it touches the network never, so merely opening Settings (or booting
   * the browser) cannot start an 8 MB download behind the user's back.
   */
  async function installTools(opts) {
    const verifyOnly = !!(opts && opts.verifyOnly);
    if (installing) {
      /* A hello that lands during the startup verify must still get its
         download: queue the real run behind the verify rather than swallow it. */
      if (!verifyOnly && installingVerifyOnly) return installing.then(() => installTools(opts));
      return installing;
    }
    installingVerifyOnly = verifyOnly;
    installing = (async () => {
      const dir = toolsDir();
      if (!dir) return toolsError('there is no userData folder to download into');
      state.tools.dir = dir;
      state.tools.state = 'downloading';
      state.tools.reason = 'checking what is already here';
      pushNow();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { return toolsError('could not make ' + dir + ': ' + msgOf(err)); }

      /* --- the scrcpy server, sha-pinned --- */
      const serverPath = path.join(dir, SERVER_FILE);
      let serverSha = '';
      if (fs.existsSync(serverPath)) {
        try { serverSha = await sha256File(serverPath); } catch { serverSha = ''; }
      }
      if (serverSha !== SERVER_SHA256) {
        if (verifyOnly) {
          return toolsError(serverSha
            ? 'the scrcpy server on disk is not the pinned ' + SERVER_VERSION + ' build — press Download tools to fetch it again'
            : 'the scrcpy server has not been downloaded yet — press Download tools');
        }
        state.tools.reason = 'downloading the scrcpy ' + SERVER_VERSION + ' server';
        pushNow();
        try {
          serverSha = await download(SERVER_URL, serverPath, 'server', 0);
        } catch (err) {
          return toolsError('the scrcpy server download failed: ' + msgOf(err));
        }
        if (serverSha !== SERVER_SHA256) {
          try { fs.rmSync(serverPath, { force: true }); } catch { /* best effort */ }
          return toolsError('the scrcpy server did not match its published sha256 (' + serverSha.slice(0, 16)
            + '… instead of ' + SERVER_SHA256.slice(0, 16) + '…) — the file was deleted, nothing was run');
        }
      }
      state.tools.sha.server = serverSha;
      state.tools.serverPath = serverPath;

      /* --- platform-tools (adb.exe + its two DLLs) --- */
      const adbPath = path.join(dir, 'platform-tools', 'adb.exe');
      const dll1 = path.join(dir, 'platform-tools', 'AdbWinApi.dll');
      const dll2 = path.join(dir, 'platform-tools', 'AdbWinUsbApi.dll');
      if (!(fs.existsSync(adbPath) && fs.existsSync(dll1) && fs.existsSync(dll2))) {
        if (verifyOnly) return toolsError('adb has not been downloaded yet — press Download tools');
        const zipPath = path.join(dir, 'platform-tools.zip');
        state.tools.reason = 'downloading Google platform-tools (adb)';
        pushNow();
        let adbSha = '';
        try {
          adbSha = await download(PLATFORM_TOOLS_URL, zipPath, 'adb', 0);
        } catch (err) {
          return toolsError('the platform-tools download failed: ' + msgOf(err));
        }
        /* The `latest` alias publishes no sha, so this is the one WE saw, of
           the zip we actually unpacked. It is persisted because the zip is
           deleted afterwards and could never be re-hashed. */
        state.tools.sha.adb = adbSha;
        saveStore();
        state.tools.reason = 'unpacking adb';
        state.tools.progress = { item: 'adb', received: 0, total: 0 };
        pushNow();
        try {
          await expandArchive(zipPath, dir);
        } catch (err) {
          return toolsError(msgOf(err));
        }
        try { fs.rmSync(zipPath, { force: true }); } catch { /* leaving it is harmless */ }
        const missing = [adbPath, dll1, dll2].filter((f) => !fs.existsSync(f)).map((f) => path.basename(f));
        if (missing.length) {
          return toolsError('the platform-tools zip did not contain ' + missing.join(', ') + ' — Google changed its layout');
        }
      }
      state.tools.adbPath = adbPath;

      /* --- prove adb actually runs --- */
      state.tools.progress = { item: '', received: 0, total: 0 };
      state.tools.reason = 'asking adb for its version';
      pushNow();
      const version = await adb(['version'], 20000);
      if (!version.ok) {
        state.tools.adbPath = null;
        return toolsError('adb would not run: ' + adbReason(version, 'no output'));
      }
      state.tools.adbVersion = (version.out.split('\n')[0] || '').trim();
      state.tools.state = 'ready';
      state.tools.reason = 'adb ' + (state.tools.adbVersion || 'ready') + ' + scrcpy server ' + SERVER_VERSION;
      pushNow();
      /* The adb DAEMON is started lazily, by the first device command — a
         browser whose Phone tab is never opened leaves no adb running. */
      return { ok: true, reason: state.tools.reason };
    })().catch((err) => toolsError('the tools step failed: ' + msgOf(err)))
      .then((res) => { installing = null; return res; });
    return installing;
  }

  /* --- device ----------------------------------------------------------- */

  function requireTools() {
    if (state.tools.state === 'ready' && state.tools.adbPath) return '';
    if (state.tools.state === 'downloading') return 'the tools are still downloading';
    return 'adb is not downloaded yet — press Download tools';
  }

  async function pair(arg) {
    const blocked = requireTools();
    if (blocked) return { ok: false, reason: blocked };
    const a = arg || {};
    const host = String(a.host || state.settings.host || '').trim();
    const port = clampInt(a.port, 1, 65535, 0);
    const code = String(a.code || '').replace(/\D/g, '');
    if (!host) return { ok: false, reason: 'no address: the phone shows it under Wireless debugging → Pair device with pairing code' };
    if (!port) return { ok: false, reason: 'no pairing port: it is the number after the colon on the phone, and it is NOT the connect port' };
    if (code.length !== 6) return { ok: false, reason: 'the pairing code is the 6 digits on the phone' };
    state.device.state = 'pairing';
    state.device.reason = 'pairing with ' + host + ':' + port + '…';
    pushNow();
    await ensureAdbServer();
    const res = await adb(['pair', host + ':' + port, code], 30000);
    const text = (res.out + '\n' + res.err).toLowerCase();
    if (text.includes('successfully paired')) {
      state.device.paired = true;
      state.device.state = 'paired';
      state.device.host = host;
      state.settings.host = host;
      state.settings.pairPort = port;
      state.device.reason = 'paired — now connect (the connect port is the OTHER number, on the Wireless debugging screen itself)';
      saveStore();
      pushNow();
      return { ok: true, reason: state.device.reason };
    }
    state.device.state = state.device.paired ? 'paired' : 'unpaired';
    state.device.reason = 'pairing failed: ' + adbReason(res, 'the phone did not answer — check the address, the port and the 6 digits, and that the pairing dialog is still open');
    pushNow();
    return { ok: false, reason: state.device.reason };
  }

  async function readDeviceInfo(serial) {
    const model = await adb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], 10000);
    if (model.ok && model.out) state.device.model = model.out.trim();
    const release = await adb(['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], 10000);
    if (release.ok && release.out) state.device.android = release.out.trim();
    const maker = await adb(['-s', serial, 'shell', 'getprop', 'ro.product.manufacturer'], 10000);
    const parts = [];
    if (maker.ok && maker.out) parts.push(maker.out.trim());
    if (state.device.model) parts.push(state.device.model);
    state.device.name = parts.join(' ').trim() || null;
  }

  /**
   * What `adb devices -l` says about one serial: '' when it is not listed at
   * all, otherwise the state word ('device', 'offline', 'unauthorized'…).
   */
  async function deviceListWord(serial) {
    const list = await adb(['devices', '-l'], 10000);
    if (!list.ok) return '';
    const line = String(list.out || '').split('\n').map((s) => s.trim())
      .find((s) => s === serial || s.startsWith(serial + ' ') || s.startsWith(serial + '\t'));
    if (!line) return '';
    return line.slice(serial.length).trim().split(/\s+/)[0] || '';
  }

  /**
   * Wireless debugging restarts adbd on a NEW random port whenever the phone
   * changes Wi-Fi network, and the `adb tcpip 5555` pin does not survive it
   * (MEASURED 2026-09-13: the serial went `offline`, and 5555 answered
   * "actively refused (10061)"). `adb mdns services` is the only way to find the
   * new port without reading it off the phone — and on Windows adb's mDNS may
   * simply answer "mdns daemon unavailable", which is "no discovery", never a
   * crash. When it does find the phone we connect on that LAN address, re-pin
   * 5555 and move back to the Tailscale address, so it still works away from
   * home. Every step is narrated in device.reason as it happens.
   */
  async function recoverByDiscovery(preferredHost, firstReason) {
    state.device.reason = firstReason + ' — asking adb where Wireless debugging moved to (mDNS)…';
    pushNow();
    const res = await adb(['mdns', 'services'], 12000);
    const text = String(res.out || '') + '\n' + String(res.err || '');
    const found = parseMdnsServices(text);
    if (!found.length) {
      const why = (!res.ok || /unavailable/i.test(text))
        ? 'adb’s own mDNS discovery is not working here (' + adbReason(res, 'no answer') + ')'
        : 'mDNS found nothing advertising Wireless debugging on this network';
      state.device.tcpipPinned = false;
      saveStore();
      return { ok: false, reason: NEW_PORT_MESSAGE + ' — ' + why };
    }

    const hit = found[0];
    const lanSerial = hit.host + ':' + hit.port;
    const others = found.length > 1 ? ' (' + (found.length - 1) + ' more advertised; trying this one)' : '';
    state.device.reason = 'mDNS found a phone at ' + lanSerial + others
      + ' — Wireless debugging moved, connecting there…';
    pushNow();
    const again = await adb(['connect', lanSerial], 30000);
    const againText = (String(again.out || '') + '\n' + String(again.err || '')).toLowerCase();
    if (!againText.includes('connected to') || againText.includes('cannot connect') || againText.includes('failed')) {
      state.device.tcpipPinned = false;
      saveStore();
      return {
        ok: false,
        reason: 'mDNS said the phone is at ' + lanSerial + ', but connecting there failed: '
          + adbReason(again, 'no answer') + ' — ' + NEW_PORT_MESSAGE
      };
    }

    state.device.state = 'connected';
    state.device.serial = lanSerial;
    state.device.port = hit.port;
    state.device.host = preferredHost;   // pinTcpip reconnects HERE, not on the LAN address
    state.device.paired = true;
    state.device.lastSeenAt = Date.now();
    reconnectTries = 0;
    state.device.reason = 'reconnected by mDNS at ' + lanSerial + ' — pinning port 5555 again…';
    pushNow();
    await readDeviceInfo(lanSerial);
    const pin = await pinTcpip();
    if (pin.ok) {
      state.device.reason = 'found again by mDNS at ' + lanSerial + ' and re-pinned 5555 at '
        + preferredHost + ' — Wireless debugging had moved to a new port when the phone changed network';
      saveStore();
      startProbing();
      pushNow();
      return { ok: true, reason: state.device.reason };
    }
    /* Connected, but only on this LAN address: it will change again the next
       time the phone changes network, and it is no use away from home. */
    state.device.host = hit.host;
    state.device.tcpipPinned = false;
    state.device.reason = 'reconnected by mDNS at ' + lanSerial + ', but pinning 5555 failed: ' + pin.reason
      + ' — this port changes again whenever the phone changes network, and it will not work away from home';
    saveStore();
    startProbing();
    pushNow();
    return { ok: true, reason: state.device.reason };
  }

  async function connect(arg) {
    const blocked = requireTools();
    if (blocked) return { ok: false, reason: blocked };
    const a = arg || {};
    const host = String(a.host || state.settings.host || '').trim();
    const port = clampInt(a.port, 1, 65535, state.settings.port);
    if (!host) return { ok: false, reason: 'no address — Settings → Phone' };
    stopReconnect();
    state.device.state = 'connecting';
    state.device.host = host;
    state.device.port = port;
    state.device.reason = 'connecting to ' + host + ':' + port + '…';
    pushNow();
    await ensureAdbServer();
    const serial = host + ':' + port;

    /* An entry adb still lists as `offline` — what a Wi-Fi change leaves behind —
       answers `adb connect` with "already connected", which is a lie: it never
       reconnects (MEASURED 2026-09-13). Drop the stale entry first, and say so. */
    const stale = await deviceListWord(serial);
    if (stale && stale !== 'device') {
      state.device.reason = 'adb still lists ' + serial + ' as ' + stale
        + ' — dropping that stale entry before reconnecting…';
      pushNow();
      await adb(['disconnect', serial], 15000);
    }

    const res = await adb(['connect', serial], 30000);
    const text = (res.out + '\n' + res.err).toLowerCase();
    let good = text.includes('connected to') && !text.includes('cannot connect') && !text.includes('failed');
    if (good) {
      /* …and "already connected" can be a lie even so: believe the device list. */
      const word = await deviceListWord(serial);
      if (word && word !== 'device') {
        good = false;
        await adb(['disconnect', serial], 15000);
        res.err = (res.err ? res.err + '; ' : '') + 'adb answered "' + String(res.out || '').trim()
          + '" but still lists the phone as ' + word;
      }
    }
    if (!good) {
      const firstReason = 'could not connect to ' + serial + ': '
        + adbReason(res, 'no answer — is Tailscale on, is Wireless debugging still enabled, and is this still the right port?');
      /* The Wi-Fi-change case: adbd restarted on a new random port. Ask adb's own
         mDNS discovery where it went before giving up. */
      const recovered = await recoverByDiscovery(host, firstReason);
      if (recovered.ok) return recovered;
      state.device.state = 'unreachable';
      state.device.serial = null;
      state.device.reason = recovered.reason;
      pushNow();
      scheduleReconnect();
      return { ok: false, reason: state.device.reason };
    }
    state.device.state = 'connected';
    state.device.serial = serial;
    state.device.paired = true;
    state.device.lastSeenAt = Date.now();
    state.device.reason = text.includes('already connected') ? 'already connected' : 'connected';
    state.settings.host = host;
    state.settings.port = port;
    reconnectTries = 0;
    saveStore();
    pushNow();
    await readDeviceInfo(serial);
    startProbing();
    pushNow();
    /* A port other than 5555 is a Wireless-debugging port: it changes every
       time the phone toggles the switch, so pin it right away and say so. */
    if (port !== 5555) {
      state.device.reason = 'connected on ' + port + ' — pinning port 5555 so it survives a toggle and works on cellular…';
      pushNow();
      const pin = await pinTcpip();
      state.device.reason = pin.ok
        ? 'connected on 5555 (pinned automatically — it had connected on ' + port + ', which changes every toggle)'
        : 'connected on ' + port + ', but pinning 5555 failed: ' + pin.reason + ' — this port will change when Wireless debugging is toggled';
      pushNow();
    } else if (state.device.tcpipPinned === null) {
      state.device.tcpipPinned = true;  // it answered on 5555, so it is pinned
      saveStore();
    }
    return { ok: true, reason: state.device.reason };
  }

  async function disconnect() {
    await stopStream('the phone was disconnected');
    stopProbing();
    stopReconnect();
    const serial = state.device.serial;
    if (serial) await adb(['disconnect', serial], 15000);
    state.device.state = state.device.paired ? 'paired' : 'unpaired';
    state.device.serial = null;
    state.device.latencyMs = null;
    state.device.battery = null;
    state.device.reason = 'disconnected';
    pushNow();
    return { ok: true, reason: 'disconnected' };
  }

  /**
   * `adb tcpip 5555` restarts adbd on a fixed port. The device drops off its
   * old port while it does, so reconnect on 5555 and keep that port.
   */
  async function pinTcpip() {
    const blocked = requireTools();
    if (blocked) return { ok: false, reason: blocked };
    if (!state.device.serial) return { ok: false, reason: 'connect the phone first' };
    const wasSerial = state.device.serial;
    const res = await adb(['-s', wasSerial, 'tcpip', '5555'], 30000);
    const text = (res.out + '\n' + res.err).toLowerCase();
    if (!res.ok && !text.includes('restarting in tcp mode')) {
      state.device.tcpipPinned = false;
      saveStore();
      pushNow();
      return { ok: false, reason: adbReason(res, 'adb tcpip 5555 was refused') };
    }
    await delay(1500);
    const host = state.device.host;
    const again = await adb(['connect', host + ':5555'], 30000);
    const againText = (again.out + '\n' + again.err).toLowerCase();
    if (!againText.includes('connected to') || againText.includes('cannot connect') || againText.includes('failed')) {
      state.device.tcpipPinned = false;
      saveStore();
      pushNow();
      return { ok: false, reason: 'adbd restarted but ' + host + ':5555 did not answer: ' + adbReason(again, 'no answer') };
    }
    state.device.tcpipPinned = true;
    state.device.state = 'connected';
    state.device.serial = host + ':5555';
    state.device.port = 5555;
    state.settings.port = 5555;
    state.device.lastSeenAt = Date.now();
    saveStore();
    startProbing();
    pushNow();
    return { ok: true, reason: 'pinned on 5555' };
  }

  async function forget() {
    await stopStream('the phone was forgotten');
    stopProbing();
    stopReconnect();
    if (state.device.serial) await adb(['disconnect', state.device.serial], 15000);
    state.device.state = 'unpaired';
    state.device.serial = null;
    state.device.paired = false;
    state.device.tcpipPinned = null;
    state.device.name = null;
    state.device.model = null;
    state.device.android = null;
    state.device.latencyMs = null;
    state.device.battery = null;
    state.device.reason = 'forgotten — pair again from Settings → Phone (adb’s own keys were left alone, so the phone may not ask twice)';
    state.settings.pairPort = 0;
    saveStore();
    pushNow();
    return { ok: true, reason: state.device.reason };
  }

  /* --- the pollers that notice a phone going away ----------------------- */

  function startProbing() {
    if (probeTimer) return;
    probeTick = 0;
    probeTimer = setInterval(() => { probe().catch(() => {}); }, PROBE_MS);
    if (probeTimer.unref) probeTimer.unref();
  }

  function stopProbing() {
    if (!probeTimer) return;
    clearInterval(probeTimer);
    probeTimer = null;
  }

  async function probe() {
    if (stopped || state.device.state !== 'connected' || !state.device.serial) { stopProbing(); return; }
    const serial = state.device.serial;
    probeTick += 1;

    /* Is it still in the device list, and is it still 'device' (not 'offline')? */
    const list = await adb(['devices', '-l'], 10000);
    if (list.ok) {
      /* `adb devices` separates the serial from the state word with a TAB, and
         `adb devices -l` pads with spaces: accept both, or a tab looks exactly
         like a phone that has dropped off the list. */
      const line = list.out.split('\n').map((s) => s.trim())
        .find((s) => s === serial || s.startsWith(serial + ' ') || s.startsWith(serial + '\t'));
      const word = line ? (line.slice(serial.length).trim().split(/\s+/)[0] || '') : '';
      if (!line || word === 'offline' || word === 'unauthorized') {
        markUnreachable(!line
          ? 'the phone dropped off adb’s device list'
          : ('adb says the phone is ' + word));
        return;
      }
    }
    if (state.device.state !== 'connected') return;

    /* The round trip that decides the picture quality: a TCP handshake with the
       phone's adb port, best of two, nothing spawned. */
    const rtt = await measureLatency();
    state.device.latencyMs = rtt.ms;

    /* Liveness is a separate question, and only adb can answer it: the port can
       accept a socket while the phone itself has stopped talking. This is the
       slow call (it spawns adb), which is exactly why it no longer sets the
       latency. */
    const echo = await adb(['-s', serial, 'shell', 'echo', '1'], 8000);
    if (!echo.ok) {
      markUnreachable('the phone stopped answering: ' + adbReason(echo, 'no answer'));
      return;
    }
    state.device.lastSeenAt = Date.now();
    if (rtt.ms == null) {
      /* adb answers but the phone's adb port refused a plain TCP probe: say so,
         because 'auto' is now guessing instead of measuring. */
      state.device.reason = 'connected, but a TCP probe of ' + probeTarget()
        + ' got no answer (' + rtt.reason + ') — the auto profile is guessing';
    }

    if (probeTick % BATTERY_EVERY === 1 || !state.device.battery) {
      const battery = await adb(['-s', serial, 'shell', 'dumpsys', 'battery'], 10000);
      if (battery.ok) {
        const level = /^\s*level:\s*(\d+)/m.exec(battery.out);
        const status = /^\s*status:\s*(\d+)/m.exec(battery.out);
        const powered = /(?:AC|USB|Wireless|Dock)\s+powered:\s*true/i.test(battery.out);
        if (level) {
          state.device.battery = {
            level: Number(level[1]),
            charging: powered || (status ? (status[1] === '2' || status[1] === '5') : false)
          };
        }
      }
    }
    maybeSwitchProfile();
    push();
  }

  /** The address the TCP round-trip probe actually talks to. */
  function probeTarget() {
    const fromSerial = splitSerial(state.device.serial);
    const host = (fromSerial && fromSerial.host) || state.device.host;
    const port = (fromSerial && fromSerial.port) || state.device.port || state.settings.port;
    return host && port ? host + ':' + port : '';
  }

  function splitSerial(serial) {
    const m = /^(.+):(\d{1,5})$/.exec(String(serial || ''));
    if (!m) return null;
    return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) };
  }

  /** Best of two TCP round trips to the phone's adb port. */
  async function measureLatency() {
    const target = probeTarget();
    if (!target) return { ms: null, reason: 'no address to probe yet' };
    const at = splitSerial(target);
    let best = null;
    let reason = '';
    for (let i = 0; i < 2; i += 1) {
      const one = await tcpRoundTrip(at.host, at.port, RTT_TIMEOUT_MS);
      if (one.ms != null) best = best == null ? one.ms : Math.min(best, one.ms);
      else reason = one.reason;
    }
    return { ms: best, reason: best == null ? (reason || 'no answer') : '' };
  }

  /**
   * profile 'auto' is not a one-shot decision: the phone moves between Wi-Fi and
   * cellular while the stream runs. When AUTO_SWITCH_TICKS probes in a row ask
   * for the other bitrate, restart the stream at it — and say so in the reason,
   * because the picture visibly changes.
   */
  function maybeSwitchProfile() {
    if (autoSwitching || !live || state.settings.profile !== 'auto' || state.stream.state !== 'running') {
      autoCrossings = 0;
      return null;
    }
    const verdict = autoDecision(state.device.latencyMs, live.tier || 'lan', autoCrossings);
    autoCrossings = verdict.crossings;
    if (!verdict.restart) return null;
    return restartForTier(verdict.tier, state.device.latencyMs);
  }

  async function restartForTier(tier, latencyMs) {
    if (autoSwitching || !live) return;
    autoSwitching = true;
    const label = tier === 'away' ? 'Away' : 'LAN';
    const why = 'the link changed (' + latencyMs + ' ms round trip on '
      + AUTO_SWITCH_TICKS + ' probes in a row) — restarting at the ' + label + ' bitrate';
    state.stream.reason = why;
    pushNow();
    try {
      await stopStream(why);
      const res = await startStream();
      state.stream.reason = res.ok
        ? state.stream.reason + ' — switched to the ' + label + ' bitrate after the link changed'
        : 'could not restart at the ' + label + ' bitrate: ' + res.reason;
      pushNow();
    } catch (err) {
      state.stream.reason = 'could not restart at the ' + label + ' bitrate: ' + msgOf(err);
      pushNow();
    } finally {
      autoSwitching = false;
    }
  }

  function markUnreachable(reason) {
    state.device.state = 'unreachable';
    state.device.reason = reason;
    state.device.latencyMs = null;
    stopProbing();
    if (live) stopStream('the phone went away: ' + reason).catch(() => {});
    pushNow();
    scheduleReconnect();
  }

  /**
   * Auto-reconnect, with backoff, and ONLY while a Phone page is open — an
   * unattended browser must not spawn an adb child every minute forever. When
   * it is not retrying, the state says exactly that.
   */
  function scheduleReconnect() {
    stopReconnect();
    if (stopped) return;
    if (!state.settings.autoConnect) {
      state.device.reason += ' — auto-connect is off, press Connect';
      return;
    }
    if (!guests.size) {
      state.device.reason += ' — not retrying while no Phone page is open';
      return;
    }
    reconnectTries += 1;
    const wait = Math.min(60000, 5000 * Math.pow(2, Math.min(reconnectTries - 1, 4)));
    state.device.reason += ' — retrying in ' + Math.round(wait / 1000) + ' s (try ' + reconnectTries + ')';
    pushNow();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped || !guests.size || !state.settings.autoConnect) return;
      connect({ host: state.settings.host, port: state.settings.port }).then((res) => {
        if (res && res.ok) autoStart('reconnected').catch(() => {});
      }).catch(() => {});
    }, wait);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function stopReconnect() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /* --- the socket pipe: read N bytes, then stream packets ---------------- */

  /**
   * One object per TCP socket. It owns the socket's 'data' handler for its
   * whole life, so the handshake reads and the packet relay never fight over
   * it: read(n) while `mode` is 'read', then stream(kind, onPacket).
   */
  function makePipe(socket, label) {
    const pipe = {
      socket,
      label,
      buf: Buffer.alloc(0),
      mode: 'read',
      want: 0,
      resolve: null,
      reject: null,
      timer: null,
      onPacket: null,
      isVideo: false,
      closed: false,
      error: ''
    };
    socket.on('data', (chunk) => {
      pipe.buf = pipe.buf.length ? Buffer.concat([pipe.buf, chunk]) : chunk;
      pumpPipe(pipe);
    });
    socket.on('error', (err) => failPipe(pipe, msgOf(err)));
    socket.on('close', () => failPipe(pipe, pipe.error || 'the ' + label + ' socket closed'));
    return pipe;
  }

  function pumpPipe(pipe) {
    if (pipe.mode === 'read') {
      if (!pipe.resolve || pipe.buf.length < pipe.want) return;
      const out = pipe.buf.subarray(0, pipe.want);
      pipe.buf = pipe.buf.subarray(pipe.want);
      const resolve = pipe.resolve;
      pipe.resolve = null;
      pipe.reject = null;
      pipe.want = 0;
      if (pipe.timer) { clearTimeout(pipe.timer); pipe.timer = null; }
      resolve(out);
      return;
    }
    if (pipe.mode !== 'stream' || !pipe.onPacket) return;
    try {
      pipe.buf = pipe.kind === 'device'
        ? parseDeviceMessages(pipe.buf, pipe.onPacket)
        : parseMediaPackets(pipe.buf, pipe.isVideo, pipe.onPacket);
    } catch (err) {
      pipe.error = msgOf(err);
      streamError('the ' + pipe.label + ' stream went out of sync: ' + pipe.error);
      try { pipe.socket.destroy(); } catch { /* already gone */ }
    }
  }

  function failPipe(pipe, reason) {
    pipe.closed = true;
    if (pipe.reject) {
      const reject = pipe.reject;
      pipe.resolve = null;
      pipe.reject = null;
      if (pipe.timer) { clearTimeout(pipe.timer); pipe.timer = null; }
      reject(new Error(reason));
    }
    if (pipe.onClose) pipe.onClose(reason);
  }

  function readExact(pipe, n, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (pipe.closed) { reject(new Error(pipe.error || 'the ' + pipe.label + ' socket is closed')); return; }
      pipe.want = n;
      pipe.resolve = resolve;
      pipe.reject = reject;
      pipe.timer = setTimeout(() => {
        pipe.timer = null;
        pipe.resolve = null;
        pipe.reject = null;
        reject(new Error('the phone sent no ' + pipe.label + ' data for ' + Math.round(timeoutMs / 1000) + ' s'));
      }, timeoutMs);
      pumpPipe(pipe);
    });
  }

  function streamPipe(pipe, kind, isVideo, onPacket) {
    pipe.mode = 'stream';
    pipe.kind = kind;
    pipe.isVideo = isVideo;
    pipe.onPacket = onPacket;
    pumpPipe(pipe);
  }

  function tcpConnect(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('the local tunnel did not accept a connection')); }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  /* --- the WebSocket relay ---------------------------------------------- */

  function ensureWs() {
    if (wss) return Promise.resolve(state.ws.port);
    if (wsStarting) return wsStarting;
    if (!WebSocketServer) return Promise.reject(new Error(wsLoadError || 'the ws module is missing'));
    wsStarting = new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        perMessageDeflate: false,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info, cb) => {
          /* MEASURED on Electron 44: a bundled file:// guest sends
             `Origin: file://` on the upgrade — not 'null', and not nothing.
             Anything else is some other page trying its luck. A browser only
             ever tells the page "1006", so the refusal has to be said here. */
          const origin = info.origin;
          if (origin && origin !== 'null' && origin !== 'file://') {
            relayNote = 'a page at ' + origin + ' asked for the phone relay and was refused — only the browser’s own Phone page may connect';
            pushNow();
            cb(false, 403, 'origin');
            return;
          }
          let given = '';
          try { given = new URL(info.req.url || '/', 'http://127.0.0.1').searchParams.get('t') || ''; } catch { given = ''; }
          if (!tokenOk(given)) {
            relayNote = 'something asked for the phone relay without this run’s key and was refused';
            pushNow();
            cb(false, 401, 'token');
            return;
          }
          cb(true);
        }
      });
      server.on('listening', () => {
        wss = server;
        wsStarting = null;
        state.ws.port = server.address().port;
        pushNow();
        resolve(state.ws.port);
      });
      server.on('error', (err) => {
        wsStarting = null;
        state.reason = 'the phone relay could not open its local socket: ' + msgOf(err);
        pushNow();
        reject(err);
      });
      server.on('connection', (socket) => onWsClient(socket));
    });
    return wsStarting;
  }

  function tokenOk(given) {
    if (!given || given.length !== token.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token)); } catch { return false; }
  }

  function wsUrl() {
    return 'ws://127.0.0.1:' + state.ws.port + '/?t=' + token;
  }

  function onWsClient(socket) {
    relayNote = '';
    const client = { ws: socket, dropping: false, drops: 0 };
    clients.add(client);
    state.ws.clients = clients.size;
    socket.on('close', () => {
      clients.delete(client);
      state.ws.clients = clients.size;
      push();
    });
    socket.on('error', () => { /* the close handler does the cleanup */ });
    socket.on('message', (data, isBinary) => onWsMessage(client, data, isBinary));
    sendText(client, safeJson({ type: 'state', state }));
    /* A page that joined mid-stream needs the metas, the last session packet
       and the last config packet, or it would decode nothing and say nothing. */
    if (live && live.meta) {
      for (const meta of live.meta) sendText(client, safeJson(meta));
      if (live.lastSession) sendBinaryTo(client, CH_VIDEO, live.lastSession);
      if (live.lastConfig) sendBinaryTo(client, CH_VIDEO, live.lastConfig);
    }
    push();
  }

  function onWsMessage(client, data, isBinary) {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!buf.length) return;
      const channel = buf[0];
      const body = buf.subarray(1);
      if (channel !== CH_CONTROL) {
        sendText(client, safeJson({ type: 'result', id: 0, ok: false, reason: 'channel ' + channel + ' is not something the page may send' }));
        return;
      }
      if (!live || !live.control || live.control.closed) {
        sendText(client, safeJson({ type: 'result', id: 0, ok: false, reason: 'no control socket: the stream is ' + state.stream.state }));
        return;
      }
      try { live.control.socket.write(body); } catch (err) {
        streamError('the control socket would not take input: ' + msgOf(err));
      }
      return;
    }
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') { sendText(client, safeJson({ type: 'pong', t: msg.t })); return; }
    if (msg.type !== 'command') return;
    const id = msg.id;
    Promise.resolve(command(msg.name, msg.arg)).then((res) => {
      sendText(client, safeJson(Object.assign({ type: 'result', id }, res || { ok: false, reason: 'no answer' })));
    }, (err) => {
      sendText(client, safeJson({ type: 'result', id, ok: false, reason: msgOf(err) }));
    });
  }

  function sendText(client, text) {
    if (!text) return;
    try {
      if (client.ws.readyState === 1) client.ws.send(text);
    } catch { /* it is going away; its close handler cleans up */ }
  }

  function sendBinaryTo(client, channel, packet) {
    const frame = Buffer.allocUnsafe(packet.length + 1);
    frame[0] = channel;
    packet.copy(frame, 1);
    try {
      if (client.ws.readyState === 1) client.ws.send(frame, { binary: true });
    } catch { /* going away */ }
  }

  /**
   * One scrcpy packet -> one binary ws message per client. Backpressure is per
   * client: a page that cannot keep up loses non-key VIDEO packets until the
   * next key/config/session packet, and the drop count is named in the reason.
   */
  /**
   * The moment a client starts dropping, the picture it shows is frozen until
   * the next key frame — and scrcpy's own key-frame interval is up to 10 s, which
   * is what the first live run looked like. RESET_VIDEO (ControlMessage.java type
   * 17, createEmpty: the byte on its own) asks the phone's encoder for one now.
   * Rate-limited across every client, because each one would otherwise ask.
   * Returns false — with a visible reason — when it could not be sent.
   */
  function requestKeyFrame(why) {
    if (!live || !live.control || live.control.closed) return false;
    const now = Date.now();
    if (now - (live.lastKeyRequestAt || 0) < KEY_REQUEST_MS) return false;
    live.lastKeyRequestAt = now;
    try {
      live.control.socket.write(Buffer.from([CTRL_RESET_VIDEO]));
      live.keyRequests = (live.keyRequests || 0) + 1;
      return true;
    } catch (err) {
      state.stream.reason = 'could not ask the phone for a fresh key frame after ' + why
        + ': ' + msgOf(err) + ' — the picture may sit frozen for a few seconds';
      pushNow();
      return false;
    }
  }

  function broadcastPacket(channel, packet, info) {
    for (const client of clients) {
      if (client.ws.readyState !== 1) continue;
      if (channel === CH_VIDEO && !(info && (info.session || info.config || info.key))) {
        if (client.ws.bufferedAmount > BACKPRESSURE_BYTES && !client.dropping) {
          client.dropping = true;
          requestKeyFrame('a page fell behind');
        }
        if (client.dropping) {
          client.drops += 1;
          if (live) live.drops += 1;
          continue;
        }
      } else if (client.dropping) {
        client.dropping = false;   // a key frame: the page can start clean again
      }
      sendBinaryTo(client, channel, packet);
    }
  }

  /* --- the stream ------------------------------------------------------- */

  function streamError(reason) {
    state.stream.state = 'error';
    state.stream.reason = reason;
    pushNow();
  }

  function chooseBitrate() {
    const s = state.settings;
    if (s.profile === 'lan') return { bitrate: s.lanBitrate, why: 'LAN profile', tier: 'lan' };
    if (s.profile === 'away') return { bitrate: s.awayBitrate, why: 'Away profile', tier: 'away' };
    /* 'auto' reads the TCP round trip — the network, not adb's process spawn. */
    const latency = state.device.latencyMs;
    if (latency == null) return { bitrate: s.lanBitrate, why: 'auto → LAN (no round trip measured yet)', tier: 'lan' };
    if (latency > AWAY_LATENCY_MS) return { bitrate: s.awayBitrate, why: 'auto → Away (' + latency + ' ms round trip)', tier: 'away' };
    return { bitrate: s.lanBitrate, why: 'auto → LAN (' + latency + ' ms round trip)', tier: 'lan' };
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const chosen = server.address().port;
        server.close(() => resolve(chosen));
      });
    });
  }

  async function startStream() {
    const blocked = requireTools();
    if (blocked) return { ok: false, reason: blocked };
    if (state.device.state !== 'connected' || !state.device.serial) {
      return { ok: false, reason: 'the phone is not connected (' + state.device.state + ')' };
    }
    if (live) return { ok: true, reason: 'already ' + state.stream.state };

    const serial = state.device.serial;
    const s = state.settings;
    const picked = chooseBitrate();
    const scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;   // Options.java: 31-bit, parsed as hex
    const scidHex = scid.toString(16).padStart(8, '0');

    state.stream.state = 'starting';
    state.stream.reason = 'pushing the scrcpy server to the phone…';
    state.stream.profile = s.profile;
    state.stream.bitrate = picked.bitrate;
    state.stream.maxSize = s.maxSize;
    state.stream.maxFps = s.maxFps;
    state.stream.audio = s.audio;
    state.stream.audioCodec = null;
    state.stream.codec = null;
    state.stream.width = 0;
    state.stream.height = 0;
    state.stream.fps = 0;
    state.stream.kbps = 0;
    state.stream.scid = scidHex;
    state.stream.since = Date.now();
    pushNow();

    live = {
      serial,
      scidHex,
      localPort: 0,
      forwarded: false,
      server: null,
      serverLog: [],
      video: null,
      audio: null,
      control: null,
      meta: [],
      lastSession: null,
      lastConfig: null,
      drops: 0,
      keyRequests: 0,          // RESET_VIDEO messages sent after a drop
      lastKeyRequestAt: 0,
      tier: picked.tier,       // which bitrate this run is using, for profile 'auto'
      bytes: [],
      lastVideoAt: 0,
      runReason: '',           // the "mirroring …" line, so the ticker can restore it
      tick: null,
      screenOff: false,
      stopping: false
    };
    autoCrossings = 0;
    state.stream.lastVideoAt = 0;

    try {
      /* 1. the jar — only when the phone does not already have this exact one */
      const localSize = fs.statSync(state.tools.serverPath).size;
      const stat = await adb(['-s', serial, 'shell', 'stat', '-c', '%s', DEVICE_JAR], 15000);
      const remoteSize = stat.ok ? parseInt(String(stat.out).trim(), 10) : NaN;
      if (remoteSize !== localSize) {
        const pushed = await adb(['-s', serial, 'push', state.tools.serverPath, DEVICE_JAR], 120000);
        if (!pushed.ok) throw new Error('could not copy the scrcpy server to the phone: ' + adbReason(pushed, 'adb push failed'));
      }

      /* 2. the tunnel */
      live.localPort = await freePort();
      state.stream.reason = 'opening the adb tunnel…';
      pushNow();
      const forward = await adb(['-s', serial, 'forward', 'tcp:' + live.localPort, 'localabstract:scrcpy_' + scidHex], 15000);
      if (!forward.ok) throw new Error('adb forward failed: ' + adbReason(forward, 'no answer'));
      live.forwarded = true;

      /* 3. the server itself — a long-lived adb shell, NOT through the queue */
      const args = [
        '-s', serial, 'shell',
        'CLASSPATH=' + DEVICE_JAR,
        'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
        'scid=' + scidHex,
        'tunnel_forward=true',
        'video=true',
        'video_codec=h264',
        'audio=' + (s.audio ? 'true' : 'false'),
        'audio_codec=opus',
        'max_size=' + s.maxSize,
        'max_fps=' + s.maxFps,
        'video_bit_rate=' + picked.bitrate,
        'control=true',
        'cleanup=true',
        'log_level=info'
      ];
      state.stream.reason = 'starting the scrcpy server on the phone (' + picked.why + ')…';
      pushNow();
      live.server = spawn(state.tools.adbPath, args, { windowsHide: true });
      const keep = (chunk) => {
        for (const line of String(chunk).split('\n')) {
          const text = line.trim();
          if (text) live.serverLog.push(text);
        }
        while (live.serverLog.length > 40) live.serverLog.shift();
      };
      live.server.stdout.on('data', keep);
      live.server.stderr.on('data', keep);
      live.server.on('error', (err) => {
        if (!live || live.stopping) return;
        streamError('the scrcpy server could not be started: ' + msgOf(err));
        stopStream('').catch(() => {});
      });
      live.server.on('close', () => {
        if (!live || live.stopping) return;
        const last = live.serverLog.filter((l) => !/^\s*$/.test(l)).pop() || 'it exited without a message';
        streamError('the scrcpy server on the phone stopped: ' + last);
        stopStream('').catch(() => {});
      });

      /* 4. the three sockets, in the server's accept order */
      await openAndRelay(live.localPort, s.audio);
      return { ok: true, reason: state.stream.reason };
    } catch (err) {
      const reason = msgOf(err);
      const last = live && live.serverLog.length ? live.serverLog[live.serverLog.length - 1] : '';
      streamError(last && !reason.includes(last) ? reason + ' (the phone said: ' + last + ')' : reason);
      await stopStream('');
      return { ok: false, reason: state.stream.reason };
    }
  }

  /**
   * Everything after `adb forward`: connect the sockets, read the handshake,
   * then relay. Split out so the harness can drive it against a fake scrcpy
   * server on a plain TCP port without adb anywhere near it.
   */
  async function openAndRelay(localPort, wantAudio) {
    if (!live) {
      live = {
        meta: [], bytes: [], drops: 0, keyRequests: 0, lastKeyRequestAt: 0,
        tier: chooseBitrate().tier, serverLog: [], lastVideoAt: 0, runReason: '', stopping: false
      };
    }
    state.stream.state = 'starting';
    state.stream.reason = 'waiting for the phone to answer on the tunnel…';
    pushNow();

    /* The first socket gets a dummy byte the moment the server accepts it. Until
       the server is up, adb accepts the TCP connection and then drops it, so
       retry the whole connect until one of them yields that byte. */
    const deadline = Date.now() + 12000;
    let videoPipe = null;
    let lastError = 'no answer';
    while (!videoPipe) {
      if (live.stopping) throw new Error('stopped while starting');
      if (Date.now() > deadline) throw new Error('the scrcpy server never answered on the tunnel (' + lastError + ')');
      let socket = null;
      try { socket = await tcpConnect(localPort, 3000); } catch (err) { lastError = msgOf(err); await delay(150); continue; }
      const pipe = makePipe(socket, 'video');
      try {
        await readExact(pipe, 1, 1500);   // the dummy byte: proof something is listening on the phone
        videoPipe = pipe;
      } catch (err) {
        lastError = msgOf(err);
        try { socket.destroy(); } catch { /* ignore */ }
        await delay(150);
      }
    }
    live.video = videoPipe;

    if (wantAudio) {
      live.audio = makePipe(await tcpConnect(localPort, 5000), 'audio');
    }
    live.control = makePipe(await tcpConnect(localPort, 5000), 'control');

    /* The device name only comes after every socket has been accepted
       (Server.java calls sendDeviceMeta once DesktopConnection.open returns). */
    const nameBuf = await readExact(videoPipe, 64, 10000);
    const nul = nameBuf.indexOf(0);
    const deviceName = nameBuf.toString('utf8', 0, nul < 0 ? 64 : nul).trim();
    if (deviceName && !state.device.name) state.device.name = deviceName;

    /* Each media socket then sends its u32 codec id — or a disable code. */
    const videoId = (await readExact(videoPipe, 4, 10000)).readUInt32BE(0);
    if (videoId === 0 || videoId === 1) {
      throw new Error('the phone refused to capture video (code ' + videoId + ')');
    }
    const videoCodec = VIDEO_CODECS[videoId] || ('0x' + videoId.toString(16));
    state.stream.codec = videoCodec;
    const videoMeta = { type: 'stream', channel: CH_VIDEO, codec: videoCodec, deviceName };
    live.meta.push(videoMeta);
    broadcastText(videoMeta);

    let audioNote = '';
    if (live.audio) {
      const audioId = (await readExact(live.audio, 4, 10000)).readUInt32BE(0);
      if (audioId === 0 || audioId === 1) {
        /* Streamer.writeDisableStream: 0 = could not capture, carry on with
           video; 1 = a configuration error the client must not ignore. */
        const why = audioId === 0
          ? 'the phone could not capture audio (nothing is playing, or Android refused) — video only'
          : 'the phone reported an audio configuration error — video only';
        state.stream.audioCodec = null;
        const meta = { type: 'stream', channel: CH_AUDIO, codec: null, deviceName, reason: why };
        live.meta.push(meta);
        broadcastText(meta);
        try { live.audio.socket.destroy(); } catch { /* ignore */ }
        live.audio = null;
        state.stream.audio = false;
        audioNote = why;
      } else {
        const audioCodec = AUDIO_CODECS[audioId] || ('0x' + audioId.toString(16));
        state.stream.audioCodec = audioCodec;
        const meta = { type: 'stream', channel: CH_AUDIO, codec: audioCodec, deviceName };
        live.meta.push(meta);
        broadcastText(meta);
      }
    }

    /* --- relay --- */
    streamPipe(videoPipe, 'media', true, (packet, info) => {
      if (info.session) {
        live.lastSession = Buffer.from(packet);
        state.stream.width = info.width;
        state.stream.height = info.height;
        push();
      } else {
        if (info.config) live.lastConfig = Buffer.from(packet);
        live.lastVideoAt = Date.now();
        state.stream.lastVideoAt = live.lastVideoAt;
        live.bytes.push({ t: live.lastVideoAt, n: packet.length });
      }
      broadcastPacket(CH_VIDEO, packet, info);
    });
    if (live.audio) {
      streamPipe(live.audio, 'media', false, (packet, info) => broadcastPacket(CH_AUDIO, packet, info));
      live.audio.onClose = (reason) => {
        if (!live || live.stopping) return;
        state.stream.reason = 'audio stopped: ' + reason + ' — video carries on';
        state.stream.audioCodec = null;
        pushNow();
      };
    }
    streamPipe(live.control, 'device', false, (packet) => broadcastPacket(CH_DEVICE, packet, null));
    live.video.onClose = (reason) => {
      if (!live || live.stopping) return;
      const last = live.serverLog.length ? ' (the phone said: ' + live.serverLog[live.serverLog.length - 1] + ')' : '';
      streamError('the video stream ended: ' + reason + last);
      stopStream('').catch(() => {});
    };

    if (state.settings.screenOffWhileMirroring) {
      try {
        live.control.socket.write(Buffer.from([CTRL_SET_DISPLAY_POWER, 0]));
        live.screenOff = true;
      } catch (err) {
        audioNote = (audioNote ? audioNote + '; ' : '') + 'the phone screen stayed on: ' + msgOf(err);
      }
    }

    state.stream.state = 'running';
    state.stream.since = Date.now();
    live.lastVideoAt = Date.now();
    state.stream.lastVideoAt = live.lastVideoAt;
    live.runReason = 'mirroring ' + (state.stream.codec || '')
      + (state.stream.bitrate ? ' at ' + Math.round(state.stream.bitrate / 100000) / 10 + ' Mb/s' : '')
      + (live.audio ? ' with ' + (state.stream.audioCodec || 'audio') : '')
      + (audioNote ? ' — ' + audioNote : (live.audio ? '' : ' (no audio)'));
    state.stream.reason = live.runReason;
    startStreamTicker();
    pushNow();
    return { ok: true, reason: state.stream.reason };
  }

  function broadcastText(payload) {
    const text = safeJson(payload);
    if (!text) return;
    for (const c of clients) sendText(c, text);
  }

  /**
   * 'stalled' the honest way. Video silence is NOT a fault: the scrcpy server
   * encodes a frame only when the display changes, so a phone sitting on its
   * home screen sends nothing for minutes — and the first live run covered a
   * perfectly good picture with "no video for 25 s". It now takes all three:
   *   - the scrcpy shell on the phone is still alive (a server that exited has
   *     its own, better error), and
   *   - no video for longer than STALL_MS, and
   *   - the control socket is gone: the device-message path is the only thing
   *     that can tell a dead link from a still screen.
   * The adb liveness probe deliberately is NOT the third leg: a failed probe
   * calls markUnreachable(), which stops the stream outright and says why, so
   * it could never also leave the stream 'stalled'.
   */
  function stallCheck(stillMs) {
    if (!live || stillMs <= STALL_MS) return '';
    const serverAlive = !!live.server && live.server.exitCode === null && !live.server.killed;
    if (!serverAlive) return '';
    if (!live.control || !live.control.closed) return '';
    return 'no video for ' + Math.round(stillMs / 1000) + ' s and the control channel to the phone'
      + ' is dead while the scrcpy server is still running — the link is broken; press Stop, then Start';
  }

  /** The "mirroring …" line, plus whatever is worth saying about it right now. */
  function runningReason(stillMs) {
    const base = (live && live.runReason) || ('mirroring ' + (state.stream.codec || ''));
    if (live && live.drops) {
      return base + ' — dropping frames to keep the page up to date (' + live.drops + ' dropped, '
        + (live.keyRequests || 0) + ' fresh key frame' + (live.keyRequests === 1 ? '' : 's') + ' asked for)';
    }
    if (stillMs >= STILL_NOTE_MS) {
      return base + ' — still for ' + Math.round(stillMs / 1000)
        + ' s (the phone sends a frame only when the picture changes)';
    }
    return base;
  }

  /** fps / kbps / how long the picture has been still, once a second. */
  function startStreamTicker() {
    if (!live || live.tick) return;
    live.tick = setInterval(() => {
      if (!live) return;
      const now = Date.now();
      live.bytes = live.bytes.filter((row) => now - row.t <= 1000);
      const bytes = live.bytes.reduce((sum, row) => sum + row.n, 0);
      state.stream.fps = live.bytes.length;
      state.stream.kbps = Math.round((bytes * 8) / 1000);
      state.stream.lastVideoAt = live.lastVideoAt;
      if (state.stream.state === 'running' || state.stream.state === 'stalled') {
        const stillMs = now - live.lastVideoAt;
        const broken = stallCheck(stillMs);
        if (broken) {
          state.stream.state = 'stalled';
          state.stream.reason = broken;
        } else {
          state.stream.state = 'running';
          state.stream.reason = runningReason(stillMs);
        }
      }
      push();
    }, 1000);
    if (live.tick.unref) live.tick.unref();
  }

  async function stopStream(why) {
    const bag = live;
    if (!bag) {
      if (state.stream.state !== 'off' && state.stream.state !== 'error') {
        state.stream.state = 'off';
        state.stream.reason = why || 'not started';
        pushNow();
      }
      return { ok: true, reason: state.stream.reason };
    }
    bag.stopping = true;
    live = null;
    if (bag.tick) clearInterval(bag.tick);

    /* Put the screen back if we were the ones who turned it off. */
    if (bag.screenOff && bag.control && !bag.control.closed) {
      try { bag.control.socket.write(Buffer.from([CTRL_SET_DISPLAY_POWER, 1])); await delay(60); } catch { /* going away anyway */ }
    }
    for (const pipe of [bag.video, bag.audio, bag.control]) {
      if (!pipe) continue;
      pipe.onClose = null;
      try { pipe.socket.destroy(); } catch { /* already gone */ }
    }
    if (bag.server) {
      try { bag.server.kill(); } catch { /* already gone */ }
    }
    if (bag.forwarded && bag.serial) {
      const removed = await adb(['-s', bag.serial, 'forward', '--remove', 'tcp:' + bag.localPort], 15000);
      if (!removed.ok && state.stream.state !== 'error') {
        state.stream.reason = 'stopped, but the adb tunnel on port ' + bag.localPort + ' would not close: ' + adbReason(removed, 'no answer');
      }
    }
    if (state.stream.state !== 'error') {
      state.stream.state = 'off';
      state.stream.reason = why || 'stopped';
    }
    state.stream.fps = 0;
    state.stream.kbps = 0;
    state.stream.scid = null;
    state.stream.lastVideoAt = 0;
    autoCrossings = 0;
    pushNow();
    return { ok: true, reason: state.stream.reason };
  }

  /* --- settings --------------------------------------------------------- */

  const QUALITY_KEYS = ['profile', 'audio', 'lanBitrate', 'awayBitrate', 'maxSize', 'maxFps', 'screenOffWhileMirroring'];

  async function setSettings(partial) {
    if (!partial || typeof partial !== 'object') return { ok: false, reason: 'nothing to change' };
    const before = Object.assign({}, state.settings);
    Object.assign(state.settings, sanitiseSettings(partial, state.settings));
    const changed = QUALITY_KEYS.filter((key) => state.settings[key] !== before[key]);
    state.device.host = state.settings.host;
    if (state.device.state !== 'connected') state.device.port = state.settings.port;
    state.stream.profile = state.settings.profile;
    state.stream.maxSize = state.settings.maxSize;
    state.stream.maxFps = state.settings.maxFps;
    if (state.stream.state === 'off') state.stream.audio = state.settings.audio;
    saveStore();
    pushNow();
    if (changed.length && live) {
      state.stream.reason = 'restarting the stream for the new ' + changed.join(' + ') + '…';
      pushNow();
      await stopStream('restarting for new settings');
      const res = await startStream();
      return { ok: res.ok, reason: res.reason };
    }
    return { ok: true, reason: 'saved' };
  }

  /* --- the command table (IPC and the page share it) -------------------- */

  async function command(name, arg) {
    try {
      switch (name) {
        case 'install-tools': return await installTools();
        case 'pair': return await pair(arg);
        case 'connect': return await connect(arg);
        case 'disconnect': return await disconnect();
        case 'pin-tcpip': return await pinTcpip();
        case 'start': return await startStream();
        case 'stop': return await stopStream('stopped by hand');
        case 'set-settings': return await setSettings(arg);
        case 'forget': return await forget();
        case 'open-settings':
          try { sendToChrome('phone:open-settings'); } catch { /* no chrome */ }
          return { ok: true, reason: 'asked the browser to open Settings → Phone' };
        default:
          return { ok: false, reason: '"' + String(name) + '" is not a phone command' };
      }
    } catch (err) {
      /* Nothing may escape as a bare throw: it becomes a reason the page shows. */
      const reason = msgOf(err);
      log('command', name, 'failed:', reason);
      pushNow();
      return { ok: false, reason };
    }
  }

  /* --- the guest bootstrap (a preload-less file:// page) ----------------- */

  function isPhonePage(url) {
    if (!url || !isBundledPage(url)) return false;
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch { return false; }
    return pathname.endsWith('/phone.html');
  }

  async function answerHello(contents) {
    try {
      await ensureWs();
    } catch (err) {
      /* The page still has to be told, or it would sit there saying nothing;
         the failure is global, so it belongs in state.reason. */
      state.reason = 'the phone relay could not start: ' + msgOf(err);
      pushTo(contents, { ws: '', state });
      return;
    }
    if (!guests.has(contents)) {
      guests.add(contents);
      contents.once('destroyed', () => {
        guests.delete(contents);
        if (!guests.size && live) stopStream('the Phone page was closed').catch(() => {});
        push();
      });
    }
    pushTo(contents, { ws: wsUrl(), state });
    autoStart('a Phone page opened').catch(() => {});
  }

  function pushTo(contents, payload) {
    if (!contents || contents.isDestroyed()) return;
    const json = safeJson(payload);
    if (!json) return;
    /* JSON is not quite a JS literal: U+2028/9 are line terminators in source
       but legal inside a JSON string, and this string becomes source. */
    const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const code = 'window.__applyPhone && window.__applyPhone(' + safe + ')';
    try {
      const answer = contents.executeJavaScript(code, true);
      if (answer && typeof answer.catch === 'function') answer.catch(() => {});
    } catch { /* the guest navigated away mid-push */ }
  }

  function handleGuestLine(contents, line) {
    const text = String(line || '').trim();
    if (text !== 'phone:hello') return false;
    answerHello(contents).catch((err) => log('hello failed:', msgOf(err)));
    return true;
  }

  function watchGuest(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('console-message', function (details) {
      let url = '';
      try { url = contents.getURL(); } catch { url = ''; }
      if (!isPhonePage(url)) return;
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('guest line failed:', msgOf(err));
      }
    });
  }

  /**
   * The whole point of the workspace: open the Phone tab and it is already
   * mirroring. Every step it takes is a visible state, and it never loops.
   */
  async function autoStart(why) {
    if (autoBusy || stopped || !guests.size) return;
    autoBusy = true;
    try {
      if (state.tools.state === 'missing' || state.tools.state === 'error') {
        await installTools();
      }
      if (state.tools.state !== 'ready') return;
      if (!state.settings.autoConnect) {
        state.device.reason = state.device.state === 'connected' ? state.device.reason : 'auto-connect is off — press Connect';
        pushNow();
        return;
      }
      if (!state.device.paired) return;                    // the reason already says "not paired"
      if (state.device.state !== 'connected') {
        const res = await connect({ host: state.settings.host, port: state.settings.port });
        if (!res.ok) return;
      }
      if (!live) await startStream();
      void why;
    } finally {
      autoBusy = false;
      pushNow();
    }
  }

  /* --- wiring ----------------------------------------------------------- */

  loadStore();
  state.tools.dir = toolsDir();
  if (state.tools.dir) {
    /* Tools that are already on disk make the first hello instant — but the
       sha is only trusted after install-tools re-verifies it. */
    const adbPath = path.join(state.tools.dir, 'platform-tools', 'adb.exe');
    const serverPath = path.join(state.tools.dir, SERVER_FILE);
    if (fs.existsSync(adbPath) && fs.existsSync(serverPath)) {
      state.tools.reason = 'downloaded, not verified yet';
      /* Re-hash what is already here and ask adb its version, in the
         background, with the network switched off: booting the browser must
         never start a download. The page shows this reason meanwhile. */
      installTools({ verifyOnly: true }).catch(() => {});
    }
  }
  refreshReady();

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try {
        if (contents && contents.getType() === 'webview') watchGuest(contents);
      } catch { /* a guest that died between creation and here */ }
    });
  }

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('phone:describe', (event) => (isChromeSender(event) ? state : null));
    ipcMain.handle('phone:command', (event, name, arg) => {
      if (!isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
      return command(name, arg);
    });
  }

  async function stop() {
    stopped = true;
    stopProbing();
    stopReconnect();
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    await stopStream('the browser is closing');
    for (const client of clients) {
      try { client.ws.close(); } catch { /* ignore */ }
    }
    clients.clear();
    if (wss) {
      try { wss.close(); } catch { /* ignore */ }
      wss = null;
    }
    if (adbServerStarted && state.tools.adbPath) {
      /* Our adb daemon is ours to clean up — it is bundled, not the system's —
         and killing it drops every `adb forward` with it. main.js's before-quit
         calls stop() WITHOUT awaiting it (main.js:4474), so this last step is
         synchronous on purpose: an awaited promise would lose the race with
         process exit and leave an adb.exe behind. */
      try {
        spawnSync(state.tools.adbPath, ['kill-server'], { windowsHide: true, timeout: 10000 });
      } catch { /* nothing left to do about it at quit time */ }
      adbServerStarted = false;
    }
  }

  return {
    stop,
    describe() { return state; },
    /* ---- TEST HOOK. Only the harness uses this; nothing in the app does. ---- */
    _test: {
      state,
      ensureWs,
      wsUrl,
      token,
      command,
      installTools,
      openAndRelay,          // drive the relay against a fake scrcpy server's TCP port
      stopStream,
      handleGuestLine,
      isPhonePage,
      clientCount: () => clients.size,
      clients: () => Array.from(clients),
      connect,
      probe,
      stopProbing,
      measureLatency,        // the TCP round trip, against any listener
      maybeSwitchProfile,    // profile 'auto', re-decided mid-stream
      /* Stand a stub in for adb.exe: fn(args, timeoutMs) -> { ok, out, err, ms }.
         Nothing in the app calls this; it is how the harness asserts argv order. */
      setAdbRunner(fn) { adbRunner = typeof fn === 'function' ? fn : null; },
      setAdbPath(p) { state.tools.adbPath = p || null; }
    }
  };
}

module.exports = {
  create,
  /* ---- TEST HOOK: the pure byte-level parsers and decisions, so they can be
     exercised without an Electron app, a phone, or a socket. ---- */
  _test: {
    parseMediaPackets,
    parseDeviceMessages,
    parseMdnsServices,
    autoDecision,
    tcpRoundTrip,
    VIDEO_CODECS,
    AUDIO_CODECS
  }
};
