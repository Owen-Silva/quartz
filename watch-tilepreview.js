'use strict';
/*
 * watch-tilepreview.js -- YouTube-style hover previews INSIDE a tile on Lumen's rows.
 *
 * The user (10-18): "if i hover my mouse over videos after you scroll down can it show a preview just
 * like youtube does if you hover over videos?" At the first row the hero (the stage) already plays
 * the hovered title (watch.js "the hover preview"). Past it the hero is gone, so the tile itself
 * plays, the way YouTube's feed does:
 *   - rest the pointer on a tile for HOVER_DELAY_MS: its art box plays the video, muted, and
 *     cross-fades from the still only once the player says it is playing (no black flash);
 *   - a thin progress line along the art's bottom; Lumen's own mute and CC toggles in the top
 *     right corner; the mute choice is remembered (this page's localStorage);
 *   - leave the tile, scroll, step a row, search, hide the tab: the player is REMOVED (src
 *     about:blank, then the element), not hidden; nothing decodes, nothing is fetched;
 *   - ONE preview at a time: one controller owns at most one player, and a new tile tears the old
 *     one down first; a fast sweep across a row starts nothing (the clock restarts on every tile);
 *   - a click while it previews opens the real player at the previewed time (YouTube &t=Ns).
 * What plays (watch/preview.js sourceFor, the stage's rule): a YouTube tile its own video; a
 * Disney+, Hulu or Prime tile its TMDB trailer (the stage's quartz-watch:preview lookup, with seq
 * numbers from SEQ_BASE up so the two never mix), and with no trailer nothing plays and the tile
 * stays still. Live and upcoming events, ESPN games and My teams never preview.
 * Gates: Settings > Lumen "Preview videos when I hover" (on by default), main's word (a game
 * running, battery saver on, under MIN_FREE_GB of free memory: quartz-watch:tilepv, answered by
 * watch-main.js from gateMain below), the Lumen tab in sight, and Windows' reduce-motion setting
 * (then nothing autoplays). A blocked hover says why in a small corner note, never a broken box.
 * No timers or listeners run per frame: at rest the only work is the pointerover listener.
 *
 * Loads two ways: require('./watch-tilepreview') in watch-main.js and the unit tests (pure parts +
 * createController with injected timers), and <script src="watch-tilepreview.js"> in watch.html
 * (window.WatchTilePreview; watch.js calls attach() at boot).
 */
(function (root, factory) {
  var PV = null;
  if (typeof module === 'object' && module && module.exports) {
    try { PV = require('./watch/preview'); } catch (e) { PV = null; }
    module.exports = factory(PV);
  } else if (root) {
    root.WatchTilePreview = factory(root.WatchPreview || null);
    // main's answer to quartz-watch:tilepv (watch-main.js)
    root.__applyWatchTilePreview = function (raw) { root.WatchTilePreview.onGate(raw); };
  }
})(typeof window !== 'undefined' ? window : this, function (PV) {
  var HOVER_DELAY_MS = 800;
  var MIN_FREE_GB = 1.5;
  var SEQ_BASE = 1000000000;          // trailer asks from here up: watch.js's stage preview counts from 0
  var LOAD_MS = 9000;                 // the player's document must load in this long, or the tile goes back to still
  var REVEAL_FALLBACK_MS = 2500;      // the stage's rule: if the player's messages never arrive, show it anyway
  var MUTE_KEY = 'lumen.tilePreview.muted';
  var CC_KEY = 'lumen.tilePreview.cc';
  var YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /* ------------------------------------------------------------ pure parts */

  /**
   * Main's half of the gate (watch-main.js answers quartz-watch:tilepv with it): '' = may play, or
   * the reason in plain words. o: { mode: 'live'|'mock'|'off', on, gaming, saver, freeGb, minFreeGb }.
   */
  function gateMain(o) {
    var x = o && typeof o === 'object' ? o : {};
    if (x.mode === 'off') return 'Previews are off in a test profile';
    if (x.on === false) return 'Hover previews are off in Settings > Lumen';
    if (x.gaming) return 'No preview while ' + (String(x.gaming).toLowerCase() === 'valorant' ? 'VALORANT' : String(x.gaming)) + ' is running';
    if (x.saver === true) return 'No preview while battery saver is on';
    var min = typeof x.minFreeGb === 'number' && isFinite(x.minFreeGb) ? x.minFreeGb : MIN_FREE_GB;
    if (typeof x.freeGb === 'number' && isFinite(x.freeGb) && x.freeGb < min) {
      return 'No preview: only ' + x.freeGb.toFixed(1) + ' GB of memory is free (previews need ' + min + ' GB)';
    }
    return '';
  }

  /**
   * The page's half: { code, reason }. code '' = may go on; 'quiet' = not now, say nothing (off,
   * out of sight, searching, the stage plays it instead); 'note' = not now, and the tile says why.
   */
  function gateLocal(o) {
    var x = o && typeof o === 'object' ? o : {};
    if (!x.pvOn) return { code: 'quiet', reason: 'previews are off (main has not said on)' };
    if (x.tilesOn === false) return { code: 'quiet', reason: 'Hover previews are off in Settings > Lumen' };
    if (x.hidden || x.front === false) return { code: 'quiet', reason: 'the Lumen tab is not in sight' };
    if (x.searching) return { code: 'quiet', reason: 'searching' };
    if (x.stageOwns) return { code: 'quiet', reason: 'the hero plays this title' };
    if (x.reduced) return { code: 'note', reason: 'Previews don’t autoplay while Windows is set to reduce motion' };
    return { code: '', reason: '' };
  }

  /**
   * What a tile previews: { type: 'youtube', videoId, start } | { type: 'trailer', title, tv } |
   * { type: 'none', reason }. The stage's rule (watch/preview.js sourceFor), minus everything that
   * is not a title: live and upcoming events, ESPN, games and teams.
   */
  function tileSource(item, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    if (!item || typeof item !== 'object') return { type: 'none', reason: 'not a title' };
    if (o.event || o.team) return { type: 'none', reason: 'games and teams don’t preview' };
    if (item.kind === 'live' || item.kind === 'upcoming') return { type: 'none', reason: 'live and upcoming events don’t preview' };
    if (item.service === 'espn') return { type: 'none', reason: 'ESPN doesn’t preview' };
    if (!PV) return { type: 'none', reason: 'this build is missing watch/preview.js' };
    var s = PV.sourceFor(item, { hasTmdbKey: !!o.hasTmdbKey });
    if (s.type === 'youtube') return { type: 'youtube', videoId: s.videoId, start: s.start || 0 };
    if (s.type === 'trailer') return { type: 'trailer', title: s.title, tv: !!s.tv };
    return { type: 'none', reason: s.reason || 'nothing to preview' };
  }

  /** The YouTube video id a watch URL plays, or ''. */
  function videoIdOfUrl(url) {
    if (!PV) return '';
    return PV.youtubeIdOf({ url: String(url || '') });
  }

  /**
   * The hand-off: `url` (a YouTube watch or youtu.be URL for `videoId`) set to start at `seconds`
   * (t=Ns, replacing any t= already there). Any other URL, a different video, or under 1 s comes
   * back unchanged.
   */
  function atUrl(url, seconds, videoId) {
    var s = Math.floor(Number(seconds) || 0);
    if (s < 1 || !YT_ID_RE.test(String(videoId || ''))) return url;
    if (videoIdOfUrl(url) !== videoId) return url;
    var u;
    try { u = new URL(String(url)); } catch (e) { return url; }
    u.searchParams.delete('start');
    u.searchParams.set('t', s + 's');
    return u.toString();
  }

  /*
   * One message from the embedded player -> { playing } | { error } | { time, duration } | null.
   * State and errors are watch/preview.js readPlayerMessage's; YouTube's infoDelivery also carries
   * currentTime and duration (the hand-off time and the progress line).
   */
  function readMessage(data) {
    var m = PV ? PV.readPlayerMessage(data) : null;
    var d = data;
    if (typeof d === 'string') {
      if (d.length > 20000 || d.charAt(0) !== '{') return m;
      try { d = JSON.parse(d); } catch (e) { return m; }
    }
    var out = m ? Object.assign({}, m) : null;
    if (d && typeof d === 'object' && (d.event === 'infoDelivery' || d.event === 'initialDelivery') && d.info && typeof d.info === 'object') {
      var t = Number(d.info.currentTime), du = Number(d.info.duration);
      if (isFinite(t) && t >= 0) { out = out || {}; out.time = t; }
      if (isFinite(du) && du > 0) { out = out || {}; out.duration = du; }
    }
    return out;
  }

  /** A YouTube IFrame-API command, as the embed's postMessage channel takes it. */
  function command(func, args) {
    return JSON.stringify({ event: 'command', func: String(func), args: Array.isArray(args) ? args : [], id: 1, channel: 'widget' });
  }

  /* ------------------------------------------------------------ the controller */

  /*
   * d (injected; the DOM layer below or a unit test):
   *   setTimeout, clearTimeout, now()                    timers and the clock
   *   send(verb, msg)                                    quartz-watch:<verb> to main
   *   local()        -> gateLocal's input               (read at the moment it is needed)
   *   hovered(tile)  -> bool                             is the pointer still on the tile
   *   alive(tile)    -> bool                             still on the page, in the lens row
   *   itemOf(tile)   -> { item, event, team }            what the tile is
   *   hasTmdbKey(), mock()
   *   mount(tile, url, view) -> handle                   view: { muted, cc, kind, durationSec }
   *        handle: { post(str), reveal(), progress(time, duration), muted(bool), cc(bool), destroy() }
   *   note(tile, text) -> handle { destroy() }           a blocked hover's corner note
   *   store: { get(k), set(k, v) }                       the remembered mute and CC
   */
  function createController(d) {
    var st = {
      tile: null, item: null, timer: 0, loadTimer: 0, revealTimer: 0,
      phase: 'idle',               // idle | wait | gate | trailer | mounted | playing | none | blocked
      gateSeq: 0, trailerN: 0, trailerSeq: 0, src: null,
      handle: null, noteH: null, videoId: '', kind: '', start: 0,
      playingAt: 0, time: -1, timeAt: 0, duration: 0,
      starts: 0, mounts: 0, destroys: 0, sentGates: 0, sentTrailers: 0, lastWhy: ''
    };
    var muted = readBool(MUTE_KEY, true);
    var cc = readBool(CC_KEY, false);

    function readBool(k, dflt) {
      try { var v = d.store ? d.store.get(k) : null; return v === '1' ? true : v === '0' ? false : dflt; } catch (e) { return dflt; }
    }
    function writeBool(k, v) { try { if (d.store) d.store.set(k, v ? '1' : '0'); } catch (e) { /* storage off: this page only */ } }
    function clearT(name) { if (st[name]) { d.clearTimeout(st[name]); st[name] = 0; } }

    /** Tear everything down: the timers, a late answer, the player (removed, not hidden), the note. */
    function stop(why) {
      clearT('timer'); clearT('loadTimer'); clearT('revealTimer');
      st.gateSeq++;
      st.trailerSeq = 0;
      if (st.handle) { var h = st.handle; st.handle = null; st.destroys++; try { h.destroy(); } catch (e) { /* gone anyway */ } }
      if (st.noteH) { var n = st.noteH; st.noteH = null; try { n.destroy(); } catch (e) { /* gone */ } }
      st.tile = null; st.item = null; st.src = null; st.phase = 'idle';
      st.videoId = ''; st.kind = ''; st.start = 0; st.playingAt = 0; st.time = -1; st.timeAt = 0; st.duration = 0;
      st.lastWhy = why || '';
    }

    function note(text) {
      if (st.noteH) { try { st.noteH.destroy(); } catch (e) { /* gone */ } st.noteH = null; }
      if (text && d.note && st.tile) st.noteH = d.note(st.tile, text);
    }

    /** The pointer came onto a tile: restart the clock (a sweep never lets it run out). */
    function enter(tile) {
      if (!tile) return;
      if (st.tile === tile && st.phase !== 'idle') return;
      stop('another tile');
      var g = gateLocal(d.local());
      if (g.code === 'quiet') { st.lastWhy = g.reason; return; }
      st.tile = tile;
      st.phase = 'wait';
      st.timer = d.setTimeout(fire, HOVER_DELAY_MS);
    }

    function leave(tile) { if (tile && st.tile === tile) stop('left the tile'); }

    function fire() {
      st.timer = 0;
      var tile = st.tile;
      if (!tile || st.phase !== 'wait') return;
      if (!d.alive(tile) || !d.hovered(tile)) { stop('not on the tile any more'); return; }
      var g = gateLocal(d.local());
      if (g.code === 'quiet') { stop(g.reason); return; }
      if (g.code === 'note') { st.phase = 'blocked'; note(g.reason); st.lastWhy = g.reason; return; }
      var what = d.itemOf(tile) || {};
      st.item = what.item || null;
      st.src = tileSource(what.item, { event: !!what.event, team: !!what.team, hasTmdbKey: !!d.hasTmdbKey() });
      if (st.src.type === 'none') { st.phase = 'none'; st.lastWhy = st.src.reason; return; }   // the tile stays still
      st.phase = 'gate';
      st.sentGates++;
      d.send('tilepv', { seq: st.gateSeq });
    }

    /** Main's word on the gate: { seq, ok, reason }. */
    function onGate(raw) {
      if (!raw || typeof raw !== 'object' || raw.seq !== st.gateSeq || st.phase !== 'gate') return;
      if (!st.tile || !d.alive(st.tile) || !d.hovered(st.tile)) { stop('not on the tile any more'); return; }
      if (raw.ok !== true) {
        st.phase = 'blocked';
        st.lastWhy = String(raw.reason || 'No preview right now').slice(0, 200);
        // his own Settings choice and a test profile say nothing; a game, battery saver or memory do
        if (!/Settings > Lumen|test profile/.test(st.lastWhy)) note(st.lastWhy);
        return;
      }
      var s = st.src;
      if (s && s.type === 'youtube') { mount(s.videoId, s.start, 'youtube'); return; }
      if (s && s.type === 'trailer') {
        st.trailerN++;
        st.trailerSeq = SEQ_BASE + st.trailerN;
        st.phase = 'trailer';
        st.sentTrailers++;
        d.send('preview', { title: s.title, tv: !!s.tv, seq: st.trailerSeq });
        return;
      }
      stop('nothing to play');
    }

    /** A TMDB trailer answer: true when it was this file's (seq from SEQ_BASE up), so watch.js skips it. */
    function onTrailer(raw) {
      if (!raw || typeof raw !== 'object' || !(Number(raw.seq) >= SEQ_BASE)) return false;
      if (raw.seq !== st.trailerSeq || st.phase !== 'trailer') return true;
      if (!st.tile || !d.alive(st.tile) || !d.hovered(st.tile)) { stop('not on the tile any more'); return true; }
      if (raw.state === 'ok' && YT_ID_RE.test(String(raw.videoId || ''))) { mount(String(raw.videoId), 0, 'trailer'); return true; }
      st.phase = 'none';             // no trailer: nothing plays, the tile stays still
      st.lastWhy = String(raw.reason || 'no trailer').slice(0, 200);
      return true;
    }

    function mount(videoId, start, kind) {
      var url = PV ? PV.embedUrl(videoId, start, PV.embedOrigin(!!d.mock())) : '';
      if (!url) { stop('not a YouTube video id'); return; }
      if (st.handle) { var old = st.handle; st.handle = null; st.destroys++; try { old.destroy(); } catch (e) { /* gone */ } }
      var durationSec = st.item && typeof st.item.durationSec === 'number' && kind === 'youtube' ? st.item.durationSec : 0;
      st.handle = d.mount(st.tile, url, { muted: muted, cc: cc, kind: kind, durationSec: durationSec, title: st.item ? st.item.title || '' : '' });
      if (!st.handle) { stop('the art box is gone'); return; }
      st.mounts++;
      st.starts++;
      st.phase = 'mounted';
      st.videoId = videoId; st.kind = kind; st.start = start || 0;
      st.duration = durationSec;
      st.loadTimer = d.setTimeout(function () { st.loadTimer = 0; if (st.phase === 'mounted') stop('the player did not load'); }, LOAD_MS);
    }

    /** The player's document loaded: say "listening" (the DOM layer does), and arm the fallback reveal. */
    function loaded() {
      if (!st.handle) return;
      clearT('loadTimer');
      clearT('revealTimer');
      st.revealTimer = d.setTimeout(function () { st.revealTimer = 0; if (st.phase === 'mounted') playing(); }, REVEAL_FALLBACK_MS);
    }

    function playing() {
      if (!st.handle) return;
      clearT('loadTimer'); clearT('revealTimer');
      if (st.phase !== 'playing') {
        st.phase = 'playing';
        st.playingAt = d.now();
        if (!muted) st.handle.post(command('unMute'));
        if (cc) st.handle.post(command('loadModule', ['captions']));
        st.handle.reveal();
        if (st.duration > 0) st.handle.progress(currentTime(), st.duration);
      }
    }

    /** One parsed player message (the DOM layer checked it came from this player's frame). */
    function onMessage(data) {
      if (!st.handle) return;
      var m = readMessage(data);
      if (!m) return;
      if (m.error !== undefined) { stop('the player stopped with error ' + m.error); return; }   // back to the still
      if (typeof m.duration === 'number' && m.duration > 0) {
        var had = st.duration;
        st.duration = m.duration;
        if (st.phase === 'playing' && Math.abs(had - m.duration) > 1) st.handle.progress(currentTime(), st.duration);
      }
      if (typeof m.time === 'number') {
        var drift = st.phase === 'playing' ? Math.abs(currentTime() - m.time) : 0;
        st.time = m.time; st.timeAt = d.now();
        if (st.phase === 'playing' && st.duration > 0 && drift > 1.5) st.handle.progress(m.time, st.duration);
      }
      if (m.playing === true) playing();
    }

    /** Where the preview is, in seconds: the player's last word plus the time since, or start plus the time playing. */
    function currentTime() {
      if (st.phase !== 'playing') return st.start;
      var t = d.now();
      if (st.time >= 0) return st.time + Math.max(0, t - st.timeAt) / 1000;
      return st.start + Math.max(0, t - st.playingAt) / 1000;
    }

    /** watch.js openUrl: the URL to open (with &t= when this tile was previewing it); the preview ends. */
    function handoff(url) {
      var out = url;
      if (st.handle && st.kind === 'youtube' && st.phase === 'playing') out = atUrl(url, currentTime(), st.videoId);
      if (st.phase !== 'idle') stop('opened');
      return out;
    }

    function toggleMute() {
      muted = !muted;
      writeBool(MUTE_KEY, muted);
      if (st.handle) { st.handle.post(command(muted ? 'mute' : 'unMute')); st.handle.muted(muted); }
      return muted;
    }
    function toggleCc() {
      cc = !cc;
      writeBool(CC_KEY, cc);
      if (st.handle) { st.handle.post(command(cc ? 'loadModule' : 'unloadModule', ['captions'])); st.handle.cc(cc); }
      return cc;
    }

    /** Something moved (a row step, a redraw, the hero back): the tile must still be there and hovered. */
    function check() {
      if (!st.tile) return;
      if (!d.alive(st.tile)) { stop('the tile moved or went'); return; }
      var g = gateLocal(d.local());
      if (g.code === 'quiet') stop(g.reason);
    }

    return {
      enter: enter, leave: leave, stop: stop, check: check, onGate: onGate, onTrailer: onTrailer,
      onMessage: onMessage, loaded: loaded, handoff: handoff, toggleMute: toggleMute, toggleCc: toggleCc,
      currentTime: currentTime,
      tile: function () { return st.tile; },
      state: function () {
        return { phase: st.phase, videoId: st.videoId, kind: st.kind, start: st.start, duration: st.duration, muted: muted, cc: cc,
          starts: st.starts, mounts: st.mounts, destroys: st.destroys, sentGates: st.sentGates, sentTrailers: st.sentTrailers,
          timer: !!st.timer, live: !!st.handle, why: st.lastWhy, srcType: st.src ? st.src.type : '' };
      }
    };
  }

  /* ------------------------------------------------------------ the page (watch.html) */

  var ctl = null;
  var mode = { on: false, mock: false, tiles: true };

  function setMode(p) {
    if (!p || typeof p !== 'object') return;
    mode.on = p.on === true;
    mode.mock = p.mock === true;
    if (typeof p.tiles === 'boolean') mode.tiles = p.tiles;
    if (ctl) ctl.check();
  }

  function svgIcon(paths) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  var ICON = {
    muted: ['M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5z', 'M10.6 6.1l3.8 3.8M14.4 6.1l-3.8 3.8'],
    sound: ['M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5z', 'M10.4 5.6a3.4 3.4 0 0 1 0 4.8', 'M12.2 3.9a5.8 5.8 0 0 1 0 8.2'],
    cc: ['M2.2 4.2h11.6v7.6H2.2z', 'M7 6.9a1.6 1.6 0 1 0 0 2.2', 'M11.2 6.9a1.6 1.6 0 1 0 0 2.2']
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /**
   * attach(H) from watch.js boot. H: { stack, send, snap(), stageOwns(), searching(), front(), reduced() }.
   * Returns the controller (tests reach it as window.WatchTilePreview._ctl()).
   */
  function attach(H) {
    if (ctl || !H || !H.stack || typeof document === 'undefined') return ctl;
    var stack = H.stack;
    var cur = null;     // the DOM half of the one mounted player: { wrap, frame, origin, tile }

    function tileOf(t) {
      var c = t && t.closest ? t.closest('.card') : null;
      if (!c || !stack.contains(c) || c.classList.contains('sk-card') || c.classList.contains('yt-state')) return null;
      if (!c._item || c._event || c._team || c._ytAction) return null;
      return c;
    }

    function store() {
      return {
        get: function (k) { return window.localStorage.getItem(k); },
        set: function (k, v) { window.localStorage.setItem(k, v); }
      };
    }

    function mountDom(tile, url, view) {
      var art = tile.querySelector('.art');
      if (!art) return null;
      var origin = '';
      try { origin = new URL(url).origin; } catch (e) { return null; }
      var wrap = el('span', 'tpv');
      wrap.setAttribute('aria-hidden', 'false');
      var vid = el('span', 'tpv-vid');
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.setAttribute('allow', 'autoplay; encrypted-media');
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      f.title = 'Preview' + (view.title ? ': ' + view.title : '');
      vid.appendChild(f);
      wrap.appendChild(vid);
      var bar = el('span', 'tpv-bar');
      var fill = el('i');
      bar.appendChild(fill);
      wrap.appendChild(bar);
      var ctlBox = el('span', 'tpv-ctl');
      var bMute = el('span', 'tpv-btn tpv-mute');
      var bCc = el('span', 'tpv-btn tpv-cc');
      [bMute, bCc].forEach(function (b) {
        b.setAttribute('role', 'button');
        b.addEventListener('pointerdown', function (e) { e.stopPropagation(); e.preventDefault(); });
        b.addEventListener('mousedown', function (e) { e.stopPropagation(); e.preventDefault(); });
        ctlBox.appendChild(b);
      });
      bMute.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); if (ctl) ctl.toggleMute(); });
      bCc.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); if (ctl) ctl.toggleCc(); });
      wrap.appendChild(ctlBox);

      function drawMute(m) {
        bMute.replaceChildren(svgIcon(m ? ICON.muted : ICON.sound));
        bMute.setAttribute('aria-label', m ? 'Unmute preview' : 'Mute preview');
        bMute.title = m ? 'Unmute' : 'Mute';
        bMute.setAttribute('aria-pressed', m ? 'true' : 'false');
      }
      function drawCc(on) {
        bCc.replaceChildren(svgIcon(ICON.cc));
        bCc.classList.toggle('on', !!on);
        bCc.setAttribute('aria-label', on ? 'Turn captions off' : 'Turn captions on');
        bCc.title = on ? 'Captions on' : 'Captions off';
        bCc.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      drawMute(view.muted);
      drawCc(view.cc);

      f.addEventListener('load', function () {
        if (!cur || cur.frame !== f) return;
        try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), origin); } catch (err) { /* the fallback reveal covers it */ }
        if (ctl) ctl.loaded();
      });
      art.appendChild(wrap);
      tile.classList.add('tpv-host');
      cur = { wrap: wrap, frame: f, origin: origin, tile: tile };
      var mine = cur;
      f.src = url;
      return {
        post: function (msg) { try { if (f.contentWindow) f.contentWindow.postMessage(msg, origin); } catch (e) { /* gone */ } },
        reveal: function () { wrap.classList.add('on'); tile.classList.add('tpv-on'); },
        progress: function (time, duration) {
          if (!(duration > 0)) { bar.classList.remove('run'); return; }
          var from = Math.max(0, Math.min(1, time / duration));
          var left = Math.max(0.5, duration - time);
          // one compositor animation for the rest of the video: no per-frame script
          fill.style.setProperty('--tpv-from', String(from));
          fill.style.setProperty('--tpv-left', left.toFixed(2) + 's');
          bar.classList.remove('run');
          void fill.offsetWidth;
          bar.classList.add('run');
        },
        muted: drawMute,
        cc: drawCc,
        destroy: function () {
          try { f.src = 'about:blank'; } catch (e) { /* going anyway */ }
          f.remove();
          wrap.remove();
          tile.classList.remove('tpv-host', 'tpv-on');
          if (cur === mine) cur = null;
        }
      };
    }

    function noteDom(tile, text) {
      var art = tile.querySelector('.art');
      if (!art) return null;
      var n = el('span', 'tpv-note', text);
      n.title = text;
      n.setAttribute('role', 'status');
      art.appendChild(n);
      return { destroy: function () { n.remove(); } };
    }

    ctl = createController({
      setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); },
      clearTimeout: function (h) { window.clearTimeout(h); },
      now: function () { return Date.now(); },
      send: H.send,
      local: function () {
        return { pvOn: mode.on, tilesOn: mode.tiles, hidden: document.hidden, front: H.front(), searching: H.searching(),
          stageOwns: H.stageOwns(), reduced: H.reduced() };
      },
      hovered: function (tile) { try { return tile.matches(':hover'); } catch (e) { return false; } },
      alive: function (tile) { return !!(tile.isConnected && tile.closest('.lrow[data-d="0"]')); },
      itemOf: function (tile) { return { item: tile._item || null, event: tile._event || null, team: tile._team || null }; },
      hasTmdbKey: function () { var s = H.snap(); return !!(s && s.tmdb && s.tmdb.hasKey); },
      mock: function () { return mode.mock; },
      mount: mountDom,
      note: noteDom,
      store: store()
    });

    stack.addEventListener('pointerover', function (e) {
      var t = tileOf(e.target);
      if (t) ctl.enter(t);
      else if (ctl.tile() && !(ctl.tile().contains && ctl.tile().contains(e.target))) ctl.stop('left the tile');
    });
    stack.addEventListener('pointerout', function (e) {
      var t = ctl.tile();
      if (!t) return;
      var to = e.relatedTarget;
      if (to && t.contains(to)) return;
      ctl.leave(t);
    });
    // a click on the tile went to watch.js first (openUrl asked for the hand-off); whatever it opened, the preview ends
    stack.addEventListener('click', function () { if (ctl.tile()) ctl.stop('clicked'); });
    window.addEventListener('wheel', function () { if (ctl.tile()) ctl.stop('scrolled'); }, { passive: true, capture: true });
    window.addEventListener('keydown', function (e) {
      if (!ctl.tile()) return;
      if (/^(Arrow|Page|Home|End|Tab|Escape|Enter| )/.test(e.key)) ctl.stop('a key');
    }, true);
    window.addEventListener('blur', function () { if (ctl.tile()) ctl.stop('window blur'); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && ctl.tile()) ctl.stop('hidden'); });
    window.addEventListener('message', function (e) {
      if (!cur || e.origin !== cur.origin) return;
      var cw = null;
      try { cw = cur.frame.contentWindow; } catch (err) { cw = null; }
      if (!cw || e.source !== cw) return;
      ctl.onMessage(e.data);
    });
    return ctl;
  }

  return {
    HOVER_DELAY_MS: HOVER_DELAY_MS,
    MIN_FREE_GB: MIN_FREE_GB,
    SEQ_BASE: SEQ_BASE,
    LOAD_MS: LOAD_MS,
    REVEAL_FALLBACK_MS: REVEAL_FALLBACK_MS,
    MUTE_KEY: MUTE_KEY,
    gateMain: gateMain,
    gateLocal: gateLocal,
    tileSource: tileSource,
    atUrl: atUrl,
    readMessage: readMessage,
    command: command,
    createController: createController,
    attach: attach,
    setMode: setMode,
    // watch.js hooks: safe to call before attach
    onTrailer: function (raw) { return !!(ctl && ctl.onTrailer(raw)) || !!(raw && Number(raw.seq) >= SEQ_BASE); },
    onGate: function (raw) { if (ctl) ctl.onGate(raw); },
    handoff: function (url) { return ctl ? ctl.handoff(url) : url; },
    check: function () { if (ctl) ctl.check(); },
    stop: function (why) { if (ctl) ctl.stop(why); },
    _ctl: function () { return ctl; }
  };
});
