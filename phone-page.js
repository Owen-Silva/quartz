/*
 * phone-page.js — the Phone tab's own script (a bundled, preload-less guest:
 * no window.api, no require). It mirrors the user's Android phone: H.264 from the
 * scrcpy server, decoded here with WebCodecs onto the canvas at true aspect;
 * pointer -> touch, wheel -> scroll, keys -> keycodes/text; a rail of hardware
 * keys and readouts. The wire contract (console bootstrap, then a localhost
 * WebSocket with JSON text frames and channel-prefixed binary frames) is the
 * header of phone.js — that file is the single source of truth.
 *
 * Every byte this page writes to the control socket comes from the scrcpy
 * **v4.1** sources, not from memory:
 *   ControlMessage.java            the type numbers
 *   test_control_msg_serialize.c   the exact bytes of every message below
 *   ControlMessageReader.java      the fixed-point encodings and the limits
 *   Controller.java                POINTER_ID_MOUSE = -1
 *   Streamer.java / develop.md     the 12-byte media header and the session packet
 * Where a value is NOT pinned by those files, the comment says so.
 *
 * Nothing here may fail silently. Every path that can refuse, drop, stall or
 * time out puts its reason in the status strip, the rail note or a readout —
 * in words, on the page, not only on the console.
 */
(function () {
  'use strict';

  /* ==================================================================== */
  /* 0. The scrcpy wire, as constants                                     */
  /* ==================================================================== */

  /* ControlMessage.java (v4.1). Only the ones this page sends are listed. */
  var CTL = {
    INJECT_KEYCODE: 0,
    INJECT_TEXT: 1,
    INJECT_TOUCH_EVENT: 2,
    INJECT_SCROLL_EVENT: 3,
    BACK_OR_SCREEN_ON: 4,
    EXPAND_NOTIFICATION_PANEL: 5,
    GET_CLIPBOARD: 8,
    SET_CLIPBOARD: 9,
    SET_DISPLAY_POWER: 10,
    ROTATE_DEVICE: 11,
    RESET_VIDEO: 17
  };

  /* DeviceMessageWriter.java: device -> client, arriving on channel 2. */
  var DEV_MSG = { CLIPBOARD: 0, ACK_CLIPBOARD: 1, UHID_OUTPUT: 2 };

  /* ControlMessageReader.java */
  var INJECT_TEXT_MAX_LENGTH = 300;             // pinned: the long-text test writes 0x0000012c
  var CLIPBOARD_TEXT_MAX_LENGTH = (1 << 18) - 14; // MESSAGE_MAX_SIZE - 14

  /* ControlMessage.java COPY_KEY_* */
  var COPY_KEY_NONE = 0, COPY_KEY_COPY = 1;

  /* android.view.KeyEvent.ACTION_* */
  var KEY_DOWN = 0, KEY_UP = 1;

  /* android.view.MotionEvent.ACTION_* */
  var TOUCH_DOWN = 0, TOUCH_UP = 1, TOUCH_MOVE = 2, TOUCH_CANCEL = 3;

  /* Controller.java: "control_msg.h values of the pointerId field" —
     POINTER_ID_MOUSE = -1, i.e. 0xffffffffffffffff on the wire. A real touch
     or pen gets its own browser pointerId, which the server maps to a pointer
     slot like any other. */
  var POINTER_ID_MOUSE = BigInt('0xffffffffffffffff');

  /* android.view.KeyEvent.KEYCODE_*. Only KEYCODE_ENTER (0x42) is pinned by
     the reference test; the rest are Android platform constants, not scrcpy
     bytes, so they are as stable as the Android SDK itself. */
  var AKEYCODE = {
    HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26,
    TAB: 61, ENTER: 66, DEL: 67, APP_SWITCH: 187,
    DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
    PAGE_UP: 92, PAGE_DOWN: 93, ESCAPE: 111, FORWARD_DEL: 112,
    MOVE_HOME: 122, MOVE_END: 123
  };

  /* android.view.KeyEvent.META_*: SHIFT_ON 0x01 and SHIFT_LEFT_ON 0x40 are
     pinned by the reference test (it expects 0x41 for both together). */
  var AMETA = { SHIFT_ON: 0x01, ALT_ON: 0x02, CTRL_ON: 0x1000, META_ON: 0x10000 };

  /* Browser KeyboardEvent.key -> Android keycode. Everything printable goes
     out as INJECT_TEXT instead, so this list is exactly "the specials". */
  var SPECIAL_KEYS = {
    Enter: AKEYCODE.ENTER,
    Backspace: AKEYCODE.DEL,
    Delete: AKEYCODE.FORWARD_DEL,
    Tab: AKEYCODE.TAB,
    Escape: AKEYCODE.ESCAPE,
    ArrowUp: AKEYCODE.DPAD_UP,
    ArrowDown: AKEYCODE.DPAD_DOWN,
    ArrowLeft: AKEYCODE.DPAD_LEFT,
    ArrowRight: AKEYCODE.DPAD_RIGHT,
    Home: AKEYCODE.MOVE_HOME,
    End: AKEYCODE.MOVE_END,
    PageUp: AKEYCODE.PAGE_UP,
    PageDown: AKEYCODE.PAGE_DOWN
  };

  /* The WebSocket's binary channels (phone.js header). */
  var CH_VIDEO = 0, CH_AUDIO = 1, CH_DEVICE = 2, CH_CONTROL = 3;

  /* Tuning. All of these are visible in a readout when they bite. */
  var DECODE_QUEUE_LIMIT = 4;     // deltas are dropped above this
  var STALL_AFTER_MS = 3000;      // "no frames for N s"
  var AUDIO_TARGET_S = 0.06;      // ~60 ms of buffer
  var AUDIO_MAX_AHEAD_S = 0.35;   // beyond this the buffer is resynced
  var PING_EVERY_MS = 2000;

  /* ==================================================================== */
  /* 1. Elements and small helpers                                        */
  /* ==================================================================== */

  var els = {};
  var params = null;
  try { params = new URLSearchParams(window.location.search); } catch (err) { params = null; }
  var SELFTEST = !!(params && params.get('selftest') === '1');

  var encoder = new TextEncoder();
  var decoderUtf8 = new TextDecoder();

  function $(id) { return document.getElementById(id); }

  function msg(err) {
    if (!err) return 'no reason given';
    if (typeof err === 'string') return err;
    return String(err.message || err.name || err);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function fmtBytes(n) {
    if (!n) return '0';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* ==================================================================== */
  /* 2. Control message serialisation                                     */
  /* ==================================================================== */
  /* Every builder returns the control message ALONE (no channel byte), so
     the self-test can compare it with the reference test's expected bytes. */

  function u16FixedPoint(f) {
    /* Binary.u16FixedPointToFloat's inverse: 1.0f must come back exactly,
       and the reference test writes 0xffff for it. */
    return clamp(Math.round(clamp(f, 0, 1) * 0xffff), 0, 0xffff);
  }

  function i16FixedPointScroll(f) {
    /* ControlMessageReader: "i16FixedPointToFloat() decodes assuming [-1, 1],
       but the actual range is [-16, 16]". The reference test writes 0x7fff
       for +16 and 0x8000 for -16. */
    var v = clamp(f / 16, -1, 1);
    var i = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
    return clamp(i, -0x8000, 0x7fff);
  }

  function utf8Capped(text, maxBytes) {
    var bytes = encoder.encode(String(text == null ? '' : text));
    if (bytes.length <= maxBytes) return bytes;
    /* Truncate on a code point boundary: back off over continuation bytes. */
    var end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end);
  }

  function msgInjectKeycode(action, keycode, repeat, metaState) {
    var b = new Uint8Array(14);
    var v = new DataView(b.buffer);
    b[0] = CTL.INJECT_KEYCODE;
    b[1] = action & 0xff;
    v.setUint32(2, keycode >>> 0);
    v.setUint32(6, repeat >>> 0);
    v.setUint32(10, metaState >>> 0);
    return b;
  }

  function msgInjectText(text) {
    var t = utf8Capped(text, INJECT_TEXT_MAX_LENGTH);
    var b = new Uint8Array(5 + t.length);
    var v = new DataView(b.buffer);
    b[0] = CTL.INJECT_TEXT;
    v.setUint32(1, t.length);
    b.set(t, 5);
    return b;
  }

  function msgInjectTouch(action, pointerId, x, y, width, height, pressure, actionButton, buttons) {
    var b = new Uint8Array(32);
    var v = new DataView(b.buffer);
    b[0] = CTL.INJECT_TOUCH_EVENT;
    b[1] = action & 0xff;
    v.setBigUint64(2, BigInt.asUintN(64, BigInt(pointerId)));
    v.setInt32(10, x | 0);
    v.setInt32(14, y | 0);
    v.setUint16(18, width & 0xffff);
    v.setUint16(20, height & 0xffff);
    v.setUint16(22, u16FixedPoint(pressure));
    v.setUint32(24, actionButton >>> 0);
    v.setUint32(28, buttons >>> 0);
    return b;
  }

  function msgInjectScroll(x, y, width, height, hscroll, vscroll, buttons) {
    var b = new Uint8Array(21);
    var v = new DataView(b.buffer);
    b[0] = CTL.INJECT_SCROLL_EVENT;
    v.setInt32(1, x | 0);
    v.setInt32(5, y | 0);
    v.setUint16(9, width & 0xffff);
    v.setUint16(11, height & 0xffff);
    v.setInt16(13, i16FixedPointScroll(hscroll));
    v.setInt16(15, i16FixedPointScroll(vscroll));
    v.setUint32(17, buttons >>> 0);
    return b;
  }

  function msgBackOrScreenOn(action) {
    return new Uint8Array([CTL.BACK_OR_SCREEN_ON, action & 0xff]);
  }

  function msgEmpty(type) {
    return new Uint8Array([type & 0xff]);
  }

  function msgGetClipboard(copyKey) {
    return new Uint8Array([CTL.GET_CLIPBOARD, copyKey & 0xff]);
  }

  function msgSetClipboard(sequence, paste, text) {
    var t = utf8Capped(text, CLIPBOARD_TEXT_MAX_LENGTH);
    var b = new Uint8Array(14 + t.length);
    var v = new DataView(b.buffer);
    b[0] = CTL.SET_CLIPBOARD;
    v.setBigUint64(1, BigInt.asUintN(64, BigInt(sequence)));
    b[9] = paste ? 1 : 0;
    v.setUint32(10, t.length);
    b.set(t, 14);
    return b;
  }

  function msgSetDisplayPower(on) {
    return new Uint8Array([CTL.SET_DISPLAY_POWER, on ? 1 : 0]);
  }

  /* ==================================================================== */
  /* 3. Page state                                                        */
  /* ==================================================================== */

  var phone = null;          // the last state phone.js sent (contract shape)
  var answered = false;      // did the browser ever answer phone:hello?
  var bootTimedOut = false;

  var wire = {
    url: '',
    ws: null,
    state: 'none',           // none | connecting | open | retry | failed
    reason: '',
    tries: 0,
    retryAt: 0,
    timer: 0,
    pingTimer: 0,
    rtt: null,
    lastPongAt: 0,
    cmdSeq: 0,
    pending: new Map()
  };

  var video = {
    dec: null,
    codec: '',               // avc1.xxxxxx, read out of the SPS
    codecName: '',           // what the stream meta called it ('h264')
    config: null,            // the latest config packet (SPS/PPS, Annex B)
    needKey: true,
    w: 0, h: 0,
    pending: null,           // the newest decoded frame, not yet painted
    raf: 0,
    painted: 0, dropped: 0, skipped: 0,
    bytes: 0,
    fps: 0, kbps: 0,
    lastPaintAt: 0,
    err: '',
    note: 'waiting for the first frame',
    paused: false,
    selftest: false
  };

  var audio = {
    ctx: null, gain: null, dec: null,
    codec: '',
    unavailable: false,      // the phone could not capture audio at all
    muted: false,
    playAt: 0,
    blocked: false,
    reason: 'no audio yet',
    packets: 0, dropped: 0,
    armed: false
  };

  var input = {
    captured: false,
    held: new Map(),         // key -> repeat count, for INJECT_KEYCODE repeat
    down: new Set(),         // pointerIds currently down on the canvas
    clipSeq: 0
  };

  /* ==================================================================== */
  /* 4. The status strip, the frame note and the rail note                */
  /* ==================================================================== */

  var statusAction = null;   // { label, run } for the one button on the strip
  /* The self-test owns the strip while it runs (and keeps its verdict there
     afterwards), or the once-a-second tick would paint over the result. A
     later __applyPhone hands the strip back to the live states. */
  var statusLocked = false;

  function setStatus(kind, text, sub, action) {
    if (!els.dot) return;
    els.dot.dataset.kind = kind;
    els.text.textContent = text;
    els.sub.textContent = sub || '';
    statusAction = action || null;
    if (statusAction) {
      els.action.hidden = false;
      els.action.textContent = statusAction.label;
      els.action.disabled = false;
    } else {
      els.action.hidden = true;
    }
  }

  function setFrameNote(text) {
    if (!els.note) return;
    if (!text) { els.note.hidden = true; return; }
    els.note.hidden = false;
    els.note.textContent = text;
  }

  function railNote(kind, text) {
    if (!els.railNote) return;
    els.railNote.dataset.kind = kind;
    els.railNote.textContent = text;
  }

  /* The one place that decides what the page is saying. Called after every
     state push, every wire change and once a second for the live numbers. */
  function renderStatus() {
    if (statusLocked) return;

    /* 1. the bootstrap handshake */
    if (!answered && !SELFTEST) {
      if (bootTimedOut) {
        setStatus('error', 'the browser did not answer: phone.js is not wired to this page',
          'the page printed phone:hello and nothing came back', null);
        setFrameNote('no answer from the browser.\nphone.js did not reply to phone:hello.');
      } else {
        setStatus('off', 'waiting for the browser…', 'sent phone:hello', null);
        setFrameNote('waiting for the browser…');
      }
      return;
    }

    /* 2. the WebSocket, which everything after the handshake rides on */
    if (wire.state !== 'open') {
      if (wire.state === 'none') {
        setStatus('error', 'the browser did not send a WebSocket address',
          wire.reason || 'nothing to connect to', null);
        setFrameNote('the browser answered without a WebSocket address.');
        return;
      }
      if (wire.state === 'connecting') {
        setStatus('busy', 'connecting to the browser…', wire.url.replace(/\?t=.*/, ''), null);
        setFrameNote('connecting to the browser…');
        return;
      }
      if (wire.state === 'retry') {
        var left = Math.max(0, Math.ceil((wire.retryAt - Date.now()) / 1000));
        setStatus('error', 'the connection to the browser dropped — retrying in ' + left + ' s',
          wire.reason, { label: 'Retry now', run: function () { connectWire(true); } });
        setFrameNote('the connection to the browser dropped.\n' + (wire.reason || ''));
        return;
      }
      setStatus('error', 'cannot reach the browser', wire.reason,
        { label: 'Retry', run: function () { connectWire(true); } });
      setFrameNote('cannot reach the browser.\n' + (wire.reason || ''));
      return;
    }

    if (!phone) {
      setStatus('busy', 'connected — waiting for the first state', '', null);
      setFrameNote('waiting for the first state from the browser…');
      return;
    }

    /* 3. tools -> device -> stream, in the order they must be satisfied */
    var t = phone.tools || {};
    if (t.state === 'missing') {
      setStatus('warn', 'the phone tools are not installed yet', t.reason || 'adb and the scrcpy server are missing',
        { label: 'Download tools', run: function () { runCommand('install-tools'); } });
      setFrameNote('the phone tools are not installed yet.\n' + (t.reason || ''));
      return;
    }
    if (t.state === 'downloading') {
      var p = t.progress || {};
      var pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
      setStatus('busy', 'downloading ' + (p.item || 'the tools') + ' — ' + pct + '%',
        fmtBytes(p.received || 0) + ' of ' + fmtBytes(p.total || 0), null);
      setFrameNote('downloading ' + (p.item || 'the tools') + ' — ' + pct + '%');
      return;
    }
    if (t.state === 'error') {
      setStatus('error', 'the phone tools are broken', t.reason || 'no reason given',
        { label: 'Retry', run: function () { runCommand('install-tools'); } });
      setFrameNote('the phone tools are broken.\n' + (t.reason || ''));
      return;
    }

    var d = phone.device || {};
    if (d.state === 'unpaired') {
      setStatus('warn', 'this phone is not paired yet', d.reason || 'pair it once from Wireless debugging',
        { label: 'Open Settings → Phone', run: function () { runCommand('open-settings'); } });
      setFrameNote('this phone is not paired yet.\nSettings → Phone takes the pairing code.');
      return;
    }
    if (d.state === 'pairing' || d.state === 'connecting') {
      setStatus('busy', d.state === 'pairing' ? 'pairing…' : 'connecting to the phone…', d.reason || '', null);
      setFrameNote(d.state === 'pairing' ? 'pairing…' : 'connecting to the phone…');
      return;
    }
    if (d.state === 'paired') {
      setStatus('warn', 'paired, but not connected', d.reason || (d.host ? d.host + ':' + d.port : ''),
        { label: 'Connect', run: function () { runCommand('connect'); } });
      setFrameNote('paired, but not connected.');
      return;
    }
    if (d.state === 'unreachable' || d.state === 'error') {
      setStatus('error', d.state === 'unreachable' ? 'the phone is unreachable' : 'the phone connection failed',
        d.reason || 'no reason given',
        { label: 'Retry', run: function () { runCommand('connect'); } });
      setFrameNote((d.state === 'unreachable' ? 'the phone is unreachable.' : 'the phone connection failed.') +
        '\n' + (d.reason || ''));
      return;
    }

    var s = phone.stream || {};
    if (s.state === 'off') {
      setStatus('warn', 'connected — the stream is off', d.model || d.name || '',
        { label: 'Start', run: function () { runCommand('start'); } });
      setFrameNote('connected to the phone.\nStart the stream to see it.');
      return;
    }
    if (s.state === 'starting') {
      setStatus('busy', 'starting the stream…', s.reason || '', null);
      setFrameNote('starting the stream…');
      return;
    }
    if (s.state === 'error') {
      setStatus('error', 'the stream failed', s.reason || 'no reason given',
        { label: 'Retry', run: function () { runCommand('start'); } });
      setFrameNote('the stream failed.\n' + (s.reason || ''));
      return;
    }

    /* running / stalled: now the page's own view of the picture decides. */
    var age = video.lastPaintAt ? (performance.now() - video.lastPaintAt) : Infinity;
    if (s.state === 'stalled' || age > STALL_AFTER_MS) {
      var secs = video.lastPaintAt ? Math.floor(age / 1000) : null;
      setStatus('warn', secs === null ? 'no frames yet' : 'no frames for ' + secs + ' s',
        s.reason || video.err || video.note,
        { label: 'Restart', run: function () { runCommand('start'); } });
      setFrameNote((secs === null ? 'no frames yet.' : 'no frames for ' + secs + ' s.') +
        '\n' + (s.reason || video.err || video.note || ''));
      return;
    }

    setStatus('ok', 'mirroring ' + video.w + '×' + video.h,
      video.fps + ' fps · ' + video.kbps + ' kbps' + (video.err ? ' · ' + video.err : ''), null);
    setFrameNote('');
  }

  /* ==================================================================== */
  /* 5. Readouts                                                          */
  /* ==================================================================== */

  var READOUT_ROWS = [
    ['device', 'device'],
    ['battery', 'battery'],
    ['phone', 'phone latency'],
    ['rtt', 'ws rtt'],
    ['fps', 'fps'],
    ['kbps', 'kbps'],
    ['queue', 'decode queue'],
    ['dropped', 'dropped'],
    ['age', 'frame age'],
    ['profile', 'bitrate'],
    ['audio', 'audio'],
    ['keys', 'keys']
  ];
  var readoutEls = {};

  function buildReadouts() {
    var dl = els.read;
    if (!dl) return;
    dl.textContent = '';
    READOUT_ROWS.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[1];
      var dd = document.createElement('dd');
      dd.textContent = '—';
      dl.appendChild(dt);
      dl.appendChild(dd);
      readoutEls[row[0]] = dd;
    });
  }

  function readout(key, text, kind, title) {
    var dd = readoutEls[key];
    if (!dd) return;
    dd.textContent = text;
    dd.title = title || text;        // the rail is narrow; the full words hover
    if (kind) dd.dataset.kind = kind; else dd.removeAttribute('data-kind');
  }

  function renderReadouts() {
    var d = (phone && phone.device) || {};
    var s = (phone && phone.stream) || {};

    readout('device', d.state ? d.state : 'unknown',
      d.state === 'connected' ? 'ok' : (d.state === 'unreachable' || d.state === 'error' ? 'error' : 'warn'));
    readout('battery', d.battery ? (d.battery.level + '%' + (d.battery.charging ? ' ⚡' : '')) : '—');
    readout('phone', typeof d.latencyMs === 'number' ? d.latencyMs + ' ms' : '—');
    readout('rtt', wire.rtt === null ? (wire.state === 'open' ? 'waiting' : 'no link') : wire.rtt + ' ms',
      wire.state === 'open' ? '' : 'error');
    readout('fps', String(video.fps), video.fps > 0 ? 'ok' : 'warn');
    readout('kbps', String(video.kbps));
    readout('queue', video.dec ? String(video.dec.decodeQueueSize) : 'no decoder',
      video.dec ? (video.dec.decodeQueueSize > DECODE_QUEUE_LIMIT ? 'warn' : '') : 'warn');
    readout('dropped', video.dropped + (video.skipped ? ' (+' + video.skipped + ' skipped)' : ''),
      video.dropped ? 'warn' : '');
    readout('age', video.lastPaintAt ? Math.round(performance.now() - video.lastPaintAt) + ' ms' : '—',
      video.lastPaintAt && (performance.now() - video.lastPaintAt) > STALL_AFTER_MS ? 'warn' : '');
    readout('profile', s.profile ? (s.profile + ' · ' + Math.round((s.bitrate || 0) / 1000) + 'k') : '—');
    readout('audio', audioSummary(),
      (audio.unavailable || audio.blocked) ? 'warn' : (audio.packets ? 'ok' : ''),
      audio.unavailable ? ('no audio: ' + audio.reason) : audioSummary());
    readout('keys', input.captured ? 'phone' : 'browser', input.captured ? 'ok' : '');
  }

  function audioSummary() {
    if (audio.unavailable) return 'none: ' + audio.reason;
    if (audio.muted) return 'muted';
    if (audio.blocked) return 'click to start';
    if (!audio.codec) return (phone && phone.stream && phone.stream.audio === false) ? 'off' : '—';
    if (audio.reason && !audio.packets) return audio.reason;
    return audio.codec + ' · ' + audio.packets;
  }

  /* ==================================================================== */
  /* 6. The wire: WebSocket, commands, pings, reconnect                   */
  /* ==================================================================== */

  function connectWire(now) {
    if (!wire.url) {
      wire.state = 'none';
      wire.reason = 'phone.js sent no ws address';
      renderStatus();
      return;
    }
    if (wire.timer) { clearTimeout(wire.timer); wire.timer = 0; }
    if (wire.ws) {
      try { wire.ws.onclose = null; wire.ws.close(); } catch (err) { /* already gone */ }
      wire.ws = null;
    }
    if (now) wire.tries = 0;

    var ws;
    wire.state = 'connecting';
    wire.reason = '';
    renderStatus();
    try {
      ws = new WebSocket(wire.url);
    } catch (err) {
      wire.state = 'failed';
      wire.reason = 'the ws address was refused: ' + msg(err);
      renderStatus();
      return;
    }
    ws.binaryType = 'arraybuffer';
    wire.ws = ws;

    ws.onopen = function () {
      wire.state = 'open';
      wire.tries = 0;
      wire.reason = '';
      startPings();
      renderStatus();
      renderReadouts();
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') onText(ev.data);
      else onBinary(ev.data);
    };
    ws.onerror = function () {
      /* The error event carries no reason in a browser; onclose has the code. */
      wire.reason = wire.reason || 'the WebSocket reported an error';
    };
    ws.onclose = function (ev) {
      if (wire.ws !== ws) return;
      wire.ws = null;
      stopPings();
      wire.rtt = null;
      /* 1006 is what a browser reports for a refused upgrade (a bad token, a
         rejected Origin) — there is no close frame to quote, so name it. */
      wire.reason = ev.code === 1006
        ? 'the relay refused the connection (1006): the token or the Origin was not accepted'
        : 'closed (' + ev.code + (ev.reason ? ': ' + ev.reason : '') + ')';
      scheduleRetry();
      renderStatus();
      renderReadouts();
    };
  }

  function scheduleRetry() {
    wire.tries++;
    var wait = Math.min(15000, 500 * Math.pow(2, Math.min(5, wire.tries - 1)));
    wire.state = 'retry';
    wire.retryAt = Date.now() + wait;
    wire.timer = setTimeout(function () { wire.timer = 0; connectWire(false); }, wait);
  }

  function startPings() {
    stopPings();
    wire.pingTimer = setInterval(function () {
      if (!wire.ws || wire.ws.readyState !== 1) return;
      try { wire.ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }
      catch (err) { wire.reason = 'ping failed: ' + msg(err); }
    }, PING_EVERY_MS);
  }

  function stopPings() {
    if (wire.pingTimer) { clearInterval(wire.pingTimer); wire.pingTimer = 0; }
  }

  function onText(raw) {
    var m;
    try { m = JSON.parse(raw); } catch (err) {
      railNote('error', 'the browser sent something that is not JSON: ' + msg(err));
      return;
    }
    if (!m || !m.type) return;

    if (m.type === 'state') {
      applyState(m.state);
    } else if (m.type === 'pong') {
      wire.rtt = Math.max(0, Date.now() - (m.t || Date.now()));
      wire.lastPongAt = Date.now();
      renderReadouts();
    } else if (m.type === 'result') {
      var done = wire.pending.get(m.id);
      if (done) { wire.pending.delete(m.id); done(m); }
    } else if (m.type === 'stream') {
      onStreamMeta(m);
    }
  }

  function onStreamMeta(m) {
    if (m.channel === CH_VIDEO) {
      video.codecName = m.codec || '';
      video.note = 'video stream announced (' + (m.codec || 'unknown codec') + ') — waiting for the first key frame';
      /* A late joiner gets the metas again, then the LAST session packet and
         the LAST config packet, then live media: resetting here and waiting
         for the next key frame is exactly right in both cases. */
      resetDecoder('a new video stream started');
    } else if (m.channel === CH_AUDIO) {
      resetAudio();
      if (!m.codec) {
        /* Streamer.writeDisableStream: the u32 in the codec-id slot was a
           disable code, not a codec. No audio packet will ever arrive, so say
           so once and for good — video carries on regardless. */
        audio.unavailable = true;
        audio.codec = '';
        audio.reason = m.reason || 'the phone sent no audio codec and no reason';
        railNote('warn', 'audio: ' + audio.reason);
        setMuteButton();
      } else {
        audio.unavailable = false;
        audio.codec = m.codec;
        audio.reason = 'audio stream announced (' + audio.codec + ')';
        setMuteButton();
      }
    }
    renderReadouts();
  }

  function runCommand(name, arg) {
    railNote('', name + '…');
    return sendCommand(name, arg).then(function (res) {
      if (res && res.ok) railNote('ok', name + ': done');
      else railNote('error', name + ' refused: ' + ((res && res.reason) || 'no reason given'));
      return res;
    });
  }

  function sendCommand(name, arg) {
    return new Promise(function (resolve) {
      if (!wire.ws || wire.ws.readyState !== 1) {
        resolve({ ok: false, reason: 'not connected to the browser' });
        return;
      }
      var id = ++wire.cmdSeq;
      wire.pending.set(id, resolve);
      try {
        wire.ws.send(JSON.stringify({ type: 'command', id: id, name: name, arg: arg }));
      } catch (err) {
        wire.pending.delete(id);
        resolve({ ok: false, reason: 'could not send "' + name + '": ' + msg(err) });
        return;
      }
      setTimeout(function () {
        if (!wire.pending.has(id)) return;
        wire.pending.delete(id);
        resolve({ ok: false, reason: 'the browser did not answer "' + name + '" within 10 s' });
      }, 10000);
    });
  }

  /* Every control message the page sends goes through here, so there is one
     place that can say "there is nowhere to send this". */
  function sendControl(bytes, what) {
    if (!wire.ws || wire.ws.readyState !== 1) {
      railNote('error', (what || 'that') + ' went nowhere: not connected to the browser');
      return false;
    }
    if (!phone || !phone.stream || (phone.stream.state !== 'running' && phone.stream.state !== 'stalled')) {
      railNote('error', (what || 'that') + ' went nowhere: the stream is not running, so there is no control socket');
      return false;
    }
    var out = new Uint8Array(bytes.length + 1);
    out[0] = CH_CONTROL;
    out.set(bytes, 1);
    try { wire.ws.send(out); } catch (err) {
      railNote('error', (what || 'that') + ' failed to send: ' + msg(err));
      return false;
    }
    if (what) railNote('ok', what);
    return true;
  }

  /* ==================================================================== */
  /* 7. Binary frames: video, audio, device messages                      */
  /* ==================================================================== */

  function onBinary(buf) {
    if (!buf || buf.byteLength < 1) return;
    var channel = new Uint8Array(buf, 0, 1)[0];
    if (channel === CH_VIDEO) onVideoPacket(buf);
    else if (channel === CH_AUDIO) onAudioPacket(buf);
    else if (channel === CH_DEVICE) onDeviceMessage(buf);
    /* channel 3 is page -> main only; anything else is a contract break. */
    else railNote('error', 'the browser sent an unknown channel byte: ' + channel);
  }

  /* --- video ------------------------------------------------------------ */

  function onVideoPacket(buf) {
    var bytes = new Uint8Array(buf, 1);
    if (bytes.length < 12) {
      video.err = 'a video packet arrived with only ' + bytes.length + ' bytes (the header is 12)';
      renderStatus();
      return;
    }
    var view = new DataView(buf, 1);

    /* develop.md: session packets and media packets are told apart by the
       MSB of byte 0. A session packet is the 12-byte header alone; bit 0 of
       byte 3 is the server's "client resized" flag, which this page has no
       use for — only the width and height matter here. */
    if (bytes[0] & 0x80) {
      onSessionPacket(view.getUint32(4), view.getUint32(8));
      return;
    }

    var hi = view.getUint32(0);
    var lo = view.getUint32(4);
    var isConfig = (hi & 0x40000000) !== 0;   // bit 62 of the u64
    var isKey = (hi & 0x20000000) !== 0;      // bit 61
    var size = view.getUint32(8);
    var ptsUs = (hi & 0x1fffffff) * 4294967296 + lo;

    if (bytes.length < 12 + size) {
      video.err = 'a video packet said ' + size + ' bytes but carried ' + (bytes.length - 12);
      renderStatus();
      return;
    }
    var payload = bytes.subarray(12, 12 + size);
    video.bytes += size;

    if (isConfig) {
      /* The config packet is SPS/PPS in Annex B. With annexb these bytes must
         ride in front of every key frame, so keep a copy: that also makes
         recovery after a drop or a decoder reset trivial. */
      video.config = payload.slice();
      ensureDecoder(video.config);
      return;
    }

    if (video.paused && !video.selftest) {
      /* Hidden tab: decode nothing, and resync at the next key frame. Say it
         here as well as in the visibilitychange handler — a page that loads
         already in a background tab never sees that event, and "waiting for a
         key frame" would be a lie about why the picture is not moving. */
      video.needKey = true;
      video.note = 'this tab is in the background: decoding is paused until it is shown';
      return;
    }

    if (!video.dec && !ensureDecoder(payload)) return;

    if (video.needKey && !isKey) return;            // waiting for a key frame
    if (!isKey && video.dec.decodeQueueSize > DECODE_QUEUE_LIMIT) {
      /* The decoder is behind. Drop deltas (and everything after them, which
         would decode wrong anyway) until the next key frame. */
      video.dropped++;
      video.needKey = true;
      video.note = 'the decoder fell behind: dropping until the next key frame';
      return;
    }

    var data = payload;
    if (isKey && video.config && video.config.length) {
      data = new Uint8Array(video.config.length + payload.length);
      data.set(video.config, 0);
      data.set(payload, video.config.length);
    }

    try {
      video.dec.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: ptsUs,
        data: data
      }));
      video.needKey = false;
    } catch (err) {
      resetDecoder('decode threw: ' + msg(err));
    }
  }

  function onSessionPacket(w, h) {
    if (!w || !h) {
      video.err = 'the session packet gave a ' + w + '×' + h + ' screen';
      renderStatus();
      return;
    }
    if (w === video.w && h === video.h) { video.needKey = true; return; }
    video.w = w;
    video.h = h;
    els.canvas.width = w;
    els.canvas.height = h;
    layoutFrame();
    /* A new capture session (a rotation, usually) means a new SPS. */
    resetDecoder('the phone started a new capture session (' + w + '×' + h + ')');
    renderStatus();
  }

  /* Reads the profile/constraints/level out of the first SPS in an Annex B
     buffer, which is what the 'avc1.PPCCLL' codec string is made of. */
  function spsCodecString(bytes) {
    for (var i = 0; i + 6 < bytes.length; i++) {
      if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
      if ((bytes[i + 3] & 0x1f) !== 7) continue;      // nal_unit_type 7 = SPS
      var hex = function (n) { return (n < 16 ? '0' : '') + n.toString(16); };
      return 'avc1.' + hex(bytes[i + 4]) + hex(bytes[i + 5]) + hex(bytes[i + 6]);
    }
    return '';
  }

  function ensureDecoder(sample) {
    if (video.dec) return true;
    if (!window.VideoDecoder) {
      video.err = 'this build has no WebCodecs VideoDecoder';
      renderStatus();
      return false;
    }
    var codec = spsCodecString(video.config && video.config.length ? video.config : sample);
    if (!codec) {
      video.note = 'no SPS yet: waiting for the config packet';
      return false;
    }
    var dec;
    try {
      dec = new VideoDecoder({
        output: onDecodedFrame,
        error: function (err) { resetDecoder('the decoder failed: ' + msg(err)); }
      });
      dec.configure({
        codec: codec,
        /* Annex B is signalled by the ABSENCE of `description`; the avc member
           is what the encoder side needs and is harmless (and ignored) here. */
        avc: { format: 'annexb' },
        optimizeForLatency: true
      });
    } catch (err) {
      video.err = 'the decoder refused ' + codec + ': ' + msg(err);
      video.dec = null;
      renderStatus();
      return false;
    }
    video.dec = dec;
    video.codec = codec;
    video.err = '';
    video.needKey = true;
    video.note = 'decoder ready (' + codec + ') — waiting for a key frame';
    return true;
  }

  function resetDecoder(reason) {
    if (video.dec) {
      try { video.dec.close(); } catch (err) { /* already closed */ }
    }
    video.dec = null;
    video.needKey = true;
    video.note = reason || 'decoder reset';
    if (reason && /fail|threw|refus/.test(reason)) video.err = reason;
    renderReadouts();
  }

  function onDecodedFrame(frame) {
    /* Always paint the newest frame; a frame that never made it to the screen
       must still be closed or the decoder runs out of buffers. */
    if (video.pending) { video.pending.close(); video.skipped++; }
    video.pending = frame;
    if (!video.raf) video.raf = requestAnimationFrame(paintFrame);
  }

  function paintFrame() {
    video.raf = 0;
    var frame = video.pending;
    video.pending = null;
    if (!frame) return;
    try {
      els.ctx.drawImage(frame, 0, 0, els.canvas.width, els.canvas.height);
      video.painted++;
      video.lastPaintAt = performance.now();
      video.err = '';
      if (els.frame.dataset.live !== '1') { els.frame.dataset.live = '1'; setFrameNote(''); }
    } catch (err) {
      video.err = 'painting failed: ' + msg(err);
    }
    frame.close();
  }

  /* --- audio ------------------------------------------------------------ */

  function onAudioPacket(buf) {
    var bytes = new Uint8Array(buf, 1);
    if (bytes.length < 12) return;
    var view = new DataView(buf, 1);
    var hi = view.getUint32(0);
    var lo = view.getUint32(4);
    var isConfig = (hi & 0x40000000) !== 0;
    var size = view.getUint32(8);
    var ptsUs = (hi & 0x1fffffff) * 4294967296 + lo;
    if (bytes.length < 12 + size) return;
    var payload = bytes.subarray(12, 12 + size);

    if (audio.unavailable) return;        // the stream meta said there is none
    if (audio.muted) return;              // nothing is decoded while muted
    if (!ensureAudioCtx()) return;

    if (audio.codec === 'raw') {
      if (isConfig) return;               // raw PCM has no configuration
      playPcm(payload);
      return;
    }
    if (audio.codec === 'opus') {
      if (isConfig) { configureOpus(payload); return; }
      if (!audio.dec) { audio.reason = 'opus: no config packet yet'; return; }
      try {
        audio.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ptsUs, data: payload }));
      } catch (err) {
        audio.reason = 'opus decode threw: ' + msg(err);
        renderReadouts();
      }
      return;
    }
    audio.reason = 'this page cannot play "' + (audio.codec || 'an unnamed codec') + '"';
    renderReadouts();
  }

  function ensureAudioCtx() {
    if (audio.ctx) return true;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { audio.reason = 'this build has no AudioContext'; renderReadouts(); return false; }
    try {
      audio.ctx = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch (err) {
      audio.reason = 'no AudioContext: ' + msg(err);
      renderReadouts();
      return false;
    }
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = audio.muted ? 0 : 1;
    audio.gain.connect(audio.ctx.destination);
    audio.playAt = 0;
    resumeAudio('first packet');
    return true;
  }

  /* Autoplay policy: an AudioContext made without a user gesture starts
     suspended. Say so on the page and resume on the first click or key. */
  function resumeAudio(why) {
    if (!audio.ctx) return;
    if (audio.ctx.state !== 'suspended') { audio.blocked = false; return; }
    audio.ctx.resume().then(function () {
      audio.blocked = false;
      audio.reason = 'playing';
      renderReadouts();
      renderStatus();
    }).catch(function (err) {
      audio.blocked = true;
      audio.reason = 'audio: waiting for a click (' + msg(err) + ')';
      renderReadouts();
    });
    if (audio.ctx.state === 'suspended') {
      audio.blocked = true;
      audio.reason = 'audio: waiting for a click';
      armAudioGesture();
      renderReadouts();
    }
    void why;
  }

  function armAudioGesture() {
    if (audio.armed) return;
    audio.armed = true;
    var go = function () {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      audio.armed = false;
      resumeAudio('user gesture');
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  }

  function resetAudio() {
    if (audio.dec) { try { audio.dec.close(); } catch (err) { /* gone */ } audio.dec = null; }
    audio.playAt = 0;
  }

  function configureOpus(description) {
    if (!window.AudioDecoder) { audio.reason = 'this build has no AudioDecoder'; renderReadouts(); return; }
    resetAudio();
    try {
      audio.dec = new AudioDecoder({
        output: onAudioData,
        error: function (err) { audio.reason = 'opus decoder failed: ' + msg(err); renderReadouts(); }
      });
      /* Streamer.fixOpusConfigPacket trims the AOPUSHDR wrapper, so the config
         packet on the wire IS the OpusHead — exactly what `description` wants. */
      audio.dec.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        description: description.slice()
      });
      audio.reason = 'opus configured';
    } catch (err) {
      audio.dec = null;
      audio.reason = 'opus config refused: ' + msg(err);
    }
    renderReadouts();
  }

  function onAudioData(data) {
    try {
      var frames = data.numberOfFrames;
      var chans = Math.min(2, data.numberOfChannels);
      var left = new Float32Array(frames);
      var right = new Float32Array(frames);
      data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
      if (chans > 1) data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
      else right.set(left);
      schedule(left, right, frames);
    } catch (err) {
      audio.reason = 'could not read the decoded audio: ' + msg(err);
      renderReadouts();
    }
    data.close();
  }

  /* AudioCodec.java pins only the mime type (MIMETYPE_AUDIO_RAW); the sample
     format itself lives in the server's AudioCapture, which is NOT in the
     pinned reference set here. scrcpy captures PCM 16-bit little-endian,
     48 kHz, stereo — that is what this decodes, and the readout says "raw" so
     a wrong guess would be audible and obvious rather than silent. */
  function playPcm(payload) {
    var frames = payload.byteLength >> 2;         // 2 channels x 2 bytes
    if (!frames) return;
    var view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    var left = new Float32Array(frames);
    var right = new Float32Array(frames);
    for (var i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    schedule(left, right, frames);
  }

  function schedule(left, right, frames) {
    var ctx = audio.ctx;
    if (!ctx) return;
    var buf;
    try {
      buf = ctx.createBuffer(2, frames, 48000);
      buf.copyToChannel(left, 0);
      buf.copyToChannel(right, 1);
    } catch (err) {
      audio.reason = 'could not buffer the audio: ' + msg(err);
      renderReadouts();
      return;
    }
    var now = ctx.currentTime;
    if (audio.playAt < now + 0.005) audio.playAt = now + AUDIO_TARGET_S;   // (re)fill the buffer
    if (audio.playAt > now + AUDIO_MAX_AHEAD_S) {
      /* Too far ahead — the phone is producing faster than we play. Drop this
         packet rather than growing the delay for ever, and count it. */
      audio.dropped++;
      audio.reason = 'audio drifted: dropped ' + audio.dropped;
      renderReadouts();
      return;
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.gain);
    src.start(audio.playAt);
    audio.playAt += frames / 48000;
    audio.packets++;
    if (!audio.blocked) audio.reason = 'playing';
  }

  /* --- device messages (channel 2) -------------------------------------- */

  function onDeviceMessage(buf) {
    var bytes = new Uint8Array(buf, 1);
    if (!bytes.length) return;
    var view = new DataView(buf, 1);
    var type = bytes[0];
    if (type === DEV_MSG.CLIPBOARD) {
      if (bytes.length < 5) { railNote('error', 'the phone sent a short clipboard message'); return; }
      var len = view.getUint32(1);
      var text = decoderUtf8.decode(bytes.subarray(5, 5 + len));
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        railNote('error', 'the phone sent ' + len + ' bytes but this page has no clipboard write');
        return;
      }
      navigator.clipboard.writeText(text).then(function () {
        railNote('ok', 'copied ' + len + ' bytes from the phone');
      }).catch(function (err) {
        railNote('error', 'the browser refused the clipboard: ' + msg(err));
      });
    } else if (type === DEV_MSG.ACK_CLIPBOARD) {
      railNote('ok', 'the phone took the paste');
    } else if (type === DEV_MSG.UHID_OUTPUT) {
      /* Nothing on this page creates a UHID device, so this is informational. */
      railNote('', 'the phone sent UHID output (ignored: this page creates no HID devices)');
    } else {
      railNote('error', 'the phone sent an unknown device message type ' + type);
    }
  }

  /* ==================================================================== */
  /* 8. Input: pointer -> touch, wheel -> scroll, keys -> keycodes/text    */
  /* ==================================================================== */

  function pointAt(e) {
    var r = els.canvas.getBoundingClientRect();
    var x = r.width ? (e.clientX - r.left) / r.width * video.w : 0;
    var y = r.height ? (e.clientY - r.top) / r.height * video.h : 0;
    return {
      x: clamp(Math.round(x), 0, Math.max(0, video.w - 1)),
      y: clamp(Math.round(y), 0, Math.max(0, video.h - 1))
    };
  }

  /* MotionEvent.BUTTON_*: PRIMARY 1, SECONDARY 2, TERTIARY 4, BACK 8,
     FORWARD 16 — the same bit values the browser uses in `buttons`, but
     `button` is ordered 0 primary, 1 middle, 2 secondary, so it is mapped. */
  var BUTTON_OF_INDEX = [1, 4, 2, 8, 16];

  function touchable(what) {
    if (!video.w || !video.h) {
      railNote('error', what + ' went nowhere: the video size is unknown, so there is no coordinate to send');
      return false;
    }
    return true;
  }

  function sendTouch(action, e) {
    if (!touchable('a touch')) return;
    var p = pointAt(e);
    /* A mouse reports pressure 0.5 while a button is down (that is what the
       pointer events spec says), but scrcpy's own client sends 1.0f for a
       mouse, so a tap from here weighs the same as a tap from scrcpy. A pen
       or a real touch keeps its own pressure. */
    var pressure = action === TOUCH_UP ? 0
      : (e.pointerType === 'mouse' ? 1 : (e.pressure > 0 ? e.pressure : 1));
    var pid = e.pointerType === 'mouse' ? POINTER_ID_MOUSE : BigInt(e.pointerId >>> 0);
    var actionButton = (action === TOUCH_DOWN || action === TOUCH_UP) ? (BUTTON_OF_INDEX[e.button] || 0) : 0;
    sendControl(msgInjectTouch(action, pid, p.x, p.y, video.w, video.h, pressure, actionButton, e.buttons & 0x1f));
  }

  function bindInput() {
    var canvas = els.canvas;

    canvas.addEventListener('pointerdown', function (e) {
      canvas.focus();
      if (e.button === 2) {                      // right button -> BACK
        e.preventDefault();
        sendControl(msgBackOrScreenOn(KEY_DOWN), 'back');
        return;
      }
      if (e.button === 1) {                      // middle button -> HOME
        e.preventDefault();
        sendControl(msgInjectKeycode(KEY_DOWN, AKEYCODE.HOME, 0, 0), 'home');
        return;
      }
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      input.down.add(e.pointerId);
      sendTouch(TOUCH_DOWN, e);
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!input.down.has(e.pointerId)) return;  // a phone has no hover
      e.preventDefault();
      sendTouch(TOUCH_MOVE, e);
    });

    canvas.addEventListener('pointerup', function (e) {
      if (e.button === 2) { sendControl(msgBackOrScreenOn(KEY_UP)); return; }
      if (e.button === 1) { sendControl(msgInjectKeycode(KEY_UP, AKEYCODE.HOME, 0, 0)); return; }
      if (!input.down.has(e.pointerId)) return;
      input.down.delete(e.pointerId);
      sendTouch(TOUCH_UP, e);
    });

    canvas.addEventListener('pointercancel', function (e) {
      if (!input.down.has(e.pointerId)) return;
      input.down.delete(e.pointerId);
      sendTouch(TOUCH_CANCEL, e);
    });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (!touchable('a scroll')) return;
      var p = pointAt(e);
      /* deltaMode 0 pixels, 1 lines, 2 pages. Android's scroll axes are
         positive away from the user, the browser's deltas are positive
         towards it, so both are negated. */
      var unit = e.deltaMode === 1 ? 1 : (e.deltaMode === 2 ? 10 : 1 / 100);
      sendControl(msgInjectScroll(p.x, p.y, video.w, video.h,
        -e.deltaX * unit, -e.deltaY * unit, e.buttons & 0x1f));
    }, { passive: false });

    canvas.addEventListener('focus', function () { setCaptured(true); });
    canvas.addEventListener('blur', function () { setCaptured(false); });

    /* Clicking anywhere else releases the keyboard back to the browser. */
    document.addEventListener('pointerdown', function (e) {
      if (e.target === canvas) return;
      canvas.blur();
      setCaptured(false);
    }, true);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  function setCaptured(on) {
    if (input.captured === on) return;
    input.captured = on;
    els.pill.textContent = on ? 'keys → phone' : 'keys → browser';
    els.pill.dataset.on = on ? '1' : '0';
    if (!on) {
      /* Release anything still held so the phone does not see a stuck key. */
      input.held.forEach(function (count, key) {
        var code = SPECIAL_KEYS[key];
        if (code) sendControl(msgInjectKeycode(KEY_UP, code, 0, 0));
      });
      input.held.clear();
    }
    renderReadouts();
  }

  function metaOf(e) {
    var m = 0;
    if (e.shiftKey) m |= AMETA.SHIFT_ON;
    if (e.altKey) m |= AMETA.ALT_ON;
    if (e.ctrlKey) m |= AMETA.CTRL_ON;
    if (e.metaKey) m |= AMETA.META_ON;
    return m;
  }

  function onKeyDown(e) {
    /* The release hotkey works whichever side has the keys. */
    if (e.ctrlKey && e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      var want = !input.captured;
      if (want) els.canvas.focus(); else els.canvas.blur();
      /* The hotkey decides on its own: element.focus()/blur() do nothing in a
         window that does not have the OS focus, and the pill must never lie
         about where the keys are going. */
      setCaptured(want);
      railNote('', want ? 'keys go to the phone (Ctrl+Alt+K releases them)'
        : 'keys go to the browser (Ctrl+Alt+K sends them to the phone)');
      return;
    }
    if (!input.captured) return;

    /* F-keys are deliberately off: they stay with the browser. */
    if (/^F\d{1,2}$/.test(e.key)) return;

    if (e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteToPhone(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyFromPhone(); return; }

    var code = SPECIAL_KEYS[e.key];
    if (code) {
      e.preventDefault();
      var repeat = input.held.get(e.key) || 0;
      input.held.set(e.key, repeat + 1);
      sendControl(msgInjectKeycode(KEY_DOWN, code, repeat, metaOf(e)));
      return;
    }

    /* Anything printable goes as text, which is how scrcpy types characters
       a keycode cannot express. Modified keys are left alone. */
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      sendControl(msgInjectText(e.key));
    }
  }

  function onKeyUp(e) {
    if (!input.captured) return;
    var code = SPECIAL_KEYS[e.key];
    if (!code) return;
    e.preventDefault();
    input.held.delete(e.key);
    sendControl(msgInjectKeycode(KEY_UP, code, 0, metaOf(e)));
  }

  function pasteToPhone() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      railNote('error', 'this page cannot read the clipboard (no navigator.clipboard.readText)');
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (!text) { railNote('error', 'the clipboard is empty: nothing to paste'); return; }
      var seq = ++input.clipSeq;
      if (sendControl(msgSetClipboard(seq, true, text))) {
        railNote('ok', 'pasting ' + text.length + ' characters to the phone…');
      }
    }).catch(function (err) {
      railNote('error', 'the browser refused to read the clipboard: ' + msg(err));
    });
  }

  function copyFromPhone() {
    if (sendControl(msgGetClipboard(COPY_KEY_COPY))) {
      railNote('', 'asked the phone to copy…');
    }
  }

  /* ==================================================================== */
  /* 9. The rail                                                          */
  /* ==================================================================== */

  function tap(keycode, label) {
    return function () {
      if (sendControl(msgInjectKeycode(KEY_DOWN, keycode, 0, 0), label)) {
        sendControl(msgInjectKeycode(KEY_UP, keycode, 0, 0));
      }
    };
  }

  var RAIL_BUTTONS = [
    { label: 'Back', run: function () {
      if (sendControl(msgBackOrScreenOn(KEY_DOWN), 'back')) sendControl(msgBackOrScreenOn(KEY_UP));
    } },
    { label: 'Home', run: tap(AKEYCODE.HOME, 'home') },
    { label: 'Recents', run: tap(AKEYCODE.APP_SWITCH, 'recents') },
    { label: 'Power', run: tap(AKEYCODE.POWER, 'power') },
    { label: 'Vol +', run: tap(AKEYCODE.VOLUME_UP, 'volume up') },
    { label: 'Vol −', run: tap(AKEYCODE.VOLUME_DOWN, 'volume down') },
    { label: 'Rotate', run: function () { sendControl(msgEmpty(CTL.ROTATE_DEVICE), 'rotate'); } },
    { label: 'Notifs', run: function () { sendControl(msgEmpty(CTL.EXPAND_NOTIFICATION_PANEL), 'notifications'); } },
    { label: 'Screen off', run: function () { sendControl(msgSetDisplayPower(false), 'screen off'); } },
    { label: 'Screen on', run: function () { sendControl(msgSetDisplayPower(true), 'screen on'); } },
    { label: 'Copy ← phone', run: copyFromPhone },
    { label: 'Paste → phone', run: pasteToPhone },
    { label: 'Screenshot', wide: true, run: screenshot },
    { label: 'Mute', wide: true, id: 'mute', run: toggleMute }
  ];

  function buildRail() {
    var keys = els.railKeys;
    if (!keys) return;
    keys.textContent = '';
    RAIL_BUTTONS.forEach(function (spec) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rail-btn' + (spec.wide ? ' wide' : '');
      b.textContent = spec.label;
      b.addEventListener('click', function () { spec.run(); });
      if (spec.id) els['btn_' + spec.id] = b;
      keys.appendChild(b);
    });
  }

  function toggleMute() {
    if (audio.unavailable) {
      /* There is nothing to mute: say why, every time it is pressed. */
      railNote('error', 'there is no audio to mute: ' + audio.reason);
      return;
    }
    audio.muted = !audio.muted;
    if (audio.gain) audio.gain.gain.value = audio.muted ? 0 : 1;
    if (audio.muted) { resetAudio(); audio.playAt = 0; }
    setMuteButton();
    railNote('ok', audio.muted ? 'audio muted (nothing is decoded while muted)' : 'audio on');
    renderReadouts();
  }

  /* The button never lies about what it would do: when the phone could not
     capture audio at all it says so on its face, with the reason on hover. */
  function setMuteButton() {
    var b = els.btn_mute;
    if (!b) return;
    if (audio.unavailable) {
      b.textContent = 'No audio';
      b.title = 'the phone is sending no audio: ' + audio.reason;
      b.dataset.on = '0';
      return;
    }
    b.textContent = audio.muted ? 'Unmute' : 'Mute';
    b.title = audio.muted ? 'audio is muted' : 'mute the phone audio';
    b.dataset.on = audio.muted ? '1' : '0';
  }

  function screenshot() {
    if (!video.painted) { railNote('error', 'nothing has been painted yet: there is no picture to copy'); return; }
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      railNote('error', 'this page cannot write images to the clipboard (no ClipboardItem)');
      return;
    }
    els.canvas.toBlob(function (blob) {
      if (!blob) { railNote('error', 'the canvas produced no PNG'); return; }
      navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]).then(function () {
        railNote('ok', 'screenshot copied (' + fmtBytes(blob.size) + ')');
      }).catch(function (err) {
        railNote('error', 'the browser refused the image clipboard: ' + msg(err));
      });
    }, 'image/png');
  }

  /* ==================================================================== */
  /* 10. Layout, the once-a-second tick, visibility                       */
  /* ==================================================================== */

  function layoutFrame() {
    if (!els.stage || !els.frame) return;
    var availW = els.stage.clientWidth - 32;     // the stage's 16px padding
    var availH = els.stage.clientHeight - 32;
    if (availW <= 0 || availH <= 0) return;
    var aspect = (video.w && video.h) ? (video.w / video.h) : (9 / 20);
    var w = availW;
    var h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    els.frame.style.width = Math.max(60, Math.floor(w)) + 'px';
    els.frame.style.height = Math.max(60, Math.floor(h)) + 'px';
  }

  var lastTick = { at: 0, painted: 0, bytes: 0, skipped: 0 };

  function tick() {
    var now = performance.now();
    if (lastTick.at) {
      var dt = (now - lastTick.at) / 1000;
      video.fps = Math.round((video.painted - lastTick.painted) / dt);
      video.kbps = Math.round(((video.bytes - lastTick.bytes) * 8 / 1000) / dt);
      /* Frames decoding but nothing painting means requestAnimationFrame is
         not running: the window is occluded or minimised. Chromium does that
         on purpose, but it must not look like a dead stream. */
      if (video.skipped > lastTick.skipped && video.painted === lastTick.painted) {
        video.note = 'frames are arriving and decoding, but this window is not painting (occluded or minimised)';
      }
    }
    lastTick.at = now;
    lastTick.painted = video.painted;
    lastTick.bytes = video.bytes;
    lastTick.skipped = video.skipped;
    renderReadouts();
    renderStatus();
  }

  function onVisibility() {
    video.paused = document.hidden;
    if (document.hidden) {
      video.note = 'the tab is hidden: decoding is paused';
    } else {
      video.needKey = true;
      video.note = 'the tab is visible again: waiting for the next key frame';
      /* Ask the server for a fresh key frame instead of waiting for its
         next one — RESET_VIDEO is a single byte (ControlMessage.java 17). */
      if (wire.ws && wire.ws.readyState === 1 && phone && phone.stream && phone.stream.state === 'running') {
        try {
          var out = new Uint8Array(2);
          out[0] = CH_CONTROL;
          out[1] = CTL.RESET_VIDEO;
          wire.ws.send(out);
        } catch (err) { video.note = 'could not ask for a new key frame: ' + msg(err); }
      }
    }
    renderReadouts();
  }

  /* ==================================================================== */
  /* 11. Bootstrap                                                        */
  /* ==================================================================== */

  function applyState(state) {
    if (!state) return;
    phone = state;
    renderStatus();
    renderReadouts();
  }

  /* main's answer to `phone:hello` and every later push. { ws, state }: ws is
     the token-bearing WebSocket URL (first call only), state the phone.js
     state. Stays live even in self-test mode, so the page can be handed a
     harness WebSocket from the outside. */
  window.__applyPhone = function (data) {
    answered = true;
    statusLocked = false;      // a real state always outranks a self-test verdict
    var d = data || {};
    if (d.ws && d.ws !== wire.url) {
      wire.url = String(d.ws);
      connectWire(true);
    }
    if (d.state) applyState(d.state);
    else if (!d.ws) setStatus('error', 'the browser answered without a state or a ws address', '', null);
    renderStatus();
    return true;
  };

  document.addEventListener('DOMContentLoaded', function () {
    els.dot = $('status-dot');
    els.text = $('status-text');
    els.sub = $('status-sub');
    els.action = $('status-action');
    els.stage = $('stage');
    els.frame = $('frame');
    els.canvas = $('screen');
    els.note = $('frame-note');
    els.rail = $('rail');
    els.pill = $('rail-pill');
    els.railKeys = $('rail-keys');
    els.railNote = $('rail-note');
    els.read = $('rail-read');
    els.ctx = els.canvas.getContext('2d', { alpha: false, desynchronized: true });

    els.action.addEventListener('click', function () {
      if (statusAction && statusAction.run) statusAction.run();
    });

    buildRail();
    setMuteButton();
    buildReadouts();
    bindInput();
    layoutFrame();
    if (window.ResizeObserver) new ResizeObserver(layoutFrame).observe(els.stage);
    else window.addEventListener('resize', layoutFrame);
    document.addEventListener('visibilitychange', onVisibility);
    video.paused = document.hidden;   // the tab can already be in the background
    setInterval(tick, 1000);

    if (SELFTEST) {
      runSelfTest();
      return;
    }

    renderStatus();
    /* The bootstrap line phone.js listens for on this guest's console. */
    console.log('phone:hello');
    setTimeout(function () {
      if (answered) return;
      bootTimedOut = true;
      renderStatus();
    }, 2000);
  });

  /* ==================================================================== */
  /* 12. Self-test: ?selftest=1                                           */
  /* ==================================================================== */
  /* Proves the page end to end with no phone and no browser: it encodes a
     synthetic clip with WebCodecs, wraps the chunks as scrcpy packets, and
     pushes them through onBinary() — the SAME path a real stream takes — then
     checks the paint counter and the canvas. It also serialises one of every
     control message and compares it with the bytes the scrcpy v4.1 reference
     tests expect. */

  function hexOf(bytes) {
    return Array.prototype.map.call(bytes, function (b) {
      return (b < 16 ? '0' : '') + b.toString(16);
    }).join('');
  }

  function expectBytes(name, got, want) {
    if (got.length !== want.length) {
      throw new Error(name + ': ' + got.length + ' bytes, expected ' + want.length);
    }
    for (var i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) {
        throw new Error(name + ': byte ' + i + ' is 0x' + got[i].toString(16) +
          ', expected 0x' + want[i].toString(16) + ' (got ' + hexOf(got) + ')');
      }
    }
  }

  function selfTestControlMessages() {
    /* Every expectation below is copied from test_control_msg_serialize.c
       (scrcpy v4.1); the comments name the test it came from. */
    expectBytes('inject_keycode', msgInjectKeycode(KEY_UP, AKEYCODE.ENTER, 5, 0x41),
      [0, 0x01, 0, 0, 0, 0x42, 0, 0, 0, 0x05, 0, 0, 0, 0x41]);

    expectBytes('inject_text', msgInjectText('hello, world!'),
      [1, 0, 0, 0, 0x0d, 104, 101, 108, 108, 111, 44, 32, 119, 111, 114, 108, 100, 33]);

    expectBytes('inject_touch_event',
      msgInjectTouch(TOUCH_DOWN, BigInt('0x1234567887654321'), 100, 200, 1080, 1920, 1.0, 1, 1),
      [2, 0x00, 0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21,
        0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8,
        0x04, 0x38, 0x07, 0x80, 0xff, 0xff,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]);

    expectBytes('inject_scroll_event', msgInjectScroll(260, 1026, 1080, 1920, 16, -16, 1),
      [3, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x04, 0x02,
        0x04, 0x38, 0x07, 0x80, 0x7f, 0xff, 0x80, 0x00,
        0x00, 0x00, 0x00, 0x01]);

    expectBytes('back_or_screen_on', msgBackOrScreenOn(KEY_UP), [4, 0x01]);
    expectBytes('expand_notification_panel', msgEmpty(CTL.EXPAND_NOTIFICATION_PANEL), [5]);
    expectBytes('get_clipboard', msgGetClipboard(COPY_KEY_COPY), [8, 1]);

    expectBytes('set_clipboard', msgSetClipboard(BigInt('0x0102030405060708'), true, 'hello, world!'),
      [9, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 1, 0x00, 0x00, 0x00, 0x0d,
        104, 101, 108, 108, 111, 44, 32, 119, 111, 114, 108, 100, 33]);

    expectBytes('set_display_power', msgSetDisplayPower(true), [10, 0x01]);
    expectBytes('rotate_device', msgEmpty(CTL.ROTATE_DEVICE), [11]);

    /* The mouse's pointer id, from Controller.java (POINTER_ID_MOUSE = -1). */
    var mouse = msgInjectTouch(TOUCH_UP, POINTER_ID_MOUSE, 1, 2, 720, 1600, 0, 1, 0);
    expectBytes('pointer_id_mouse', mouse.subarray(2, 10),
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    if (mouse.length !== 32) throw new Error('inject_touch_event (mouse): ' + mouse.length + ' bytes');
    void COPY_KEY_NONE;
    return 10 + 1;
  }

  /* Builds a scrcpy packet: the 12-byte header (u64 BE ptsAndFlags, u32 BE
     size) then the payload, with the channel byte in front. */
  function packet(channel, payload, opts) {
    var o = opts || {};
    var out = new Uint8Array(1 + 12 + payload.length);
    var view = new DataView(out.buffer, 1);
    out[0] = channel;
    var hi = 0;
    if (o.config) hi |= 0x40000000;
    else if (o.key) hi |= 0x20000000;
    view.setUint32(0, hi >>> 0);
    view.setUint32(4, (o.pts || 0) >>> 0);
    view.setUint32(8, payload.length);
    out.set(payload, 13);
    return out.buffer;
  }

  function sessionPacket(w, h) {
    var out = new Uint8Array(13);
    var view = new DataView(out.buffer, 1);
    out[0] = CH_VIDEO;
    out[1] = 0x80;                 // the session packet flag
    view.setUint32(4, w);
    view.setUint32(8, h);
    return out.buffer;
  }

  /* Splits an Annex B key chunk into (SPS/PPS..., the coded picture), so the
     test can send a real scrcpy-shaped config packet. */
  function splitAnnexB(bytes) {
    for (var i = 0; i + 4 < bytes.length; i++) {
      if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
      var off = bytes[i + 2] === 1 ? 3 : (bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0);
      if (!off) continue;
      var type = bytes[i + off] & 0x1f;
      if (type >= 1 && type <= 5) {              // the first VCL NAL
        if (i === 0) return null;
        return { config: bytes.subarray(0, i), frame: bytes.subarray(i) };
      }
      i += off - 1;
    }
    return null;
  }

  function selfTestFinish(ok, reason) {
    if (ok) {
      console.log('phone:selftest ok');
      setStatus('ok', 'phone:selftest ok', 'no phone needed: encoder → scrcpy packets → decoder → canvas', null);
      setFrameNote('');
    } else {
      console.log('phone:selftest fail ' + reason);
      setStatus('error', 'phone:selftest fail ' + reason, '', null);
      setFrameNote('self-test failed:\n' + reason);
    }
    window.__phoneSelfTest = { done: true, ok: !!ok, reason: ok ? '' : reason, painted: video.painted };
  }

  function runSelfTest() {
    statusLocked = true;
    setStatus('busy', 'self-test running…', 'encoding a synthetic clip', null);
    setFrameNote('self-test running…');
    window.__phoneSelfTest = { done: false, ok: false, reason: '', painted: 0 };

    var checks = 0;
    try {
      checks = selfTestControlMessages();
    } catch (err) {
      selfTestFinish(false, 'control messages: ' + msg(err));
      return;
    }

    if (!window.VideoEncoder || !window.VideoDecoder) {
      selfTestFinish(false, 'this build has no WebCodecs VideoEncoder/VideoDecoder');
      return;
    }

    var W = 720, H = 1600, COUNT = 90;
    var chunks = [];
    var encoderError = '';
    var enc;

    /* The self-test drives the same decoder the live stream does, so make
       sure a hidden tab (a background test window) does not pause it. */
    video.selftest = true;
    video.painted = 0; video.dropped = 0; video.skipped = 0; video.bytes = 0;
    video.config = null;
    resetDecoder('self-test starting');

    function pickCodec() {
      /* The brief's codec first; if this build's encoder will not take a
         720x1600 baseline stream, fall back to High and say which was used. */
      var candidates = ['avc1.42001f', 'avc1.640028'];
      var i = 0;
      function next() {
        if (i >= candidates.length) return Promise.resolve(null);
        var c = candidates[i++];
        return window.VideoEncoder.isConfigSupported({
          codec: c, width: W, height: H, bitrate: 2000000, framerate: 30
        }).then(function (res) {
          return (res && res.supported) ? c : next();
        }).catch(function () { return next(); });
      }
      return next();
    }

    pickCodec().then(function (codec) {
      if (!codec) throw new Error('no H.264 encoder configuration was supported');
      enc = new window.VideoEncoder({
        output: function (chunk) {
          var data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ key: chunk.type === 'key', data: data, ts: chunk.timestamp });
        },
        error: function (err) { encoderError = msg(err); }
      });
      enc.configure({
        codec: codec,
        width: W, height: H,
        bitrate: 2000000,
        framerate: 30,
        latencyMode: 'realtime',
        avc: { format: 'annexb' }
      });

      var src = document.createElement('canvas');
      src.width = W; src.height = H;
      var sctx = src.getContext('2d');
      for (var i = 0; i < COUNT; i++) {
        sctx.fillStyle = '#10171f';
        sctx.fillRect(0, 0, W, H);
        sctx.fillStyle = '#8fd0ff';
        sctx.fillRect(40 + ((i * 7) % (W - 200)), 120 + ((i * 23) % (H - 340)), 160, 220);
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, (i * 17) % H, W, 8);
        var frame = new window.VideoFrame(src, { timestamp: i * 33333 });
        enc.encode(frame, { keyFrame: i === 0 || i === 45 });
        frame.close();
      }
      return enc.flush();
    }).then(function () {
      try { enc.close(); } catch (err) { /* already closed */ }
      if (encoderError) throw new Error('the encoder failed: ' + encoderError);
      if (chunks.length < COUNT) throw new Error('the encoder produced ' + chunks.length + ' of ' + COUNT + ' chunks');

      var split = splitAnnexB(chunks[0].data);
      if (!split) throw new Error('the first chunk carried no SPS/PPS in front of the picture');

      /* Build the packet list exactly as the relay would hand it over. */
      var packets = [sessionPacket(W, H), packet(CH_VIDEO, split.config, { config: true })];
      packets.push(packet(CH_VIDEO, split.frame, { key: true, pts: chunks[0].ts }));
      for (var i = 1; i < chunks.length; i++) {
        packets.push(packet(CH_VIDEO, chunks[i].data, { key: chunks[i].key, pts: chunks[i].ts }));
      }

      setStatus('busy', 'self-test running…', chunks.length + ' encoded frames → the live decode path', null);

      return new Promise(function (resolve) {
        var n = 0;
        /* 25 ms between packets (40 fps) leaves room under a 60 Hz
           requestAnimationFrame for every frame to reach the screen; feeding
           faster than the display only measures how many frames get skipped. */
        var timer = setInterval(function () {
          if (n >= packets.length) {
            clearInterval(timer);
            /* Let the decoder drain and the last frames paint. */
            setTimeout(resolve, 700);
            return;
          }
          onBinary(packets[n++]);
        }, 25);
      });
    }).then(function () {
      if (video.painted < 80) {
        throw new Error('only ' + video.painted + ' of ' + COUNT + ' frames painted' +
          (video.err ? ' (' + video.err + ')' : '') + ' [dropped ' + video.dropped +
          ', skipped ' + video.skipped + ']');
      }
      /* Not black: scale the canvas down and count lit samples. */
      var small = document.createElement('canvas');
      small.width = 32; small.height = 64;
      var sctx = small.getContext('2d');
      sctx.drawImage(els.canvas, 0, 0, 32, 64);
      var data = sctx.getImageData(0, 0, 32, 64).data;
      var lit = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 24) lit++;
      }
      if (lit < 100) throw new Error('the canvas is black (' + lit + ' of 2048 samples lit)');
      video.selftest = false;
      selfTestFinish(true, '');
      railNote('ok', checks + ' control messages match the reference bytes · ' +
        video.painted + ' frames painted');
    }).catch(function (err) {
      video.selftest = false;
      selfTestFinish(false, msg(err));
    });
  }
})();
