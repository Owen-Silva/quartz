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
 *               latencyMs: number|null, lastSeenAt: number,        // adb round trip, probed every few s while connected
 *               battery: { level: number, charging: boolean } | null },
 *     stream: { state: 'off'|'starting'|'running'|'stalled'|'error', reason: string,
 *               codec: string|null, width: number, height: number, fps: number, kbps: number,
 *               profile: 'lan'|'away'|'auto', bitrate: number, maxSize: number, maxFps: number,
 *               audio: boolean, audioCodec: string|null, scid: string|null, since: number },
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
 *      127.0.0.1, ephemeral port, perMessageDeflate off, Origin must be
 *      absent or 'null' — a file:// page — and ?t= must match):
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
 *                  width u32 at 4..7, height u32 at 8..11). A media packet is the
 *                  12-byte header (u64 BE ptsAndFlags: bit 62 = config, bit 61 =
 *                  key frame; u32 BE size) followed by exactly `size` payload bytes
 *                  (H.264 Annex B — the config packet is SPS/PPS). main splits the
 *                  TCP stream on those headers; it never parses the payload.
 *        1 audio   main -> page : same framing (no session packets). Codec from
 *                  the stream meta: 'opus' or 'raw' (PCM s16le, 48 kHz, stereo —
 *                  confirm against AudioCodec.java for the pinned version).
 *        2 device  main -> page : one complete DeviceMessage (control socket,
 *                  device -> client) verbatim: type u8, then per DeviceMessageWriter
 *                  (0 clipboard: u32 len + utf8; 1 ack clipboard: u64 seq;
 *                  2 uhid output: u16 id, u16 size, data).
 *        3 control page -> main : one complete ControlMessage verbatim; main
 *                  writes it to the control socket as-is and never parses it.
 *      The pinned server is scrcpy v4.1 (sources for THAT tag are the only
 *      authority on the bytes: Streamer.java, DesktopConnection.java,
 *      ControlMessageReader(Test).java, DeviceMessageWriter(Test).java,
 *      Options.java). Never guess a byte from memory.
 *
 * HOW IT WORKS (and what can go wrong, because none of it may fail silently)
 *
 * TOOLS. Into <userData>/tools/: Google's platform-tools zip (adb.exe + its
 * two DLLs; the `latest` URL, sha256 recorded at download and shown) and
 * scrcpy-server-v4.1 from the GitHub release (sha256 MUST equal
 * deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae, from the
 * release's SHA256SUMS.txt; a mismatch is tools.state 'error' with the reason,
 * never a silent retry). Progress is state, not a log line.
 *
 * DEVICE. unpaired -> pairing (`adb pair host:pairPort code`) -> paired ->
 * connecting (`adb connect host:port`) -> connected -> (start) ... Wireless
 * debugging only runs while the phone is on SOME Wi-Fi and its connect port
 * changes every time it is toggled; `adb tcpip 5555` pins a fixed port that
 * survives on cellular until the phone reboots, and the state says plainly
 * when the pin is missing. Every adb call's stderr becomes the reason.
 *
 * STREAM. `adb push` the server to /data/local/tmp/scrcpy-server.jar, then
 *   adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process /
 *     com.genymobile.scrcpy.Server 4.1 scid=<hex> tunnel_forward=true
 *     video_codec=h264 audio_codec=<opus|raw> max_size=<n> max_fps=<n>
 *     video_bit_rate=<n> control=true cleanup=true log_level=info
 *   adb forward tcp:<local> localabstract:scrcpy_<scid>
 * then three TCP connects in order (video, audio, control); the first socket
 * yields a dummy byte then a 64-byte device name; each media socket then
 * yields its u32 codec id. The version argument must equal the jar's
 * BuildConfig.VERSION_NAME ("4.1") or the server refuses — that refusal is a
 * visible reason too.
 */

/**
 * SCAFFOLD. Everything above is the contract; nothing below is built yet. The
 * page and Settings show exactly this reason until phone.js lands.
 */
function create({ app, ipcMain, isChromeSender, isBundledPage, send }) {
  const state = {
    ready: false,
    reason: 'phone.js is a scaffold: nothing is built yet',
    tools: { state: 'missing', reason: 'not built', dir: '', adbPath: null, serverPath: null, serverVersion: '4.1', adbVersion: null, progress: { item: '', received: 0, total: 0 }, sha: { adb: null, server: null, serverExpected: 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae' } },
    device: { state: 'unpaired', reason: 'not built', host: '100.64.0.1', port: 5555, serial: null, name: null, model: null, android: null, paired: false, tcpipPinned: null, latencyMs: null, lastSeenAt: 0, battery: null },
    stream: { state: 'off', reason: 'not built', codec: null, width: 0, height: 0, fps: 0, kbps: 0, profile: 'auto', bitrate: 0, maxSize: 1280, maxFps: 60, audio: true, audioCodec: null, scid: null, since: 0 },
    ws: { port: 0, clients: 0 },
    settings: { host: '100.64.0.1', port: 5555, pairPort: 0, profile: 'auto', audio: true, lanBitrate: 8000000, awayBitrate: 2000000, maxSize: 1280, maxFps: 60, autoConnect: true, screenOffWhileMirroring: false }
  };

  ipcMain.handle('phone:describe', (event) => {
    if (!isChromeSender(event)) return null;
    return state;
  });
  ipcMain.handle('phone:command', (event, name) => {
    if (!isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
    return { ok: false, reason: 'phone.js is a scaffold: "' + String(name) + '" is not built yet' };
  });

  void app; void isBundledPage; void send;

  return {
    stop() { /* nothing running */ },
    describe() { return state; }
  };
}

module.exports = { create };
