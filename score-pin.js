/*
 * score-pin.js -- one pinned score card (score-pin.html). Draws what score-pins-main.js sends
 * (watch/scores.js decided it) and plays the events: the scoring side's number rolls up,
 * that side gets a brief accent wash, and a one-line strip says what happened for a few
 * seconds ("GOAL · TOR · Matthews (12) · PP", "PENALTY · BOS · Tripping · 2:00"), then the
 * period and clock come back. A power play shows as a pill with its time left while it lasts.
 *
 * MOTION: element.animate() on transform and opacity only, started by an event and done in
 * under 6 s; there is no requestAnimationFrame loop and no timer between events. The one
 * interval is the paused card's "retrying in N s", and only while a read is failing.
 * prefers-reduced-motion: numbers and strips change in place, nothing moves.
 *
 * SOUND: synthesised here with Web Audio, no samples. A goal or score: a short, punchy
 * horn-style chord. A penalty or card: a softer two-note tone. Modest gain under the Windows
 * volume. Only NEW live events sound: a card's first reading has no events, and a catch-up
 * after a long gap arrives marked quiet. The card's mute and the global switch both gate it.
 * ?silent=1 (every test profile) runs the graph at zero gain, and main has muted this
 * window's audio as well; api.played() tells main a sound WOULD have played (the e2e's count).
 *
 * INPUT: the window never takes focus. A press and release without moving opens the game in
 * Lumen; a press that moves over 4 px drags the card (main moves the window); the two
 * buttons mute and close.
 */
(function () {
  'use strict';
  var api = window.api;
  var params = new URLSearchParams(location.search);
  var SILENT = params.get('silent') === '1';
  document.documentElement.setAttribute('data-material', params.get('material') === 'acrylic' ? 'acrylic' : 'solid');

  var $ = function (id) { return document.getElementById(id); };
  var card = $('card');
  var S = { state: null, shown: null, strips: [], stripTimer: 0, retryTimer: 0, soundsPlayed: [], ctx: null, ctxIdle: 0 };
  window.__scorePin = S;   // the e2e reads this (never used by anything else)

  var reduced = function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  var EASE = 'cubic-bezier(.2,.8,.2,1)';

  /* ------------------------------------------------------------------ drawing */

  function clockOf(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function timeOf(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function dayTime(ms) {
    if (!ms) return '';
    var d = new Date(ms), n = new Date();
    var same = d.toDateString() === n.toDateString();
    var tmr = new Date(n.getTime() + 86400000).toDateString() === d.toDateString();
    return (same ? 'Today ' : tmr ? 'Tomorrow ' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + timeOf(ms);
  }

  function setLogo(el, team) {
    if (el._src === team.logo && el._abbr === team.abbr) return;
    el._src = team.logo; el._abbr = team.abbr;
    el.textContent = '';
    if (team.logo) {
      var img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', function () { el.textContent = team.abbr.slice(0, 3); }, { once: true });
      img.src = team.logo;
      el.appendChild(img);
    } else el.textContent = team.abbr.slice(0, 3);
  }

  function lineText(st) {
    var r = st.reading;
    if (!r) return st.health && !st.health.ok ? 'No score yet' : 'Loading score…';
    if (r.phase === 'pre') return dayTime(r.startsAt) || 'Not started';
    var t = r.line || '';
    var s = r.situation;
    if (r.phase === 'live' && s && r.sport === 'football' && s.text) t += ' · ' + s.text;
    if (r.phase === 'live' && s && r.sport === 'baseball' && typeof s.outs === 'number') t += ' · ' + s.outs + (s.outs === 1 ? ' out' : ' out');
    return t;
  }

  function draw(st, animateScores) {
    var r = st.reading;
    var pin = st.pin;
    card.dataset.phase = r ? r.phase : 'pre';
    $('lg').textContent = r ? r.leagueName : (pin.league || '').toUpperCase();
    $('line').textContent = lineText(st);
    ['away', 'home'].forEach(function (side) {
      var row = $(side);
      var team = (r && r[side]) || pin[side];
      setLogo(row.querySelector('.logo'), { logo: pin[side].logo || team.logo, abbr: team.abbr || pin[side].abbr });
      row.querySelector('.ab').textContent = team.abbr || pin[side].abbr;
      row.querySelector('.ab').title = team.name || pin[side].name || '';
      var mine = r ? r[side].score : null;
      var other = r ? r[side === 'away' ? 'home' : 'away'].score : null;
      row.classList.toggle('lo', !!r && r.phase === 'final' && mine !== null && other !== null && mine < other);
      var mark = '';
      if (r && r.strength && r.strength.side === side && r.strength.kind === 'pp') mark = 'PP';
      if (r && r.situation && r.situation.possession === side) mark = '●';
      row.querySelector('.mark').textContent = mark;
      setScore(row, mine === null ? '' : String(mine), animateScores ? animateScores[side] : 0);
    });
    // The power-play pill (or empty net / 4-on-4) while it lasts.
    var pp = $('pp');
    var str = r && r.phase === 'live' ? r.strength : null;
    if (str) {
      pp.textContent = str.text + (str.kind === 'pp' && str.secondsLeft ? ' ' + clockOf(str.secondsLeft) : '');
      pp.className = 'pp' + (str.kind === 'even' ? ' even' : '');
      if (pp.hidden) { pp.hidden = false; fade(pp, true); }
    } else if (!pp.hidden) {
      fade(pp, false, function () { pp.hidden = true; });
    }
    // Paused or partial: the reason, the last update, the retry.
    drawNote(st);
    // Mute: this card, or every card (the global switch).
    var m = $('mute');
    var off = st.muted || !st.sound;
    m.classList.toggle('off', off);
    m.querySelector('.ico').textContent = off ? '' : '';
    var label = !st.sound ? 'Score sounds are off for every card (the palette turns them back on)' : st.muted ? 'Unmute this card' : 'Mute this card';
    m.title = label;
    m.setAttribute('aria-label', label);
    card.setAttribute('aria-label', pin.away.abbr + ' ' + (r && r.away.score !== null ? r.away.score : '') + ', ' + pin.home.abbr + ' ' + (r && r.home.score !== null ? r.home.score : '') + '. ' + lineText(st) + '. Click to open the game in Lumen.');
  }

  function drawNote(st) {
    var note = $('note');
    var h = st.health || { ok: true };
    clearInterval(S.retryTimer);
    S.retryTimer = 0;
    card.classList.toggle('paused', !h.ok);
    if (h.ok && !h.partial) { note.hidden = true; return; }
    note.hidden = false;
    note.classList.toggle('partial', !!h.partial);
    var render = function () {
      var t = h.text || '';
      if (!h.ok && h.retryAt) {
        var left = Math.max(0, Math.round((h.retryAt - Date.now()) / 1000));
        t = t.replace(/retrying in \d+ s/, left > 0 ? 'retrying in ' + left + ' s' : 'retrying now');
      }
      $('noteTxt').textContent = t + '. ' + (st.lastOkAt ? 'Last updated ' + timeOf(st.lastOkAt) : 'No score has come in yet') + '.';
    };
    render();
    // The ONE ticking timer, and only while a read is failing: the retry countdown.
    if (!h.ok && h.retryAt) S.retryTimer = setInterval(function () { render(); if (Date.now() > h.retryAt + 2000) { clearInterval(S.retryTimer); S.retryTimer = 0; } }, 1000);
  }

  /* ---------------------------------------------------------------- animation */

  function fade(el, on, done) {
    if (reduced()) { if (done) done(); return; }
    var a = el.animate(on ? [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 1 }, { opacity: 0, transform: 'scale(.92)' }], { duration: 200, easing: EASE });
    if (done) a.onfinish = done;
  }

  /* The number: dir 1 = rolls up (a score), -1 = rolls down (taken back), 0 = just set. */
  function setScore(row, text, dir) {
    var box = row.querySelector('.sc');
    var cur = box.querySelector('.n:last-child');
    if (cur && cur.textContent === text && !dir) return;
    if (!cur || !dir || reduced()) {
      box.textContent = '';
      var n0 = document.createElement('span');
      n0.className = 'n';
      n0.textContent = text;
      box.appendChild(n0);
      return;
    }
    var old = cur;
    var n = document.createElement('span');
    n.className = 'n';
    n.textContent = text;
    box.appendChild(n);
    var y = dir > 0 ? 100 : -100;
    old.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(' + (-y) + '%)', opacity: 0 }], { duration: 420, easing: EASE, fill: 'forwards' }).onfinish = function () { old.remove(); };
    n.animate([{ transform: 'translateY(' + y + '%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 520, delay: 80, easing: EASE, fill: 'backwards' });
  }

  function wash(side) {
    var w = $(side).querySelector('.wash');
    if (reduced()) {
      w.style.opacity = '1';
      setTimeout(function () { w.style.opacity = ''; }, 2000);
      return;
    }
    w.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: 2600, easing: 'ease-out' });
  }

  function flash() {
    if (reduced()) return;
    card.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 900, pseudoElement: '::after' });
  }

  /* The strip: one line at a time, ~5.5 s each, queued. */
  function queueStrip(ev) {
    if (!ev.strip) return;
    S.strips.push(ev);
    if (S.strips.length === 1) showStrip();
  }
  function showStrip() {
    var ev = S.strips[0];
    if (!ev) return;
    var strip = $('strip'), line = $('pp').parentNode;
    strip.className = 'strip ' + (ev.kind === 'card' ? 'card-' + ev.card : ev.kind);
    $('stripTxt').textContent = ev.strip;
    strip.title = ev.strip;
    strip.hidden = false;
    if (!reduced()) {
      strip.animate([{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: EASE });
      line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    } else line.style.opacity = '0';
    S.stripTimer = setTimeout(function () {
      var done = function () {
        strip.hidden = true;
        line.getAnimations().forEach(function (a) { a.cancel(); });
        line.style.opacity = '';
        S.strips.shift();
        if (S.strips.length) showStrip();
      };
      if (reduced()) { done(); return; }
      strip.animate([{ opacity: 1 }, { transform: 'translateY(-60%)', opacity: 0 }], { duration: 260, easing: 'ease-in' }).onfinish = done;
      line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, fill: 'forwards' });
    }, 5500);
  }

  /* ------------------------------------------------------------------- sound */

  function audio() {
    if (!S.ctx) {
      try { S.ctx = new AudioContext({ latencyHint: 'interactive' }); } catch (e) { S.ctx = null; return null; }
    }
    if (S.ctx.state === 'suspended') S.ctx.resume();
    // Let the audio device go a moment after the last sound: an idle card holds no stream.
    clearTimeout(S.ctxIdle);
    S.ctxIdle = setTimeout(function () { if (S.ctx) S.ctx.suspend(); }, 2500);
    return S.ctx;
  }

  function master(ctx, level) {
    var g = ctx.createGain();
    g.gain.value = SILENT ? 0 : level;
    g.connect(ctx.destination);
    return g;
  }

  /* A goal horn, made here: three detuned saws on a low major chord through a low-pass, a fast
     swell and a short tail. About a second. */
  function horn(ctx) {
    var t = ctx.currentTime + 0.02;
    var out = master(ctx, 0.15);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.linearRampToValueAtTime(1800, t + 0.12); lp.Q.value = 0.7;
    lp.connect(out);
    var env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.05);
    env.gain.setValueAtTime(1, t + 0.62);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    env.connect(lp);
    [174.61, 220.0, 261.63, 349.23].forEach(function (f, i) {
      [-6, 6].forEach(function (cents) {
        var o = ctx.createOscillator();
        o.type = i === 3 ? 'square' : 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents;
        var g = ctx.createGain();
        g.gain.value = i === 3 ? 0.05 : 0.11;
        o.connect(g); g.connect(env);
        o.start(t); o.stop(t + 1.1);
      });
    });
  }

  /* A penalty or card: softer and plainly different, two sine notes stepping down. */
  function tone(ctx) {
    var t = ctx.currentTime + 0.02;
    var out = master(ctx, 0.09);
    [[659.25, 0], [493.88, 0.17]].forEach(function (n) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = n[0];
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + n[1]);
      g.gain.exponentialRampToValueAtTime(1, t + n[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.3);
      o.connect(g); g.connect(out);
      o.start(t + n[1]); o.stop(t + n[1] + 0.32);
    });
  }

  function play(kind) {
    var ctx = audio();
    if (!ctx) return;
    try { if (kind === 'horn') horn(ctx); else tone(ctx); } catch (e) { return; }
    S.soundsPlayed.push(kind);
    try { api.played(kind); } catch (e) { /* closing */ }
  }

  /* ------------------------------------------------------------------ events */

  function apply(st) {
    var first = !S.state;
    var prevKey = S.state && S.state.key;
    S.state = st;
    var events = Array.isArray(st.events) ? st.events : [];
    var dirs = { away: 0, home: 0 };
    events.forEach(function (ev) {
      if (ev.kind === 'score') dirs[ev.side] = 1;
      if (ev.kind === 'overturned') dirs[ev.side] = -1;
    });
    draw(st, first || prevKey !== st.key ? null : dirs);
    var sound = '';
    events.forEach(function (ev) {
      if (ev.kind === 'score' && !reducedSkip(ev)) wash(ev.side);
      if (ev.kind === 'penalty' && !reducedSkip(ev)) wash(ev.side === 'away' ? 'home' : 'away');   // the side going on the power play
      queueStrip(ev);
      if (!ev.quiet && ev.sound === 'horn') sound = 'horn';
      else if (!ev.quiet && ev.sound && !sound) sound = ev.sound;
    });
    if (sound && st.sound && !st.muted) play(sound);
    if (st.flash) flash();
  }
  function reducedSkip(ev) { return ev.minor && reduced(); }

  /* -------------------------------------------------------------------- input */

  var press = null;
  card.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || e.target.closest('.tool')) return;
    press = { x: e.screenX, y: e.screenY, dragging: false, id: e.pointerId };
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
  });
  card.addEventListener('pointermove', function (e) {
    if (!press || e.pointerId !== press.id) return;
    var dx = e.screenX - press.x, dy = e.screenY - press.y;
    if (!press.dragging && Math.abs(dx) + Math.abs(dy) > 4) { press.dragging = true; api.drag('start', 0, 0); }
    if (press.dragging) api.drag('move', dx, dy);
  });
  card.addEventListener('pointerup', function (e) {
    if (!press || e.pointerId !== press.id) return;
    var p = press;
    press = null;
    if (p.dragging) api.drag('end', e.screenX - p.x, e.screenY - p.y);
    else if (!e.target.closest('.tool')) api.open();
  });
  card.addEventListener('pointercancel', function () { if (press && press.dragging) api.drag('end', 0, 0); press = null; });
  $('close').addEventListener('click', function (e) { e.stopPropagation(); api.close(); });
  $('mute').addEventListener('click', function (e) {
    e.stopPropagation();
    if (!S.state) return;
    if (!S.state.sound) return;            // the global switch is off: the palette owns that one
    api.mute(!S.state.muted);
  });

  /* ------------------------------------------------------------- look + size */

  function applyLook(l) {
    if (!l) return;
    document.documentElement.setAttribute('data-theme', l.theme === 'light' ? 'light' : 'dark');
    if (typeof window.__applyPalette === 'function') window.__applyPalette(l.palette || null);
    if (typeof window.__applyAccent === 'function' && typeof l.hue === 'number') window.__applyAccent(l.hue);
  }

  var lastH = 0;
  new ResizeObserver(function () {
    var h = Math.ceil(card.getBoundingClientRect().height);
    if (h && h !== lastH) { lastH = h; api.height(h); }
  }).observe(card);

  api.onState(function (st) { if (st && st.pin) { if (st.look) applyLook(st.look); apply(st); } });
  api.onLook(applyLook);
  api.ready();
})();
