/* ============================================================
   ambient.js — the built-in generative ambient engine.

   Idle music with no files and no network: a slow chord pad and a
   sparse arpeggio, generated in Web Audio, endless and never the
   same twice. This is the "Built-in ambient" source of the idle
   music feature; the player that decides WHEN it may play (focus,
   audible tabs, Spotify, the new-tab-only rule, the 800/400 ms
   fades) lives in the chrome, not here.

   The contract the chrome uses:

     const ctx = Ambient.createContext();      // 24 kHz, playback latency
     const engine = Ambient.create({ ctx });
     engine.setVolume(0.35);                   // 0..1, optional ramp
     engine.start();                           // schedules and plays
     engine.title();                           // "Slow tide"
     engine.stop();                            // silent, ctx suspended

   Cost when paused is the reason stop() suspends the context: a
   suspended AudioContext renders nothing at all, and stop() also
   clears the single scheduling timer, so a paused engine costs
   exactly zero CPU. close() is never called, so start() after
   stop() is a resume of the same graph -- the room is built once
   per engine, not once per play.

   Cost while playing was measured on 2026-09-11 in a test instance
   (renderer process, % of one core, engine the only audio, window
   behind everything with the two no-throttle switches):
     pad + compressor + arpeggio delay, 48 kHz     3.9
     + a 2.5 s ConvolverNode on a mono send        7.9
     + a four-line damped delay network            6.4
     whole engine, 48 kHz, four voices             4.45
     whole engine, 24 kHz playback context         1.87-1.95
   So the reverb and the sample rate are the whole bill. The default
   room is therefore the delay network (DEFAULTS.reverbKind), the
   send is mono, the context is 24 kHz (createContext), and the
   0.05 Hz filter sweep is scheduled as k-rate steps rather than an
   oscillator wired into filter.frequency -- an audio-rate connection
   there recomputes the biquad's coefficients every sample. The
   convolver is still one word away for a machine that can spare it.

   Scheduling is one setTimeout chain, not a polling clock: each
   tick schedules a whole chord (its voice envelopes and every
   arpeggio note inside it) on the audio clock and then arms one
   timer to land a second before the next chord is due. That is
   one JS wake-up per ~20 s while playing.

   Everything that decides what is played -- the progression, the
   voice envelopes, the note picking and its quantisation, the
   impulse response -- is a pure function of numbers and a seeded
   PRNG, exported alongside create(). A node harness drives them
   with no audio stack at all, and drives create() itself against
   a fake context that records what was scheduled.

   Loaded as a plain script in the chrome (window.Ambient) and
   require()-able from node (module.exports), the way shortcuts.js
   is shared between the renderer and main.
   ============================================================ */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * The music, as numbers.                                             *
   * ------------------------------------------------------------------ */

  /** Modes the pad may sit in. Semitones from the root, one octave. */
  var MODES = {
    dorian: [0, 2, 3, 5, 7, 9, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11]
  };

  /**
   * The progression, as 0-based scale degrees: i, IV, v, VII. Four
   * chords that never resolve hard, so the loop has no seam.
   */
  var PROGRESSION = [0, 3, 4, 6];

  /** One is chosen per start and shown as the state line. Two words each. */
  var TITLES = [
    'Slow tide',
    'Night bay',
    'Pale harbour',
    'Long dusk',
    'Quiet field',
    'Blue hour',
    'Still water',
    'Soft ember',
    'Low cloud',
    'Far shore',
    'Grey morning',
    'Open window'
  ];

  /**
   * Every tunable in one place. Times are seconds, pitches MIDI note
   * numbers, gains linear. The pad sits at A3 so its harmonics live
   * under the filter instead of being cut to a sine.
   */
  var DEFAULTS = {
    rootMidi: 57,          /* A3 -- 220 Hz */
    volume: 0.35,
    sampleRate: 24000,     /* see createContext() */
    latencyHint: 'playback',
    volumeRamp: 0.06,      /* click-free step when setVolume gets no ramp */

    voicesMin: 3,
    voicesMax: 4,
    attackMin: 4,
    attackMax: 6,
    releaseMin: 4,
    releaseMax: 6,
    chordMin: 16,          /* a chord change every 16-24 s */
    chordMax: 24,
    /* Summed pad peak before the compressor. Tuned by measurement, not by
       ear: at master volume 1 the engine renders a -6.2 dBFS peak and a
       -18.7 dBFS RMS over 20 s, which is the brief's "peak -6, around
       -20 LUFS-ish". Scale pad and arpeggio together to move it. */
    padPeak: 0.33,
    detuneMin: 5,          /* cents, each of the two oscillators per voice */
    detuneMax: 12,

    cutoffBase: 1000,      /* lowpass sweeps 600-1400 Hz ... */
    cutoffDepth: 400,      /* ... at 0.05 Hz, one sweep per 20 s */
    cutoffLfoHz: 0.05,
    cutoffStep: 0.5,       /* as k-rate steps: see cutoffSteps() */
    filterQ: 0.7,

    arpBaseMidi: 74,       /* D5 and up, soft sine */
    arpSpan: 14,
    arpRateMin: 8,         /* notes per minute */
    arpRateMax: 12,
    arpPeak: 0.06,
    arpAttack: 0.08,
    arpDurMin: 1.2,
    arpDurMax: 2.8,

    delaySeconds: 0.45,
    delayFeedback: 0.35,
    delayMix: 0.55,

    /* 'network' is four damped delay lines with a 2.5 s RT60 -- a generated
       room, like the impulse, but a quarter of the cost. 'convolver' is the
       2.5 s noise impulse through a ConvolverNode: better tail, and measured
       at ~4% of a core more on this machine (2026-09-11), which is why the
       network is the default. impulseResponse() serves the convolver mode. */
    reverbKind: 'network',
    reverbSeconds: 2.5,    /* RT60 of the network; length of the impulse */
    reverbDecay: 4.2,      /* impulse mode only */
    reverbDamp: 2600,      /* lowpass inside each delay line ... */
    reverbDampQ: 0,        /* ... with NO resonant peak: see reverbLines() */
    reverbMaxFeedback: 0.88,
    reverbCombs: [0.0297, 0.0371, 0.0411, 0.0437],
    reverbMix: 1.1,        /* the returns are normalised, so this is > 1 */

    compThreshold: -12,
    compKnee: 10,
    compRatio: 4,
    compAttack: 0.01,
    compRelease: 0.5,

    lookahead: 1           /* schedule each chord this early */
  };

  /* ------------------------------------------------------------------ *
   * Pure helpers. No audio stack, no globals, testable from node.      *
   * ------------------------------------------------------------------ */

  /** mulberry32: same seed, same session, every time. */
  function makeRandom(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function random() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A fresh seed for a session start. Math.random is fine here. */
  function randomSeed() {
    return (Math.random() * 4294967296) >>> 0;
  }

  function range(rnd, lo, hi) {
    return lo + rnd() * (hi - lo);
  }

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (Number(midi) - 69) / 12);
  }

  /** Scale degree (may run past the octave) to a MIDI note. */
  function scaleMidi(mode, rootMidi, degree) {
    var steps = MODES[mode] || MODES.dorian;
    var n = steps.length;
    var oct = Math.floor(degree / n);
    var idx = degree - oct * n;
    return rootMidi + oct * 12 + steps[idx];
  }

  /**
   * The chord at one step of the progression: a triad, or a seventh
   * when the session runs four voices. Ascending.
   */
  function chordAt(opts) {
    var o = opts || {};
    var mode = o.mode || 'dorian';
    var rootMidi = o.rootMidi == null ? DEFAULTS.rootMidi : o.rootMidi;
    var voices = o.voices == null ? DEFAULTS.voicesMin : o.voices;
    var step = Math.floor(o.step || 0);
    var base = PROGRESSION[((step % PROGRESSION.length) + PROGRESSION.length) % PROGRESSION.length];
    var out = [];
    for (var v = 0; v < voices; v += 1) out.push(scaleMidi(mode, rootMidi, base + v * 2));
    return out;
  }

  /** How long this chord holds the stage, 16-24 s. */
  function chordDuration(rnd) {
    return range(rnd, DEFAULTS.chordMin, DEFAULTS.chordMax);
  }

  /**
   * One voice's envelope as plain numbers: rise over `attack`, hold,
   * then fall over `release`. The release overlaps the next chord's
   * attack, which is what makes a change a crossfade instead of a cut.
   */
  function voiceEnvelope(opts) {
    var o = opts || {};
    var start = Number(o.start) || 0;
    var attack = Number(o.attack) || DEFAULTS.attackMin;
    var hold = Math.max(0, Number(o.hold) || 0);
    var release = Number(o.release) || DEFAULTS.releaseMin;
    var peak = Number(o.peak) || 0;
    var sustainEnd = start + attack + hold;
    var end = sustainEnd + release;
    return {
      start: start,
      attack: attack,
      hold: hold,
      release: release,
      peak: peak,
      total: attack + hold + release,
      end: end,
      points: [
        { time: start, value: 0 },
        { time: start + attack, value: peak },
        { time: sustainEnd, value: peak },
        { time: end, value: 0 }
      ]
    };
  }

  /**
   * Snap a pitch to the nearest note of the chord, in any octave, so
   * the arpeggio can never land outside the harmony. Ties go up.
   */
  function quantiseToChord(midi, chord) {
    if (!chord || !chord.length) return Math.round(midi);
    var want = {};
    for (var i = 0; i < chord.length; i += 1) want[((chord[i] % 12) + 12) % 12] = true;
    var target = Math.round(midi);
    for (var d = 0; d <= 12; d += 1) {
      if (want[((target + d) % 12 + 12) % 12]) return target + d;
      if (d > 0 && want[((target - d) % 12 + 12) % 12]) return target - d;
    }
    return target;
  }

  /**
   * The arpeggio inside one chord: 8-12 notes a minute, one per slot
   * with jitter inside the slot (so times stay ascending), each pitch
   * drawn from a window above the pad and quantised to the chord.
   */
  function arpeggioSchedule(opts) {
    var o = opts || {};
    var rnd = o.rnd || Math.random;
    var start = Number(o.start) || 0;
    var duration = Math.max(0, Number(o.duration) || 0);
    var chord = o.chord || [];
    var rate = o.notesPerMinute == null
      ? range(rnd, DEFAULTS.arpRateMin, DEFAULTS.arpRateMax)
      : Number(o.notesPerMinute);
    var baseMidi = o.baseMidi == null ? DEFAULTS.arpBaseMidi : o.baseMidi;
    var span = o.span == null ? DEFAULTS.arpSpan : o.span;
    var count = Math.max(1, Math.round((duration * rate) / 60));
    var slot = duration / count;
    var notes = [];
    for (var i = 0; i < count; i += 1) {
      var raw = baseMidi + rnd() * span;
      notes.push({
        time: start + i * slot + rnd() * slot * 0.5,
        midi: quantiseToChord(raw, chord),
        gain: DEFAULTS.arpPeak * (0.55 + rnd() * 0.45),
        duration: range(rnd, DEFAULTS.arpDurMin, DEFAULTS.arpDurMax)
      });
    }
    return notes;
  }

  /** The reverb tail's shape: 1 at the head, exactly 0 at the tail. */
  function impulseEnvelope(i, length, decay) {
    if (length <= 1) return 0;
    var t = i / (length - 1);
    return Math.exp(-decay * t) * (1 - t);
  }

  /** A 2.5 s noise burst with that envelope -- the convolver's room. */
  function impulseResponse(opts) {
    var o = opts || {};
    var sampleRate = Number(o.sampleRate) || 48000;
    var seconds = o.seconds == null ? DEFAULTS.reverbSeconds : Number(o.seconds);
    var decay = o.decay == null ? DEFAULTS.reverbDecay : Number(o.decay);
    var rnd = o.rnd || Math.random;
    var length = Math.max(1, Math.floor(sampleRate * seconds));
    var Arr = typeof Float32Array === 'function' ? Float32Array : Array;
    var out = new Arr(length);
    for (var i = 0; i < length; i += 1) out[i] = (rnd() * 2 - 1) * impulseEnvelope(i, length, decay);
    return out;
  }

  /**
   * The feedback a delay line of `delaySeconds` needs to fall 60 dB in
   * `rt60` seconds. 10^-3 is -60 dB, so one round trip must lose
   * 3 * delay / rt60 of a decade.
   */
  function combFeedback(delaySeconds, rt60) {
    if (!(rt60 > 0) || !(delaySeconds > 0)) return 0;
    return Math.pow(10, (-3 * delaySeconds) / rt60);
  }

  /**
   * The cheap reverb, as numbers: four delay lines whose lengths are
   * mutually prime-ish milliseconds, each damped and fed back just
   * enough for a 2.5 s tail.
   *
   * Two numbers here are the difference between a room and a siren.
   *
   * The damping filter's Q must be 0. For a lowpass, Web Audio reads
   * Q in DECIBELS of resonance, not as a quality factor, so the 1 a
   * BiquadFilter defaults to is a 1 dB peak -- and 0.9 feedback times
   * a peak above unity is a loop gain above unity. Measured growth:
   * +99 dBFS over 14 s at the default Q, +36 at Q 0.5, flat at Q 0.
   *
   * And the return gain is 1 - feedback, because a comb line's
   * steady-state gain on held input is 1 / (1 - feedback); without it
   * a sustained pad drives the tail 12x louder than the dry signal.
   */
  function reverbLines(opts) {
    var o = opts || {};
    var rt60 = o.rt60 == null ? DEFAULTS.reverbSeconds : Number(o.rt60);
    var combs = o.combs || DEFAULTS.reverbCombs;
    var damp = o.damp == null ? DEFAULTS.reverbDamp : Number(o.damp);
    var out = [];
    for (var i = 0; i < combs.length; i += 1) {
      var fb = Math.min(DEFAULTS.reverbMaxFeedback, combFeedback(combs[i], rt60));
      out.push({
        delay: combs[i],
        feedback: fb,
        damp: damp,
        dampQ: DEFAULTS.reverbDampQ,
        gain: (1 - fb) / combs.length
      });
    }
    return out;
  }

  /**
   * The filter sweep as k-rate steps instead of an oscillator wired to
   * filter.frequency. An audio-rate connection there makes the biquad
   * recompute its coefficients every sample; half-second steps along
   * the same 0.05 Hz sine are two events a second and inaudible on a
   * pad this slow. (The same trick as steps() on a CSS animation.)
   */
  function cutoffSteps(opts) {
    var o = opts || {};
    var start = Number(o.start) || 0;
    var duration = Math.max(0, Number(o.duration) || 0);
    var stepSeconds = o.stepSeconds == null ? DEFAULTS.cutoffStep : Number(o.stepSeconds);
    var base = o.base == null ? DEFAULTS.cutoffBase : Number(o.base);
    var depth = o.depth == null ? DEFAULTS.cutoffDepth : Number(o.depth);
    var hz = o.hz == null ? DEFAULTS.cutoffLfoHz : Number(o.hz);
    var phase = Number(o.phase) || 0;
    var steps = [];
    if (stepSeconds <= 0) return steps;
    for (var t = 0; t < duration - 1e-9; t += stepSeconds) {
      steps.push({
        time: start + t,
        value: base + depth * Math.sin(2 * Math.PI * (hz * (start + t) + phase))
      });
    }
    return steps;
  }

  /** The mood name for this start. */
  function pickTitle(rnd) {
    return TITLES[Math.floor((rnd || Math.random)() * TITLES.length) % TITLES.length];
  }

  /* ------------------------------------------------------------------ *
   * The engine.                                                        *
   * ------------------------------------------------------------------ */

  function defaultTimers() {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    return {
      setTimeout: function (fn, ms) { return g ? g.setTimeout(fn, ms) : 0; },
      clearTimeout: function (id) { if (g) g.clearTimeout(id); }
    };
  }

  /** Quietly ignore the graph calls a stripped-down context lacks. */
  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  /**
   * The context this engine wants, and the chrome should use:
   *
   *   const ctx = Ambient.createContext();
   *
   * 24 kHz because every sample of DSP is paid for and nothing here
   * goes above the 1.4 kHz filter and a few kHz of arpeggio harmonics
   * -- 12 kHz of bandwidth is twice what the music uses, and halving
   * the rate halved the cost (4.45% of a core at 48 kHz, 1.9% at 24).
   * latencyHint 'playback' because nothing here reacts to input, so
   * bigger buffers and fewer audio-thread wake-ups are free.
   * Returns null where there is no AudioContext at all.
   */
  function createContext(opts) {
    var o = opts || {};
    var Ctor = null;
    if (typeof AudioContext === 'function') Ctor = AudioContext;
    else if (typeof webkitAudioContext === 'function') Ctor = webkitAudioContext;
    if (!Ctor) return null;
    var wanted = {
      sampleRate: o.sampleRate == null ? DEFAULTS.sampleRate : o.sampleRate,
      latencyHint: o.latencyHint == null ? DEFAULTS.latencyHint : o.latencyHint
    };
    try { return new Ctor(wanted); } catch (e) { return new Ctor(); }
  }

  /**
   * create({ ctx }) -> { start, stop, setVolume, title, isPlaying, state }
   *
   * ctx      an AudioContext (or OfflineAudioContext, or a fake)
   * volume   starting master volume, 0..1 (default 0.35)
   * seed     fixes the session for tests; omitted means a new one per start
   * timers   { setTimeout, clearTimeout } for tests
   */
  function create(options) {
    var o = options || {};
    var ctx = o.ctx;
    if (!ctx) throw new Error('Ambient.create needs { ctx }');

    var timers = o.timers || defaultTimers();
    var fixedSeed = o.seed;
    var offline = typeof ctx.startRendering === 'function';

    var volume = o.volume == null ? DEFAULTS.volume : clamp01(o.volume);
    var nodes = null;      /* the permanent graph, built on first start */
    var playing = false;
    var timer = null;
    var rnd = makeRandom(fixedSeed == null ? randomSeed() : fixedSeed);
    var title = pickTitle(rnd);
    var mode = 'dorian';
    var voices = DEFAULTS.voicesMin;
    var step = 0;
    var nextOnset = 0;
    var live = [];         /* chord nodes still sounding, pruned per tick */

    /* ---------------- the permanent graph ---------------- */

    function build() {
      if (nodes) return nodes;

      var master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);

      var comp = ctx.createDynamicsCompressor();
      setParam(comp.threshold, DEFAULTS.compThreshold);
      setParam(comp.knee, DEFAULTS.compKnee);
      setParam(comp.ratio, DEFAULTS.compRatio);
      setParam(comp.attack, DEFAULTS.compAttack);
      setParam(comp.release, DEFAULTS.compRelease);
      comp.connect(master);

      /* Everything meets here: dry pad, dry arpeggio, reverb return. */
      var mix = ctx.createGain();
      mix.gain.value = 1;
      mix.connect(comp);

      /* The reverb return. */
      var wet = ctx.createGain();
      wet.gain.value = DEFAULTS.reverbMix;
      wet.connect(mix);

      /* One mono send feeds the room: half the channels, half the work. */
      var send = ctx.createGain();
      send.gain.value = 0.7;
      safe(function () {
        send.channelCount = 1;
        send.channelCountMode = 'explicit';
      });

      var reverb = buildReverb(send, wet);

      /* Pad bus: voices -> one shared lowpass, swept in k-rate steps. */
      var padFilter = ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      setParam(padFilter.frequency, DEFAULTS.cutoffBase);
      setParam(padFilter.Q, DEFAULTS.filterQ);
      padFilter.connect(mix);
      padFilter.connect(send);

      var pad = ctx.createGain();
      pad.gain.value = 0.9;
      pad.connect(padFilter);

      /* Arpeggio bus: notes -> long feedback delay -> mix + reverb. */
      var arp = ctx.createGain();
      arp.gain.value = 1;
      arp.connect(mix);
      arp.connect(send);

      var delay = ctx.createDelay(1.5);
      setParam(delay.delayTime, DEFAULTS.delaySeconds);
      var feedback = ctx.createGain();
      feedback.gain.value = DEFAULTS.delayFeedback;
      var delayOut = ctx.createGain();
      delayOut.gain.value = DEFAULTS.delayMix;
      arp.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayOut);
      delayOut.connect(mix);
      delayOut.connect(send);

      nodes = {
        master: master, comp: comp, mix: mix,
        reverb: reverb, wet: wet, send: send,
        pad: pad, padFilter: padFilter,
        arp: arp, delay: delay, feedback: feedback, delayOut: delayOut
      };
      return nodes;
    }

    /**
     * Either the four-line network (default) or the 2.5 s generated
     * impulse through a ConvolverNode. Same room, very different price.
     */
    function buildReverb(send, wet) {
      if (DEFAULTS.reverbKind === 'convolver') {
        var convolver = ctx.createConvolver();
        safe(function () {
          var ir = impulseResponse({
            sampleRate: ctx.sampleRate || 48000,
            rnd: makeRandom(0x5eed1e)
          });
          var buf = ctx.createBuffer(1, ir.length, ctx.sampleRate || 48000);
          buf.getChannelData(0).set(ir);
          convolver.buffer = buf;
        });
        send.connect(convolver);
        convolver.connect(wet);
        return { kind: 'convolver', convolver: convolver, lines: [] };
      }

      var spec = reverbLines({ rt60: DEFAULTS.reverbSeconds });
      var lines = [];
      for (var i = 0; i < spec.length; i += 1) {
        var line = spec[i];
        var delayNode = ctx.createDelay(0.25);
        setParam(delayNode.delayTime, line.delay);
        var damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        setParam(damp.frequency, line.damp);
        setParam(damp.Q, line.dampQ);
        var fb = ctx.createGain();
        fb.gain.value = line.feedback;
        var out = ctx.createGain();
        out.gain.value = line.gain;
        send.connect(delayNode);
        delayNode.connect(damp);
        damp.connect(fb);
        fb.connect(delayNode);
        damp.connect(out);
        out.connect(wet);
        lines.push({ delay: delayNode, damp: damp, feedback: fb, out: out, spec: line });
      }
      return { kind: 'network', convolver: null, lines: lines };
    }

    function setParam(param, value) {
      if (!param) return;
      if (typeof param.setValueAtTime === 'function') {
        safe(function () { param.setValueAtTime(value, ctx.currentTime || 0); });
      }
      if ('value' in param) param.value = value;
    }

    /* ---------------- per-chord scheduling ---------------- */

    function scheduleVoice(midi, onset, interval, peak, pan) {
      /* hold = interval - attack, so the release starts exactly as the
         next chord's attack does and the change is a crossfade. */
      var attack = range(rnd, DEFAULTS.attackMin, DEFAULTS.attackMax);
      var env = voiceEnvelope({
        start: onset,
        attack: attack,
        hold: Math.max(1, interval - attack),
        release: range(rnd, DEFAULTS.releaseMin, DEFAULTS.releaseMax),
        peak: peak
      });

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0, env.points[0].time);
      gain.gain.linearRampToValueAtTime(env.peak, env.points[1].time);
      gain.gain.setValueAtTime(env.peak, env.points[2].time);
      gain.gain.linearRampToValueAtTime(0, env.end);

      var panner = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        setParam(panner.pan, pan);
        gain.connect(panner);
        panner.connect(nodes.pad);
      } else {
        gain.connect(nodes.pad);
      }

      var type = rnd() < 0.5 ? 'sawtooth' : 'triangle';
      var cents = range(rnd, DEFAULTS.detuneMin, DEFAULTS.detuneMax);
      var freq = midiToFreq(midi);
      var made = [];
      for (var i = 0; i < 2; i += 1) {
        var osc = ctx.createOscillator();
        osc.type = type;
        setParam(osc.frequency, freq);
        setParam(osc.detune, i === 0 ? cents : -cents);
        osc.connect(gain);
        safe(function (node, at, until) {
          return function () { node.start(at); node.stop(until); };
        }(osc, onset, env.end + 0.05));
        made.push(osc);
      }
      live.push({ end: env.end + 0.1, gain: gain, oscillators: made, extra: panner ? [panner] : [] });
      return env;
    }

    function scheduleArpNote(note) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      setParam(osc.frequency, midiToFreq(note.midi));

      var gain = ctx.createGain();
      var end = note.time + note.duration;
      gain.gain.setValueAtTime(0, note.time);
      gain.gain.linearRampToValueAtTime(note.gain, note.time + DEFAULTS.arpAttack);
      safe(function () { gain.gain.exponentialRampToValueAtTime(0.0006, end); });
      gain.gain.setValueAtTime(0, end + 0.01);

      osc.connect(gain);
      gain.connect(nodes.arp);
      safe(function () { osc.start(note.time); osc.stop(end + 0.05); });
      live.push({ end: end + 0.1, gain: gain, oscillators: [osc], extra: [] });
    }

    function scheduleChord(onset) {
      var interval = chordDuration(rnd);
      var chord = chordAt({ mode: mode, rootMidi: DEFAULTS.rootMidi, step: step, voices: voices });
      step += 1;

      var peak = DEFAULTS.padPeak / voices;
      for (var i = 0; i < chord.length; i += 1) {
        var pan = voices > 1 ? ((i / (voices - 1)) * 2 - 1) * 0.5 : 0;
        scheduleVoice(chord[i], onset, interval, peak, pan);
      }

      var notes = arpeggioSchedule({ rnd: rnd, start: onset, duration: interval, chord: chord });
      for (var n = 0; n < notes.length; n += 1) scheduleArpNote(notes[n]);

      /* The cutoff sweep for this window, as steps along the 0.05 Hz sine. */
      var steps = cutoffSteps({ start: onset, duration: interval });
      for (var s = 0; s < steps.length; s += 1) {
        safe(function (step) {
          return function () { nodes.padFilter.frequency.setValueAtTime(step.value, step.time); };
        }(steps[s]));
      }

      return { onset: onset, interval: interval, chord: chord, notes: notes, cutoffSteps: steps };
    }

    /** Drop finished nodes. Free, because a tick already woke us. */
    function prune() {
      var now = ctx.currentTime || 0;
      var keep = [];
      for (var i = 0; i < live.length; i += 1) {
        if (live[i].end > now) keep.push(live[i]);
        else release(live[i], now, false);
      }
      live = keep;
    }

    function release(item, now, hard) {
      if (hard) {
        safe(function () { item.gain.gain.cancelScheduledValues(now); });
        safe(function () { item.gain.gain.setValueAtTime(0, now); });
        for (var i = 0; i < item.oscillators.length; i += 1) {
          safe(function (osc) { return function () { osc.stop(now); }; }(item.oscillators[i]));
        }
      }
      for (var j = 0; j < item.oscillators.length; j += 1) {
        safe(function (osc) { return function () { osc.disconnect(); }; }(item.oscillators[j]));
      }
      safe(function () { item.gain.disconnect(); });
      for (var k = 0; k < item.extra.length; k += 1) {
        safe(function (node) { return function () { node.disconnect(); }; }(item.extra[k]));
      }
    }

    /** One wake-up per chord: schedule it, arm the next. */
    function tick() {
      timer = null;
      if (!playing) return;
      prune();
      var chord = scheduleChord(nextOnset);
      nextOnset += chord.interval;
      var ms = (nextOnset - (ctx.currentTime || 0) - DEFAULTS.lookahead) * 1000;
      timer = timers.setTimeout(tick, Math.max(50, ms));
    }

    /* ---------------- the public surface ---------------- */

    function start() {
      if (playing) return false;
      playing = true;
      build();

      /* A new session every start: new seed, mood, mode, voice count. */
      rnd = makeRandom(fixedSeed == null ? randomSeed() : fixedSeed);
      title = pickTitle(rnd);
      mode = rnd() < 0.5 ? 'dorian' : 'lydian';
      voices = rnd() < 0.5 ? DEFAULTS.voicesMin : DEFAULTS.voicesMax;
      step = Math.floor(rnd() * PROGRESSION.length);

      setVolume(volume, 0);
      if (!offline && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        safe(function () { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); });
      }
      nextOnset = (ctx.currentTime || 0) + 0.05;
      tick();
      return true;
    }

    function stop() {
      if (timer != null) { timers.clearTimeout(timer); timer = null; }
      if (!playing) return false;
      playing = false;

      var now = ctx.currentTime || 0;
      for (var i = 0; i < live.length; i += 1) release(live[i], now, true);
      live = [];

      /* Drop the queued cutoff steps; the next start sweeps from base. */
      if (nodes) {
        safe(function () { nodes.padFilter.frequency.cancelScheduledValues(now); });
        safe(function () { nodes.padFilter.frequency.setValueAtTime(DEFAULTS.cutoffBase, now); });
      }

      /* Suspended, not closed: nothing renders, and the graph (with
         its generated impulse) is still there for the next start. */
      if (!offline && typeof ctx.suspend === 'function' && ctx.state !== 'closed') {
        safe(function () { var p = ctx.suspend(); if (p && p.catch) p.catch(function () {}); });
      }
      return true;
    }

    function setVolume(v, ramp) {
      volume = clamp01(v);
      if (!nodes) return volume;
      var now = ctx.currentTime || 0;
      var seconds = ramp == null ? DEFAULTS.volumeRamp : Math.max(0, Number(ramp) || 0);
      var param = nodes.master.gain;
      safe(function () { param.cancelScheduledValues(now); });
      if (seconds <= 0) {
        safe(function () { param.setValueAtTime(volume, now); });
        if ('value' in param) param.value = volume;
      } else {
        safe(function () { param.setValueAtTime(param.value, now); });
        safe(function () { param.linearRampToValueAtTime(volume, now + seconds); });
      }
      return volume;
    }

    return {
      start: start,
      stop: stop,
      setVolume: setVolume,
      title: function () { return title; },
      isPlaying: function () { return playing; },
      /* For the chrome's readouts and for tests; not part of the contract. */
      state: function () {
        return {
          playing: playing,
          title: title,
          mode: mode,
          voices: voices,
          step: step,
          volume: volume,
          nextOnset: nextOnset,
          liveNodes: live.length,
          timerPending: timer != null,
          built: !!nodes,
          ctxState: ctx.state
        };
      }
    };
  }

  var Ambient = {
    MODES: MODES,
    PROGRESSION: PROGRESSION,
    TITLES: TITLES,
    DEFAULTS: DEFAULTS,
    makeRandom: makeRandom,
    randomSeed: randomSeed,
    clamp01: clamp01,
    midiToFreq: midiToFreq,
    scaleMidi: scaleMidi,
    chordAt: chordAt,
    chordDuration: chordDuration,
    voiceEnvelope: voiceEnvelope,
    quantiseToChord: quantiseToChord,
    arpeggioSchedule: arpeggioSchedule,
    combFeedback: combFeedback,
    reverbLines: reverbLines,
    cutoffSteps: cutoffSteps,
    impulseEnvelope: impulseEnvelope,
    impulseResponse: impulseResponse,
    pickTitle: pickTitle,
    createContext: createContext,
    create: create
  };

  if (typeof window !== 'undefined') window.Ambient = Ambient;
  // node can require() this same file for the harness.
  if (typeof module !== 'undefined' && module.exports) module.exports = Ambient;
})();
