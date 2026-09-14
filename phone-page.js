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
    MOVE_HOME: 122, MOVE_END: 123,
    /* KEYCODE_WAKEUP (Android KeyEvent, API 20+). The ONE thing that wakes a
       dozing phone from here: SET_DISPLAY_POWER cannot (measured 2026-09-13). */
    WAKEUP: 224
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
  /* The decode queue is allowed to run DEEP before anything is thrown away:
     dropping a delta costs the picture up to a whole key-frame interval
     (~10 s from scrcpy), so a queue of a dozen frames is far cheaper than a
     drop. It also has to be OVER the limit on DROP_AFTER_BEHIND packets in a
     row: one late frame is a hiccup, several is a decoder that cannot keep up. */
  var DECODE_QUEUE_LIMIT = 12;
  var DROP_AFTER_BEHIND = 2;      // consecutive over-limit packets before dropping
  var STILL_AFTER_MS = 3000;      // after this much quiet the status says "still N s"
  var KEY_FRAME_GAP_MS = 500;     // at most one RESET_VIDEO per this
  var SHED_WINDOW_MS = 2000;      // still behind this soon after a key frame = too slow
  var SHED_GAP_MS = 5000;         // and never ask main to turn the load down faster than this
  var HEAL_CLEAN_MS = 30000;      // keeping up this long = ask for the shed quality back (once)
  /* A decoder's FIRST frames include its own start-up: opening the GPU video
     device, allocating textures. MEASURED 2026-09-13 on the user's laptop: the
     first output after configure() took 30-200 ms where the steady state is
     0.6 ms, and while that was happening the chunks behind it piled up — which
     is enough to trip the drop/shed logic below and pin the stream at 30 fps
     and 800 px for good. So the queue is not judged until this decoder has
     returned its first frame — and never for longer than this, in case it
     never returns one at all. */
  var DECODER_WARMUP_MS = 2500;
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
  /* Which H.264 decoder to ask WebCodecs for. ?decoder=software|hardware|auto
     on the page URL wins (an experiment), then localStorage 'phoneDecoder'
     (a choice that sticks), else the default below.
     MEASURED 2026-09-13 on the user's laptop against the real phone — 560×1280
     h264 at 8 Mb/s, 60 fps cap, a 4 s drag on the launcher, the browser window
     on screen, two runs each, numbers from the middle 2.5 s of each drag:
         prefer-hardware   decode 0.6-0.9 ms   queue 0    dropped 0
         prefer-software   decode 1.9-3.3 ms   queue 0-2  dropped 0
         no-preference     decode 0.6-0.8 ms   queue 0    dropped 0   (= hardware)
     All three kept up with 58-60 frames a second; hardware costs a third of
     what software does per frame and never queued, so it is the default and
     'auto' lands on it anyway. The one thing hardware does cost is start-up:
     its first frame after configure() is tens of ms (see DECODER_WARMUP_MS),
     which is what used to trip the shed below and pin the stream at 30 fps.
     NOT measured: whether a different GPU/driver would change this order. */
  var DECODER_PREF = (function () {
    var want = (params && params.get('decoder')) || '';
    if (!want) { try { want = window.localStorage.getItem('phoneDecoder') || ''; } catch (err) { want = ''; } }
    if (want === 'software') return 'prefer-software';
    if (want === 'hardware') return 'prefer-hardware';
    if (want === 'auto') return 'no-preference';
    return 'prefer-hardware';
  })();
  try { window.__phoneDecoderPref = DECODER_PREF; } catch (err) { /* readout only */ }

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
    rafs: 0,                 // requestAnimationFrame callbacks seen: the screen's own clock
    screenHz: 0,             // ...per second. 0 while the window is not presenting at all
    drawnSinceRaf: 0,        // draws since the last callback, to count what the screen never showed
    lastArrivalAt: 0,        // performance.now() of the last video packet off the wire
    painted: 0, dropped: 0, skipped: 0,
    bytes: 0,
    fps: 0, kbps: 0,
    lastPaintAt: 0,
    err: '',
    note: 'waiting for the first frame',
    paused: false,
    selftest: false,
    behind: 0,               // consecutive packets found with the queue over the limit
    keyAsked: 0,             // RESET_VIDEO requests that actually went out
    keyAt: 0,                // when the last one did (rate limit)
    keyFail: '',             // why the last one could not be sent, in words
    accel: 'prefer-hardware',// what the decoder was configured with
    accelFell: '',           // why it fell back to software, if it did
    decodeMs: 0,             // decode -> output, EWMA (steady state, start-up excluded)
    decoderAt: 0,            // when the current decoder was configured
    firstOut: true,          // the next output is this decoder's first
    initMs: 0,               // what that first frame cost: the decoder's start-up
    sentAt: null,            // pts -> performance.now() at decode(), for that number
    notPainting: false,      // frames decoding but nothing reaching the screen
    /* "The screen is just black." A phone whose display is asleep composites
       nothing, so the mirror is a live, perfectly black picture: frames keep
       arriving, the decoder is happy, and nothing says why. blackSince is when
       the picture went black (0 = it is not), blackMax the brightest channel
       found in the last sample, blackErr why the sample could not be taken. */
    blackSince: 0, blackMax: 255, blackErr: '', blackNoteOn: false
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

  /* Turning the load down when this machine's decoder simply cannot keep up
     with what the phone is sending. Asking for a key frame fixes a hiccup;
     asking again and again means the stream is too heavy, and the answer is
     fewer frames (then a smaller picture), not a faster loop. */
  var shed = {
    at: 0, step: 0, note: '',
    was: {},            // what the stream was set to before this page turned it down
    dropAt: 0,          // video.dropped when it last shed: no new drops = keeping up
    cleanSince: 0,      // performance.now() since when it has been keeping up
    healed: false       // the one restore attempt this page is allowed
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

    /* 3. the master switch, ahead of everything it turns off. Nothing below is
       true while the phone link is off, and there is exactly one way out. */
    if (linkIsOff()) {
      setStatus('off', 'phone link is off',
        'nothing is connected and no adb is running until it is switched back on',
        { label: 'Open Settings → Phone', run: function () { runCommand('open-settings'); } });
      setFrameNote('the phone link is turned off in Settings → Phone');
      return;
    }

    /* 4. tools -> device -> stream, in the order they must be satisfied */
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

    /* running (and a legacy 'stalled' from an older phone.js, which this page
       now treats as running): the page's own view of the picture decides.

       A STILL SCREEN IS NOT A STALL. scrcpy's server encodes a frame only when
       the display CHANGES, so a phone resting on its home screen sends nothing
       at all for minutes — and that is the stream working perfectly. So once a
       frame has painted, the picture is NEVER covered again and silence alone
       never warns: stillness is said quietly, in the sub-line and in the
       frame-age readout. The overlay belongs to the states before a picture
       exists, and Restart belongs to 'off' and 'error' (above). */
    if (!video.lastPaintAt) {
      setStatus('warn', 'no frames yet', s.reason || video.err || video.note, null);
      setFrameNote('no frames yet.\n' + (s.reason || video.err || video.note || ''));
      return;
    }

    var still = stillMs();
    var sub = '';
    /* The still marker goes FIRST: the sub-line is ellipsised from the right
       in a narrow tab, and "still 12 s" is the part worth keeping. */
    if (still > STILL_AFTER_MS) sub += 'still ' + fmtAge(still) + ' · ';
    sub += video.fps + ' fps · ' + video.kbps + ' kbps';
    if (video.decodeMs) sub += ' · decode ' + video.decodeMs.toFixed(1) + ' ms';
    if (shed.note) sub += ' · ' + shed.note;
    if (video.notPainting) sub += ' · this window is not painting (occluded or minimised)';
    if (video.err) sub += ' · ' + video.err;
    setStatus('ok', 'mirroring ' + video.w + '×' + video.h, sub, null);
    /* The black-picture note is the one overlay that belongs OVER a running
       stream: a black picture with no words was exactly what the user saw at his
       sign-in screen on 2026-09-13, because this line wiped the note a
       second after checkBlackPicture() had set it. */
    if (!video.blackNoteOn) setFrameNote('');
  }

  /* How long the picture has been unchanged, in ms. phone.js reports
     stream.lastVideoAt (epoch ms: the last video packet off the phone's
     socket), which is the truth about the WIRE; this page's lastPaintAt is the
     truth about the SCREEN, in performance.now()'s clock.
     Main's number only arrives inside a pushed state, and those are debounced,
     so during a fast scene it is stale by however long ago the last push was:
     MEASURED 2026-09-13, it read 360-500 ms while 58 frames a second were
     actually landing, which looks like half a second of lag and is not. This
     page sees every packet itself, so its own arrival clock is the newer,
     truer number whenever the two disagree; main's still covers the case where
     this page is decoding nothing on purpose (a hidden tab), so the two are
     combined rather than swapped. */
  function stillMs() {
    var s = (phone && phone.stream) || {};
    var mine = video.lastArrivalAt ? Math.max(0, performance.now() - video.lastArrivalAt) : Infinity;
    var theirs = (typeof s.lastVideoAt === 'number' && s.lastVideoAt > 0)
      ? Math.max(0, Date.now() - s.lastVideoAt) : Infinity;
    if (video.paused) return theirs;          // decoding nothing: only the wire knows
    var best = Math.min(mine, theirs);
    if (isFinite(best)) return best;
    return video.lastPaintAt ? Math.max(0, performance.now() - video.lastPaintAt) : Infinity;
  }

  function fmtAge(ms) {
    if (!isFinite(ms)) return 'never';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 90000) return Math.floor(ms / 1000) + ' s';
    return Math.floor(ms / 60000) + ' min';
  }

  /* Bitrates come off the wire in bits per second (scrcpy's video_bit_rate). */
  function fmtRate(bps) {
    if (!bps) return '—';
    if (bps >= 1000000) return (bps / 1000000).toFixed(bps % 1000000 ? 1 : 0) + ' Mbps';
    return Math.round(bps / 1000) + ' kbps';
  }

  /* ==================================================================== */
  /* 5. Readouts                                                          */
  /* ==================================================================== */

  /* Two round trips, and they measure different things: 'phone rtt' is what
     phone.js measures over adb (this machine → the phone → back), 'browser
     rtt' is this page's own ping to the relay in the main process. Labelling
     both "latency" is how the first live pass was misread. */
  var READOUT_ROWS = [
    ['device', 'device'],
    ['battery', 'battery'],
    ['phone', 'phone rtt'],
    ['rtt', 'browser rtt'],
    ['fps', 'fps'],
    ['kbps', 'kbps'],
    ['decoder', 'decoder'],
    ['decodems', 'decode time'],
    ['queue', 'decode queue'],
    ['dropped', 'dropped'],
    ['keyframes', 'key frames asked'],
    ['age', 'frame age'],
    ['profile', 'profile · bitrate'],
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
      dt.title = row[1];               // the rail is narrow: a clipped label still hovers
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
    readout('phone', typeof d.latencyMs === 'number' ? d.latencyMs + ' ms' : '—', '',
      'phone rtt: what phone.js measures over adb — this machine to the phone and back');
    readout('rtt', wire.rtt === null ? (wire.state === 'open' ? 'waiting' : 'no link') : wire.rtt + ' ms',
      wire.state === 'open' ? '' : 'error',
      'browser rtt: this page to the relay in the browser and back over the WebSocket');
    readout('fps', String(video.fps), video.notPainting ? 'warn' : (video.fps > 0 ? 'ok' : ''),
      'frames painted in the last second — 0 on a still screen is normal. ' +
      (video.notPainting
        ? 'The screen itself is not being composited (occluded, minimised or asleep), so none of them are reaching it.'
        : 'The screen is being composited at ' + video.screenHz + ' Hz, which is the ceiling on this number.'));
    readout('kbps', String(video.kbps));
    readout('decoder', !video.dec ? 'not built yet'
        : (video.accelFell ? 'auto (fallback)' : { 'prefer-hardware': 'hardware', 'prefer-software': 'software', 'no-preference': 'auto' }[video.accel] || video.accel),
      video.accelFell ? 'warn' : '',
      video.accelFell
        ? 'fell back to no-preference: ' + video.accelFell
        : 'configured with hardwareAcceleration: ' + (video.accel || DECODER_PREF)
          + ' (WebCodecs does not report which one Chromium then picked; ?decoder=software|hardware|auto or localStorage phoneDecoder overrides)');
    readout('decodems', video.decodeMs ? video.decodeMs.toFixed(1) + ' ms' : '—',
      video.decodeMs > 16 ? 'warn' : '',
      'decode() to the decoded frame, smoothed — above ~16 ms the decoder cannot hold 60 fps.' +
      (video.initMs ? ' This decoder\'s first frame took ' + video.initMs.toFixed(0) +
        ' ms (its own start-up) and is left out of the average.' : ''));
    readout('queue', video.dec ? String(video.dec.decodeQueueSize) : 'no decoder',
      video.dec ? (video.dec.decodeQueueSize > DECODE_QUEUE_LIMIT ? 'warn' : '') : 'warn',
      'frames handed to the decoder and not yet back (limit ' + DECODE_QUEUE_LIMIT + ')');
    readout('dropped', video.dropped + (video.skipped ? ' (+' + video.skipped + ' skipped)' : ''),
      video.dropped ? 'warn' : '',
      'dropped: deltas thrown away because the decoder was behind. skipped: frames painted but ' +
      'replaced by a newer one before the screen was composited again (that one is harmless — ' +
      'the phone sent two frames inside one screen refresh).');
    readout('keyframes', String(video.keyAsked) + (video.keyFail ? ' · failed' : ''),
      video.keyFail ? 'warn' : '',
      video.keyFail || (video.keyAsked
        ? video.keyAsked + ' RESET_VIDEO requests: after a drop, a decoder reset or a reconnect, ' +
          'rather than waiting up to 10 s for scrcpy\'s own key frame'
        : 'no key frame has had to be asked for'));
    var age = stillMs();
    readout('age', isFinite(age) ? fmtAge(age) : '—', '',
      'how long since the last frame. A still screen sends nothing at all — that is scrcpy ' +
      'encoding only what changes, not a stall.');
    var want = (phone && phone.settings) ? phone.settings.profile : '';
    var prof = s.profile ? ((want && want !== s.profile) ? want + ' → ' + s.profile : s.profile) : '';
    readout('profile', prof ? (prof + ' · ' + fmtRate(s.bitrate || 0)) : '—', '',
      prof ? (prof + ' · ' + fmtRate(s.bitrate || 0) + ' · at most ' + (s.maxSize || '?') +
        ' px and ' + (s.maxFps || '?') + ' fps') : 'no stream');
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
      /* A reconnect lost whatever was in flight. If main still says the stream
         is running, ask for a key frame rather than sit on a frozen picture
         until scrcpy's next one. */
      requestKeyFrame('the link to the browser reopened');
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
      if (done) { wire.pending.delete(m.id); done(m); return; }
      /* A result nobody is waiting for is NOT noise: phone.js answers a binary
         control frame it could not write with { id: 0, ok: false, reason }
         (there is no control socket, or the channel was refused). Dropping it
         is how a rail button came to look like it worked while the bytes went
         nowhere — so an unmatched failure is always said out loud. */
      if (m.ok === false) railNote('error', 'the browser could not pass that to the phone: ' + (m.reason || 'no reason given'));
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
  /* The master switch in Settings → Phone. While it is off there is no stream,
     no adb and nothing to press; the page says so rather than looking broken. */
  var LINK_OFF_TEXT = 'the phone link is turned off in Settings → Phone';

  function linkIsOff() {
    return !!(phone && phone.settings && phone.settings.enabled === false);
  }

  function sendControl(bytes, what) {
    if (linkIsOff()) {
      railNote('error', (what || 'that') + ' went nowhere: ' + LINK_OFF_TEXT);
      return false;
    }
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

  /* A key frame, please — now, not in ten seconds.

     scrcpy's encoder only emits a key frame every ~10 s, so the moment a delta
     is thrown away the picture freezes until the next one. RESET_VIDEO
     (ControlMessage.java v4.1: type 17, empty payload) asks the server for a
     fresh one immediately. It deliberately does NOT go through sendControl:
     this is housekeeping, not something the user did, so it writes no rail note
     when it works. It speaks up only when it CANNOT ask, and the count is
     always in the readouts either way.

     `why` names the caller in that failure sentence. Returns true if a request
     actually went out. */
  function requestKeyFrame(why) {
    var st = (phone && phone.stream) || {};
    /* No stream, nothing to refresh — and the status strip is already saying
       that in words. A non-event, not a failure. */
    if (st.state !== 'running' && st.state !== 'stalled') return false;
    var now = performance.now();
    if (video.keyAt && (now - video.keyAt) < KEY_FRAME_GAP_MS) return false;

    var reason = '';
    if (!wire.ws || wire.ws.readyState !== 1) {
      reason = 'the link to the browser is ' + (wire.state || 'closed');
    } else {
      try {
        var out = new Uint8Array(2);
        out[0] = CH_CONTROL;
        out[1] = CTL.RESET_VIDEO;
        wire.ws.send(out);
      } catch (err) {
        reason = msg(err);
      }
    }
    if (reason) {
      video.keyFail = why + ': could not ask for a key frame — ' + reason;
      video.note = video.keyFail;
      renderReadouts();
      return false;
    }
    video.keyAt = now;
    video.keyAsked++;
    video.keyFail = '';
    renderReadouts();
    return true;
  }

  /* Still behind straight after a key-frame request? Then the stream is heavier
     than this machine can decode, and asking for key frames forever would just
     stutter. Ask main to send less: fewer frames first (the cheapest loss),
     then a smaller picture. Once per step, never faster than SHED_GAP_MS, and
     the reason is written into the status sub-line so it is never a mystery
     why the phone suddenly looks different. */
  function shedLoad() {
    var s = (phone && phone.stream) || {};
    var now = Date.now();
    if (now - shed.at < SHED_GAP_MS) return;
    shed.at = now;

    var fps = s.maxFps || (phone && phone.settings && phone.settings.maxFps) || 0;
    var size = s.maxSize || (phone && phone.settings && phone.settings.maxSize) || 0;

    /* What it was before this page turned it down. set-settings is PERSISTED
       by phone.js, so without this the stream stays at whatever a bad minute
       shed it to — for ever, across restarts. (That is exactly how the user's
       phone ended up pinned at 30 fps and 800 px on 2026-09-13: one cold
       hardware decoder, two sheds, and no way back.) */
    shed.dropAt = video.dropped;
    shed.cleanSince = 0;

    if (shed.step === 0 && (!fps || fps > 30)) {
      shed.step = 1;
      if (fps) shed.was.maxFps = fps;
      shed.note = 'the decoder is too slow at ' + (fps || 'this') + ' fps — asked the phone for 30';
      askLess({ maxFps: 30 });
    } else if (shed.step <= 1 && (!size || size > 800)) {
      shed.step = 2;
      if (size) shed.was.maxSize = size;
      shed.note = 'the decoder is still too slow at 30 fps — asked the phone for a smaller picture (800 px)';
      askLess({ maxSize: 800 });
    } else {
      shed.step = 3;
      shed.note = 'the decoder is still behind at ' + (fps || '?') + ' fps and ' + (size || '?') +
        ' px — there is nothing left to turn down from here';
    }
    renderStatus();
  }

  /* The way back up. A shed is cheap insurance against a stuttering minute,
     but phone.js PERSISTS what it is asked for, so a shed that is never undone
     is a permanent downgrade of the user's picture bought by one bad minute — and
     the commonest bad minute is a decoder's own cold start. So: once per page,
     after HEAL_CLEAN_MS of genuinely keeping up (a decoder that exists, a
     shallow queue and not one dropped frame since the shed), ask for exactly
     what this page turned down, and say so. If the machine really cannot hold
     it, the next shed takes it back down and `healed` stops it happening again
     — no oscillation, at most one round trip. */
  function healShed(now) {
    /* Deliberately NOT keyed on shed.step: a shed restarts the stream, and the
       restart passes through 'off', which resets the step (applyState) — so
       what a page remembers having turned down is shed.was, and that is what
       decides whether there is anything to give back. MEASURED: without this
       the heal never fired at all, because step was always 0 again by the time
       the new stream was running. */
    if (shed.healed) return;
    if (!shed.was.maxFps && !shed.was.maxSize) return;
    var live = (phone && phone.stream && phone.stream.state) === 'running';
    var ok = live && video.dec && !video.paused &&
      video.dropped === shed.dropAt && video.dec.decodeQueueSize <= 2 &&
      stillMs() < 3000;                       // frames actually flowing, not a still screen
    if (!ok) { shed.cleanSince = 0; return; }
    if (!shed.cleanSince) { shed.cleanSince = now; return; }
    if (now - shed.cleanSince < HEAL_CLEAN_MS) return;

    shed.healed = true;
    var back = {};
    if (shed.was.maxFps) back.maxFps = shed.was.maxFps;
    if (shed.was.maxSize) back.maxSize = shed.was.maxSize;
    var what = Object.keys(back).map(function (k) { return k + ' ' + back[k]; }).join(', ');
    shed.note = 'the decoder has kept up for ' + Math.round(HEAL_CLEAN_MS / 1000) +
      ' s — asking the phone for ' + what + ' again';
    railNote('', shed.note + '…');
    sendCommand('set-settings', back).then(function (res) {
      if (res && res.ok) {
        shed.step = 0;
        shed.was = {};
        railNote('ok', 'back to ' + what + ' (it was turned down when the decoder fell behind)');
      } else {
        railNote('error', 'could not ask for ' + what + ' again: ' + ((res && res.reason) || 'no reason given'));
      }
    });
    renderStatus();
  }

  function askLess(partial) {
    var what = Object.keys(partial).map(function (k) { return k + ' ' + partial[k]; }).join(', ');
    railNote('', 'the decoder cannot keep up: asking for ' + what + '…');
    sendCommand('set-settings', partial).then(function (res) {
      if (res && res.ok) {
        railNote('ok', 'asked for ' + what + ' (the stream restarts at the new quality)');
      } else {
        var reason = (res && res.reason) || 'no reason given';
        railNote('error', 'could not ask for ' + what + ': ' + reason);
        shed.note = 'the decoder is too slow and the browser refused ' + what + ': ' + reason;
        renderStatus();
      }
    });
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
    video.lastArrivalAt = performance.now();  // this page's own "frame age" clock
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

    /* Is the decoder behind? A deep queue only costs latency; a DROP costs the
       whole picture until the next key frame. So the queue is allowed to run
       to DECODE_QUEUE_LIMIT, and one packet over it is treated as a hiccup:
       only DROP_AFTER_BEHIND in a row means the decoder genuinely cannot keep
       up with the stream. */
    /* Warming up = this decoder has not handed back its first frame yet, so
       its own start-up is still in flight and the queue behind it means
       nothing about whether this machine can keep up. Capped, in case a decoder
       is simply wedged and never returns anything. */
    var warming = video.firstOut && video.decoderAt &&
      (performance.now() - video.decoderAt) < DECODER_WARMUP_MS;
    if (warming && video.dec.decodeQueueSize > DECODE_QUEUE_LIMIT) {
      /* Starting up, not failing: say so rather than dropping the picture. */
      video.note = 'the decoder is starting up (' + video.dec.decodeQueueSize + ' frames queued)';
      video.behind = 0;
    } else if (!isKey && video.dec.decodeQueueSize > DECODE_QUEUE_LIMIT) {
      video.behind++;
      if (video.behind >= DROP_AFTER_BEHIND) {
        video.behind = 0;
        video.dropped++;
        video.needKey = true;
        video.note = 'the decoder fell behind (' + video.dec.decodeQueueSize +
          ' frames queued): dropping until the next key frame';
        /* How long ago the last key frame was asked for — read BEFORE asking
           for this one. Behind again within SHED_WINDOW_MS means that key
           frame did not help and the stream itself is too heavy. */
        var sinceKey = video.keyAt ? (performance.now() - video.keyAt) : Infinity;
        requestKeyFrame('the decoder fell behind');
        if (sinceKey < SHED_WINDOW_MS) shedLoad();
        renderReadouts();
        return;
      }
      /* one over-limit packet: keep decoding, it may just be a hiccup */
    } else {
      video.behind = 0;
    }

    var data = payload;
    if (isKey && video.config && video.config.length) {
      data = new Uint8Array(video.config.length + payload.length);
      data.set(video.config, 0);
      data.set(payload, video.config.length);
    }

    try {
      /* Time this frame through the decoder: the "decode time" readout is how
         the next slow-decoder round is diagnosed in one glance instead of
         guessed at. The map is bounded — a frame the decoder never returns
         must not leak. */
      if (!video.sentAt) video.sentAt = new Map();
      video.sentAt.set(ptsUs, performance.now());
      if (video.sentAt.size > 64) {
        var oldest = video.sentAt.keys().next();
        if (!oldest.done) video.sentAt.delete(oldest.value);
      }
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
    /* Hardware first. A software H.264 decoder is what falls behind a 60 fps
       phone stream, and falling behind costs whole seconds of picture. If this
       build refuses the config outright, or the hardware decoder errors once
       it is running, fall back to no-preference — and the readout says which
       one is in use, with the reason, rather than leaving it a mystery.
       (WebCodecs has no way to ask which one Chromium actually chose, so the
       readout says what was asked for; the fallback is what is certain.) */
    var accel = video.accelFell ? 'no-preference' : DECODER_PREF;
    try {
      dec = new VideoDecoder({
        output: onDecodedFrame,
        error: function (err) {
          if (video.accel !== 'no-preference' && !video.accelFell) {
            video.accelFell = 'the ' + video.accel + ' decoder failed: ' + msg(err);
          }
          resetDecoder('the decoder failed: ' + msg(err));
        }
      });
      dec.configure({
        codec: codec,
        /* Annex B is signalled by the ABSENCE of `description`; the avc member
           is what the encoder side needs and is harmless (and ignored) here. */
        avc: { format: 'annexb' },
        hardwareAcceleration: accel,
        optimizeForLatency: true
      });
    } catch (err) {
      try { if (dec) dec.close(); } catch (e) { /* never configured */ }
      video.dec = null;
      if (accel !== 'no-preference') {
        /* One retry with no preference, straight away. */
        video.accelFell = 'the ' + accel + ' decoder refused ' + codec + ': ' + msg(err);
        renderReadouts();
        return ensureDecoder(sample);
      }
      video.err = 'the decoder refused ' + codec + ': ' + msg(err);
      renderStatus();
      return false;
    }
    video.dec = dec;
    video.decoderAt = performance.now();   // the warm-up window starts here
    video.firstOut = true;
    video.accel = accel;
    video.codec = codec;
    video.err = '';
    video.needKey = true;
    video.note = 'decoder ready (' + codec + ', ' + accel + ') — waiting for a key frame';
    return true;
  }

  function resetDecoder(reason) {
    if (video.dec) {
      try { video.dec.close(); } catch (err) { /* already closed */ }
    }
    video.dec = null;
    video.needKey = true;
    video.behind = 0;
    if (video.sentAt) video.sentAt.clear();
    video.note = reason || 'decoder reset';
    if (reason && /fail|threw|refus/.test(reason)) video.err = reason;
    /* Nothing decodable arrives until the next key frame, and scrcpy's own is
       up to ~10 s away — so ask, if there is a running stream to ask. */
    var st = (phone && phone.stream) || {};
    if (st.state === 'running' || st.state === 'stalled') requestKeyFrame(reason || 'the decoder was reset');
    renderReadouts();
  }

  function onDecodedFrame(frame) {
    /* decode() -> here, smoothed: the one number that says whether this
       machine can keep up. The exact pts is the right key; scrcpy's realtime
       stream carries no B-frames, so output order is input order and the
       oldest pending entry is this frame if the key ever misses. */
    if (video.sentAt && video.sentAt.size) {
      var key = video.sentAt.has(frame.timestamp) ? frame.timestamp : video.sentAt.keys().next().value;
      var t0 = video.sentAt.get(key);
      video.sentAt.delete(key);
      if (typeof t0 === 'number') {
        var dt = performance.now() - t0;
        if (video.firstOut) {
          /* The first frame out of a new decoder carries that decoder's whole
             start-up (GPU video device, textures) — tens to hundreds of ms
             against a 0.6 ms steady state. Averaging it in makes the readout
             lie about this machine for the next twenty frames, so it is kept
             on its own and named in the readout's hover instead. */
          video.firstOut = false;
          video.initMs = dt;
        } else {
          video.decodeMs = video.decodeMs ? (video.decodeMs * 0.8 + dt * 0.2) : dt;
        }
      }
    }
    /* Paint it NOW, not at the next requestAnimationFrame. MEASURED against
       The user's phone on 2026-09-13, 560×1280 at a 60 fps cap, window on screen:
       parking the frame for the next rAF callback painted only 43-48 of the
       56-60 frames a second the relay delivered, and threw 16 a second away —
       and not because the screen was slow (the rAF clock measured a steady
       61 Hz throughout). Frames come off a WebSocket in bursts: two land
       between two callbacks, the older one is binned, then a callback finds
       nothing to do. Drawing on arrival keeps every frame and shows the newest
       one the instant a frame is composited: painted then tracks the relay
       (58-60 of 58-60) and the picture stops stuttering.
       The canvas is 2D and desynchronized, so a draw is cheap and never
       blocks; the compositor still presents at the screen's rate. */
    paintFrame(frame);
  }

  function paintFrame(frame) {
    if (!frame) return;
    video.drawnSinceRaf++;
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
    /* phone.html still carries the old title="Ctrl+Alt+K" (a chord the chrome
       swallows before the guest ever sees it), so the pill is re-titled here
       rather than left lying about which key releases the keyboard. */
    els.pill.title = on ? 'Ctrl+Alt+P releases the keyboard' : 'Ctrl+Alt+P sends the keyboard to the phone';
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
    /* The release hotkey works whichever side has the keys. It is Ctrl+Alt+P —
       P for phone — and NOT Ctrl+Alt+K, which could never arrive: main.js's
       before-input-event swallows every combo that shortcuts.js binds, and
       Ctrl+Alt+K is "Show Claude this page" (bound today: Ctrl+Alt+K, Left,
       Right, Shift+K, Shift+R and Ctrl+Alt+1..9). Ctrl+Alt+P is unbound, so it
       reaches the guest. Clicking outside the canvas still releases too. */
    if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      e.stopPropagation();
      var want = !input.captured;
      if (want) els.canvas.focus(); else els.canvas.blur();
      /* The hotkey decides on its own: element.focus()/blur() do nothing in a
         window that does not have the OS focus, and the pill must never lie
         about where the keys are going. */
      setCaptured(want);
      railNote('', want ? 'keys go to the phone (Ctrl+Alt+P releases them)'
        : 'keys go to the browser (Ctrl+Alt+P sends them to the phone)');
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

  /* --- the two screen-power buttons, and why they are shaped like this -----

     MEASURED against the user's phone (Android phone, Android 16 / SDK 36) on
     2026-09-13, with a control-only scrcpy v4.1 session and `dumpsys` read
     before and after every message:

       phone awake  + SET_DISPLAY_POWER(off) -> server logs "Device display
         turned off", SurfaceFlinger isPoweredOn=0: the panel really goes dark.
         The MIRROR does not change at all (31 packets / 353 kB in the 2.5 s
         while the panel was dark, same as before it) — Android keeps
         compositing, so the picture here carries on. That is why the button
         looked like it "did nothing": everything it does happens on the desk.

       phone ASLEEP + SET_DISPLAY_POWER(on)  -> server logs "Device display
         turned on" and SurfaceFlinger says isPoweredOn=1, but the phone stays
         asleep: mWakefulness=Dozing, mScreenState=OFF, and a screenshot is
         still 0.0/255 black. SET_DISPLAY_POWER sits UNDER PowerManager; it
         cannot wake a dozing phone, and a dozing phone composites nothing.
         KEYCODE_WAKEUP on the same socket woke it every time (Awake,
         mScreenState=ON, screenshot 76.4/255, keyguard fully visible).

     So "Screen on" was never going to work — the button anyone presses on a
     dark mirror is a WAKE. It sends the wake key first and the display-power
     message after it, which covers both states with one press. */

  function displayPowerSaid(on, pressedAt) {
    /* The scrcpy server logs "Device display turned on|off" on its own stdout
       and phone.js forwards its newest line as stream.serverLine. There is no
       device MESSAGE for this, so that log line is the only confirmation that
       exists — and if it does not arrive, the page says exactly that. */
    var line = phone && phone.stream ? String(phone.stream.serverLine || '') : '';
    var at = phone && phone.stream ? (phone.stream.serverLineAt || 0) : 0;
    if (at >= pressedAt && /display turned (on|off)/i.test(line)) {
      railNote('ok', 'the phone said: ' + line.replace(/^\[server\]\s*/, '').replace(/^\w+:\s*/, ''));
      return true;
    }
    return false;
  }

  function screenOff() {
    var pressedAt = Date.now();
    if (!sendControl(msgSetDisplayPower(false), null)) return;
    /* MEASURED on the user's Android phone, Android 16, 2026-09-13: with the panel powered
       off Android draws nothing for that display, so the mirror goes black
       too — the "phone dark, picture live" mode scrcpy advertises does not
       exist on this phone. Say it before he wonders, and remember it so the
       black-picture note blames the right thing (this press, not sleep). */
    video.screenOffByUs = pressedAt;
    railNote('', 'asked the phone to turn its screen off — on this phone the picture goes black too until you press Wake');
    setTimeout(function () {
      if (displayPowerSaid(false, pressedAt)) {
        railNote('ok', 'the phone said its display is off. On this phone (Android 16) the picture stays black while the panel is off — press Wake to bring both back');
        return;
      }
      railNote('error', 'asked the phone to turn its screen off, but it never said it did: scrcpy 4.1 reports this only in its own log, and nothing came back within 2 s — look at the phone');
    }, 2000);
  }

  function wakePhone() {
    var pressedAt = Date.now();
    /* ORDER MATTERS. Once a client has turned the display off, the scrcpy
       server remembers it (Controller.keepDisplayPowerOff) and answers any
       later POWER or WAKEUP key-up by forcing the display off again 200 ms
       later ("Forcing display off" in its log) — that is exactly what turned
       The user's phone back off on 2026-09-13 when the wake key went first. Only
       SET_DISPLAY_POWER(on) clears that memory (Controller.setDisplayPower
       sets keepDisplayPowerOff = !on), so it goes FIRST; then the wake key is
       what actually wakes a dozing phone (the display-power call alone sits
       under the power manager and cannot); then one more on, after the
       server's 200 ms window, in case the key-up still raced the first. */
    if (!sendControl(msgSetDisplayPower(true), null)) return;
    video.screenOffByUs = 0; // whatever happens next is not our Screen off any more
    sendControl(msgInjectKeycode(KEY_DOWN, AKEYCODE.WAKEUP, 0, 0));
    sendControl(msgInjectKeycode(KEY_UP, AKEYCODE.WAKEUP, 0, 0));
    setTimeout(function () { sendControl(msgSetDisplayPower(true), null); }, 400);
    railNote('', 'asked the phone to wake…');
    setTimeout(function () {
      if (video.blackSince) {
        railNote('error', 'the phone did not wake: the picture is still black. Press the phone\'s power button — a locked phone can refuse a wake from a computer');
        return;
      }
      if (!displayPowerSaid(true, pressedAt)) railNote('ok', 'wake sent; the picture is not black');
    }, 2000);
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
    { label: 'Screen off', run: screenOff },
    { label: 'Wake', run: wakePhone },
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
    syncRailEnabled();
  }

  /* Rail keys while the link is off: dimmed and marked disabled, but still
     clickable on purpose — a dead button explains nothing, and a real
     `disabled` one cannot even fire the click that would say why. Pressing one
     is refused in sendControl with the reason, in the rail note. */
  function syncRailEnabled() {
    if (!els.railKeys) return;
    var off = linkIsOff();
    var kids = els.railKeys.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].setAttribute('aria-disabled', off ? 'true' : 'false');
      kids[i].style.opacity = off ? '0.45' : '';
    }
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
    /* The frame's hairline border is part of its box (box-sizing: border-box),
       so what gets fitted to the device's aspect is the PICTURE inside that
       border — the canvas — and the border is added back afterwards. Fitting
       the border box instead leaves the canvas two pixels short on each axis
       and squashes the picture by a fraction of a percent. */
    var bw = Math.max(0, els.frame.offsetWidth - els.frame.clientWidth);
    var bh = Math.max(0, els.frame.offsetHeight - els.frame.clientHeight);
    var availW = els.stage.clientWidth - 32 - bw;   // the stage's 16px padding
    var availH = els.stage.clientHeight - 32 - bh;
    if (availW <= 0 || availH <= 0) return;
    var aspect = (video.w && video.h) ? (video.w / video.h) : (9 / 20);
    var w = availW;
    var h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    /* Both axes come from the same fit and neither gets a floor of its own: a
       minimum on one side alone stretches the picture, which is exactly what a
       320px-wide tab used to do. A stage too small for a picture gets a small
       picture, never a distorted one. */
    els.frame.style.width = Math.max(1, Math.floor(w) + bw) + 'px';
    els.frame.style.height = Math.max(1, Math.floor(h) + bh) + 'px';
  }

  /* The screen's own clock. Frames are painted the moment they decode, so the
     paint count no longer says anything about whether the SCREEN is alive —
     this does. A requestAnimationFrame loop that does nothing but count is
     free (Chromium runs one callback per composited frame), it stops dead when
     the window is occluded, minimised or the monitor sleeps — which is exactly
     the state that must never look like a dead stream — and every draw beyond
     the first between two callbacks is a frame the screen never showed. */
  function startScreenClock() {
    function beat() {
      video.rafs++;
      if (video.drawnSinceRaf > 1) video.skipped += video.drawnSinceRaf - 1;
      video.drawnSinceRaf = 0;
      requestAnimationFrame(beat);
    }
    requestAnimationFrame(beat);
  }

  var lastTick = { at: 0, painted: 0, bytes: 0, rafs: 0 };

  /* --- is the picture black? ---------------------------------------------

     MEASURED on the user's phone 2026-09-13: with the phone asleep (Dozing,
     mScreenState=OFF) Android composites nothing, and a screenshot of it is
     0.0/255 — so the mirror shows a live, flawless, completely black picture.
     The keyguard and the PIN pad themselves are NOT hidden from capture on
     this phone (76.4/255 and 59.5/255 with the display on, 94-100 % of pixels
     non-black), so "the sign-in screen is black" is always the phone being
     asleep, never Android refusing to show the lock screen.

     One 8x16 read-back a second off a canvas the GPU already holds. */
  var blackProbe = null, blackProbeCtx = null;

  function pictureIsBlack() {
    if (!els.canvas || !els.canvas.width || !els.canvas.height) return false;
    try {
      if (!blackProbe) {
        blackProbe = document.createElement('canvas');
        blackProbe.width = 8; blackProbe.height = 16;
        blackProbeCtx = blackProbe.getContext('2d', { willReadFrequently: true });
      }
      if (!blackProbeCtx) return false;
      blackProbeCtx.drawImage(els.canvas, 0, 0, 8, 16);
      var d = blackProbeCtx.getImageData(0, 0, 8, 16).data;
      var max = 0;
      for (var i = 0; i < d.length; i += 4) {
        var v = d[i] > d[i + 1] ? d[i] : d[i + 1];
        if (d[i + 2] > v) v = d[i + 2];
        if (v > max) max = v;
      }
      video.blackMax = max;
      video.blackErr = '';
      return max <= 10;
    } catch (err) {
      /* Never let a read-back failure invent a black screen. */
      video.blackErr = 'the picture could not be sampled: ' + msg(err);
      return false;
    }
  }

  var BLACK_NOTE = 'the picture is black because the phone\'s screen is off — press Wake in the rail, or the phone\'s own power button. '
    + 'A sleeping Android draws nothing, so there is nothing to mirror.';
  /* Appended when the reason is our own doing: with "turn the phone screen off
     while mirroring" on, the panel is powered off at every stream start and a
     phone on battery then falls asleep at its screen timeout — every time. */
  var BLACK_NOTE_SCREEN_OFF = ' The screen was turned off by this browser: "turn the phone screen off while mirroring" is on in '
    + 'Settings → Phone, and a phone on battery falls asleep at its screen timeout with the panel off. Turn that setting off if this keeps happening.';
  /* MEASURED 2026-09-13 with the user at the keyboard: the password screen is lit on
     the phone and black here — Android 16 keeps the sign-in surface out of
     every screen capture. The control channel does not care: keys still land. */
  var BLACK_NOTE_KEYGUARD = 'the phone is awake at its sign-in screen, and Android hides that screen from screen capture — that is why this is black, '
    + 'not the phone. Your keys still reach it: click the picture, type your password and press Enter, or unlock on the phone itself.';
  var BLACK_NOTE_SECURE_APP = 'the phone is awake and lit, but the app on its screen hides itself from screen capture (banking apps and DRM video '
    + 'draw black in any mirror). Switch apps on the phone to see it again.';

  function checkBlackPicture() {
    /* No "is the window painting" gate here, on purpose: the sampler reads
       the CANVAS, and a canvas keeps its last frame whether or not Chromium is
       compositing the window, so occlusion cannot fake a black picture. The
       gate it used to have (a frame this tick, then the rAF heartbeat) was
       exactly what failed on a sleeping phone or a still lock screen — both
       send nothing, both are black, and the note vanished (2026-09-13). */
    var running = phone && phone.stream && phone.stream.state === 'running';
    if (!running || !video.painted || video.paused) {
      video.blackSince = 0;
    } else if (pictureIsBlack()) {
      if (!video.blackSince) video.blackSince = Date.now();
    } else {
      video.blackSince = 0;
    }
    /* > 1 s of black, so a single dark frame between two scenes says nothing. */
    var show = !!video.blackSince && (Date.now() - video.blackSince) > 1000;
    if (show) {
      /* Which black this is. The relay asks the phone what it is showing on
         every probe tick (device.awake / screenOn / keyguard), so the text is
         recomputed each second and swapped the moment a better answer lands —
         the first second after a lock is "asleep?" until dumpsys says "awake,
         keyguard", and then it must say so. */
      var d = (phone && phone.device) || {};
      var text;
      if (video.screenOffByUs) {
        text = 'the picture is black because you turned the phone\'s screen off from the rail. On this phone (Android 16) '
          + 'the mirror goes black with the panel — press Wake to bring both back.';
      } else if (d.awake === true && d.keyguard === true) {
        text = BLACK_NOTE_KEYGUARD;
      } else if (d.awake === true && d.screenOn === true && d.keyguard === false) {
        text = BLACK_NOTE_SECURE_APP;
      } else {
        var ours = !!(phone && phone.settings && phone.settings.screenOffWhileMirroring);
        text = BLACK_NOTE + (ours ? BLACK_NOTE_SCREEN_OFF : '');
      }
      if (!video.blackNoteOn || text !== video.blackNoteText) {
        video.blackNoteOn = true;
        video.blackNoteText = text;
        setFrameNote(text);
      }
    }
    else if (!show && video.blackNoteOn) { video.blackNoteOn = false; video.blackNoteText = ''; setFrameNote(''); }
  }

  function tick() {
    var now = performance.now();
    var paintingNow = video.painted > lastTick.painted;
    if (lastTick.at) {
      var dt = (now - lastTick.at) / 1000;
      video.fps = Math.round((video.painted - lastTick.painted) / dt);
      video.kbps = Math.round(((video.bytes - lastTick.bytes) * 8 / 1000) / dt);
      video.screenHz = Math.round((video.rafs - lastTick.rafs) / dt);
      /* Frames painting but no callbacks at all means the window is not being
         composited: occluded, minimised, or the monitor has gone to sleep.
         Chromium does that on purpose — and a <webview> guest is never told,
         its own document stays 'visible' — but it must not look like a dead
         stream. (Measured 2026-09-13: with the terminal covering the browser,
         the guest kept decoding 60 frames a second and painted none.) */
      video.notPainting = (video.screenHz === 0 && video.painted > lastTick.painted);
      if (video.notPainting) {
        video.note = 'frames are arriving and decoding, but this window is not painting (occluded, minimised, or the screen is asleep)';
      }
    }
    lastTick.at = now;
    lastTick.painted = video.painted;
    lastTick.bytes = video.bytes;
    lastTick.rafs = video.rafs;
    /* "asked the phone for 30 fps" is worth saying while it is news; a minute
       later the profile readout is the place it lives. */
    if (shed.note && shed.at && (Date.now() - shed.at) > 60000) shed.note = '';
    healShed(now);
    /* A black picture that has STOPPED changing is still a black picture: a
       sleeping phone and a still lock screen both send no frames at all, so
       any "fresh frame" gate here was false exactly when the note mattered
       most (The user's pure-black sign-in screenshot, 2026-09-13). */
    checkBlackPicture();
    syncRailEnabled();
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
      /* Ask for a fresh key frame instead of waiting up to ~10 s for the
         server's next one. */
      requestKeyFrame('the tab is visible again');
    }
    renderReadouts();
  }

  /* ==================================================================== */
  /* 11. Bootstrap                                                        */
  /* ==================================================================== */

  function applyState(state) {
    if (!state) return;
    var was = (phone && phone.stream) ? phone.stream.state : '';
    phone = state;
    var now = (state.stream && state.stream.state) || '';
    /* A stream that stopped leaves its last frame on the canvas. The page must
       not then call that stale picture a live, merely still one: forget the
       paint clock so the states before a picture (which DO cover the canvas
       and DO carry the Start/Retry button) apply again. */
    if (was !== now && now !== 'running' && now !== 'stalled') {
      video.lastPaintAt = 0;
      video.notPainting = false;
      if (els.frame) els.frame.dataset.live = '0';
      if (now === 'off') { shed.step = 0; shed.note = ''; }
    }
    /* The master switch must take effect on the push that carried it, not up
       to a second later on the next tick. */
    syncRailEnabled();
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
    /* Right from the first paint, not only after the first toggle. */
    if (els.pill) els.pill.title = 'Ctrl+Alt+P sends the keyboard to the phone';
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
    startScreenClock();
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
