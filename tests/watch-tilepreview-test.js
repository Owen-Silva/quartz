// tests/watch-tilepreview-test.js -- the hover previews inside Lumen's tiles, without Electron:
// watch-tilepreview.js's pure parts (the gates, what a tile plays, the &t= hand-off, the player's
// messages) and its controller driven by fake timers and a fake DOM half (the hover delay, a sweep
// starts nothing, one player at a time, the gates, trailer-or-nothing, the hand-off, the remembered
// mute), plus watch-main.js's half (quartz-watch:tilepv, the Settings switch, the snapshot word) on
// fakes. No network, no account. One summary line: "watch-tilepreview-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TP = require('../watch-tilepreview');
const Pv = require('../watch/preview');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)));
}

const YT = { id: 'youtube:dQw4w9WgXcQ', service: 'youtube', kind: 'rec', title: 'A video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', durationSec: 600 };
const YT_RESUME = { id: 'youtube:aaaaaaaaaaa', service: 'youtube', kind: 'resume', title: 'Half seen', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=120s', progress: 0.5, durationSec: 400 };
const DISNEY = { id: 'disney:1', service: 'disney', kind: 'rec', title: 'Andor', url: 'https://www.disneyplus.com/browse/entity-1', also: [] };
const LIVE = { id: 'espn:1', service: 'espn', kind: 'live', title: 'Game', url: 'https://www.espn.com/watch/player' };

/* ---- a fake page for the controller: timers, a clock, the sent lines, the players made ---- */
function world(o) {
  const opts = o || {};
  let t = 1000;
  const timers = [];
  const sent = [];
  const players = [];        // every mount: { tile, url, view, posts, alive, revealed, progress }
  const notes = [];
  let alive = 0, maxAlive = 0;
  const local = Object.assign({ pvOn: true, tilesOn: true, hidden: false, front: true, searching: false, stageOwns: false, reduced: false }, opts.local || {});
  const store = opts.store || new Map();
  const hover = new Set();
  const w = {
    timers, sent, players, notes, local, store, hover,
    get maxAlive() { return maxAlive; }, get alive() { return alive; },
    tmdbKey: opts.tmdbKey !== false,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = h.at;
        h.fn();
      }
      t = end;
    },
    now: () => t,
  };
  w.ctl = TP.createController({
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
    now: () => t,
    send: (verb, msg) => sent.push([verb, msg]),
    local: () => local,
    hovered: (tile) => hover.has(tile),
    alive: (tile) => tile.alive !== false,
    itemOf: (tile) => ({ item: tile.item, event: tile.event || null, team: tile.team || null }),
    hasTmdbKey: () => w.tmdbKey,
    mock: () => true,
    offline: () => !!w.offline,
    mount: (tile, url, view) => {
      const p = { tile, url, view, posts: [], alive: true, revealed: false, progress: [] };
      players.push(p);
      alive++; maxAlive = Math.max(maxAlive, alive);
      return {
        post: (m) => p.posts.push(m),
        reveal: () => { p.revealed = true; },
        progress: (a, b) => p.progress.push([a, b]),
        muted: (m) => { p.mutedNow = m; },
        cc: (c) => { p.ccNow = c; },
        destroy: () => { if (p.alive) { p.alive = false; alive--; } },
      };
    },
    note: (tile, text) => { const n = { tile, text, alive: true }; notes.push(n); return { destroy: () => { n.alive = false; } }; },
    store: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v) },
  });
  w.tile = (item, extra) => Object.assign({ item }, extra || {});
  /** the pointer moves onto `tile` (and off every other) */
  w.over = (tile) => { hover.clear(); hover.add(tile); w.ctl.enter(tile); };
  w.out = (tile) => { hover.delete(tile); w.ctl.leave(tile); };
  w.lastGate = () => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === 'tilepv') return sent[i][1]; return null; };
  w.lastTrailer = () => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === 'preview') return sent[i][1]; return null; };
  w.gateOk = () => { const g = w.lastGate(); w.ctl.onGate({ seq: g.seq, ok: true, reason: '' }); };
  w.play = () => { w.ctl.loaded(); w.ctl.onMessage(JSON.stringify({ event: 'onStateChange', info: 1 })); };
  return w;
}

(async () => {
  /* ---- the gates, main's half ---- */
  check(TP.gateMain({ mode: 'live', on: true, gaming: '', saver: false, freeGb: 4 }) === '', 'gateMain: live, on, no game, no saver, 4 GB free: may play');
  check(/test profile/.test(TP.gateMain({ mode: 'off', on: true })), 'gateMain: a test profile without the mock never plays');
  check(/Settings > Lumen/.test(TP.gateMain({ mode: 'live', on: false, freeGb: 4 })), 'gateMain: the Settings switch off: no preview');
  check(/VALORANT is running/.test(TP.gateMain({ mode: 'live', on: true, gaming: 'valorant', freeGb: 4 })), 'gateMain: a game running: no preview, and it names the game', TP.gateMain({ mode: 'live', on: true, gaming: 'valorant' }));
  check(/battery saver/.test(TP.gateMain({ mode: 'live', on: true, saver: true, freeGb: 4 })), 'gateMain: battery saver on: no preview');
  check(TP.gateMain({ mode: 'live', on: true, saver: null, freeGb: 4 }) === '', 'gateMain: battery saver unknown (null) counts as off');
  const ram = TP.gateMain({ mode: 'live', on: true, freeGb: 1.2 });
  check(/1\.2 GB/.test(ram) && /1\.5 GB/.test(ram), 'gateMain: under 1.5 GB free: no preview, with both numbers', ram);
  check(TP.gateMain({ mode: 'live', on: true, freeGb: 1.5 }) === '' && TP.MIN_FREE_GB === 1.5, 'gateMain: exactly 1.5 GB free may play (the floor is 1.5 GB)');
  check(TP.gateMain({ mode: 'mock', on: true, freeGb: 0.2, minFreeGb: 0 }) === '', 'gateMain: a test may lower the memory floor');

  /* ---- the gates, the page's half ---- */
  const L = (o) => TP.gateLocal(Object.assign({ pvOn: true, tilesOn: true, hidden: false, front: true, searching: false, stageOwns: false, reduced: false }, o));
  check(L({}).code === '', 'gateLocal: all clear');
  check(L({ hidden: true }).code === 'quiet' && L({ front: false }).code === 'quiet', 'gateLocal: a hidden window or a background tab: quiet no');
  check(L({ stageOwns: true }).code === 'quiet', 'gateLocal: the hero is up (first row): the hero plays it, not the tile');
  check(L({ tilesOn: false }).code === 'quiet' && L({ pvOn: false }).code === 'quiet' && L({ searching: true }).code === 'quiet', 'gateLocal: switched off, previews off, or searching: quiet no');
  check(L({ reduced: true }).code === 'note' && /reduce motion/.test(L({ reduced: true }).reason), 'gateLocal: reduce motion: no autoplay, and the tile says why');

  /* ---- what a tile plays: the video, the trailer, or nothing ---- */
  let s = TP.tileSource(YT, { hasTmdbKey: true });
  check(s.type === 'youtube' && s.videoId === 'dQw4w9WgXcQ' && s.start === 0, 'tileSource: a YouTube tile previews its own video', s);
  s = TP.tileSource(YT_RESUME, {});
  check(s.type === 'youtube' && s.start === Pv.resumeAt(YT_RESUME) && s.start > 0, 'tileSource: a Continue watching YouTube tile previews from where he left off', s);
  s = TP.tileSource(DISNEY, { hasTmdbKey: true });
  check(s.type === 'trailer' && s.title === 'Andor', 'tileSource: a Disney+ tile asks for its TMDB trailer', s);
  s = TP.tileSource(DISNEY, { hasTmdbKey: false });
  check(s.type === 'none', 'tileSource: no TMDB key: nothing plays (the tile stays still)', s);
  check(TP.tileSource(LIVE, { hasTmdbKey: true }).type === 'none', 'tileSource: a live ESPN card never previews');
  check(TP.tileSource(Object.assign({}, DISNEY, { kind: 'upcoming' }), { hasTmdbKey: true }).type === 'none', 'tileSource: an upcoming event never previews');
  check(TP.tileSource(Object.assign({}, YT, { live: true }), { hasTmdbKey: true }).type === 'none', 'tileSource: a YouTube live stream (kind rec, live: true) never previews');
  check(TP.tileSource(Object.assign({}, YT, { upcoming: true }), { hasTmdbKey: true }).type === 'none', 'tileSource: a YouTube premiere (kind rec, upcoming: true) never previews');
  check(TP.tileSource(DISNEY, { hasTmdbKey: true, event: true }).type === 'none' && TP.tileSource(DISNEY, { hasTmdbKey: true, team: true }).type === 'none', 'tileSource: games and My teams never preview');

  /* ---- the &t= hand-off ---- */
  const ID = 'dQw4w9WgXcQ';
  check(TP.atUrl('https://www.youtube.com/watch?v=' + ID, 37.8, ID) === 'https://www.youtube.com/watch?v=' + ID + '&t=37s', 'atUrl: a watch URL gets &t=37s (whole seconds)', TP.atUrl('https://www.youtube.com/watch?v=' + ID, 37.8, ID));
  check(TP.atUrl('https://www.youtube.com/watch?v=' + ID + '&t=120s', 140, ID) === 'https://www.youtube.com/watch?v=' + ID + '&t=140s', 'atUrl: an existing t= is replaced');
  check(TP.atUrl('https://youtu.be/' + ID, 9, ID) === 'https://youtu.be/' + ID + '?t=9s', 'atUrl: youtu.be too');
  check(TP.atUrl('https://www.youtube.com/watch?v=' + ID, 0.6, ID) === 'https://www.youtube.com/watch?v=' + ID, 'atUrl: under a second: unchanged');
  check(TP.atUrl('https://www.youtube.com/watch?v=bbbbbbbbbbb', 30, ID) === 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'atUrl: another video: unchanged');
  check(TP.atUrl('https://www.disneyplus.com/browse/entity-1', 30, ID) === 'https://www.disneyplus.com/browse/entity-1', 'atUrl: not YouTube: unchanged');

  /* ---- the player's messages ---- */
  check(JSON.stringify(TP.readMessage('{"event":"onStateChange","info":1}')) === '{"playing":true}', 'readMessage: state 1 = playing');
  const inf = TP.readMessage('{"event":"infoDelivery","info":{"currentTime":12.5,"duration":300}}');
  check(inf && inf.time === 12.5 && inf.duration === 300, 'readMessage: infoDelivery carries the time and the length', inf);
  check(TP.readMessage('{"event":"onError","info":150}').error === 150, 'readMessage: an error code');
  check(TP.readMessage('not json') === null && TP.readMessage({ event: 'x' }) === null, 'readMessage: anything else is nothing');
  check(JSON.parse(TP.command('unMute')).func === 'unMute' && JSON.parse(TP.command('loadModule', ['captions'])).args[0] === 'captions', 'command: the IFrame API commands');

  /* ---- the controller: the hover delay ---- */
  let w = world();
  let a = w.tile(YT);
  w.over(a);
  w.advance(TP.HOVER_DELAY_MS - 1);
  check(w.sent.length === 0 && w.players.length === 0, 'delay: nothing is asked or made ' + (TP.HOVER_DELAY_MS - 1) + ' ms after the pointer came to rest', w.sent);
  w.advance(1);
  check(w.sent.length === 1 && w.sent[0][0] === 'tilepv', 'delay: at ' + TP.HOVER_DELAY_MS + ' ms the page asks main the gate once', w.sent);
  check(TP.HOVER_DELAY_MS >= 700 && TP.HOVER_DELAY_MS <= 900, 'delay: about 800 ms, like YouTube (' + TP.HOVER_DELAY_MS + ')');
  w.gateOk();
  check(w.players.length === 1 && w.players[0].url.indexOf(Pv.MOCK_ORIGIN + '/embed/' + ID + '?') === 0 && /[?&]mute=1(&|$)/.test(w.players[0].url), 'delay: then ONE muted player for the tile\'s own video', w.players.map((p) => p.url));
  check(w.players[0].view.muted === true && w.players[0].revealed === false, 'crossfade: muted by default, and not shown before it plays');
  w.ctl.loaded();
  w.advance(100);
  check(w.players[0].revealed === false, 'crossfade: loaded is not playing: still the still');
  w.ctl.onMessage(JSON.stringify({ event: 'onStateChange', info: 1 }));
  check(w.players[0].revealed === true && w.ctl.state().phase === 'playing', 'crossfade: shown once the player says it plays');
  check(w.players[0].progress.length === 1 && w.players[0].progress[0][1] === 600, 'progress: the line starts with the tile\'s length (600 s)', w.players[0].progress);
  w.out(a);
  check(w.alive === 0 && !w.ctl.state().live && w.ctl.state().phase === 'idle', 'leave: the player is destroyed at once (not hidden)', w.ctl.state());
  check(w.timers.length === 0, 'leave: no timer is left running (no work at rest)', w.timers.length);

  /* ---- a sweep starts nothing ---- */
  w = world();
  const row = [YT, YT_RESUME, DISNEY, YT, DISNEY, YT].map((it) => w.tile(it));
  for (const t of row) { w.over(t); w.advance(150); }
  w.out(row[row.length - 1]);
  w.advance(5000);
  check(w.sent.length === 0 && w.players.length === 0, 'sweep: 6 tiles at 150 ms each: nothing asked, nothing made', { sent: w.sent.length, players: w.players.length });
  w.over(row[1]);
  w.advance(400);
  w.over(row[2]);
  w.advance(799);
  check(w.sent.length === 0, 'sweep: the clock restarts on every tile (799 ms on the last: nothing yet)');
  w.advance(1);
  check(w.sent.length === 1, 'sweep: resting 800 ms on the last tile asks once');

  /* ---- one at a time ---- */
  w = world();
  const t1 = w.tile(YT), t2 = w.tile(YT_RESUME);
  w.over(t1); w.advance(800); w.gateOk(); w.play();
  w.over(t2);
  check(w.alive === 0 && w.players[0].alive === false, 'one at a time: moving to another tile destroys the first player before anything else', w.alive);
  w.advance(800); w.gateOk(); w.play();
  check(w.players.length === 2 && w.alive === 1 && w.maxAlive === 1, 'one at a time: never two players alive (max ' + w.maxAlive + ')');
  check(/[?&]start=\d+/.test(w.players[1].url), 'resume: the Continue watching tile starts where he left off', w.players[1].url);
  const g0 = w.lastGate();
  w.ctl.stop('scrolled');
  w.ctl.onGate({ seq: g0.seq, ok: true });
  check(w.alive === 0 && w.players.length === 2, 'stop: a late gate answer after a scroll makes nothing');

  /* ---- the gates hold ---- */
  w = world();
  a = w.tile(YT);
  w.over(a); w.advance(800);
  let g = w.lastGate();
  w.ctl.onGate({ seq: g.seq, ok: false, reason: TP.gateMain({ mode: 'live', on: true, gaming: 'valorant' }) });
  check(w.players.length === 0 && w.notes.length === 1 && /VALORANT/.test(w.notes[0].text), 'gate: a game running: no player, the tile says why', w.notes.map((n) => n.text));
  w.out(a);
  check(w.notes[0].alive === false, 'gate: the note goes with the pointer');
  w.over(a); w.advance(800); g = w.lastGate();
  w.ctl.onGate({ seq: g.seq, ok: false, reason: TP.gateMain({ mode: 'live', on: true, saver: true }) });
  check(w.players.length === 0 && /battery saver/.test(w.notes[1].text), 'gate: battery saver: no player, the tile says why');
  w.out(a); w.over(a); w.advance(800); g = w.lastGate();
  w.ctl.onGate({ seq: g.seq, ok: false, reason: TP.gateMain({ mode: 'live', on: true, freeGb: 1.1 }) });
  check(w.players.length === 0 && /memory/.test(w.notes[2].text), 'gate: under 1.5 GB free: no player, the tile says why');
  w.out(a); w.over(a); w.advance(800); g = w.lastGate();
  w.ctl.onGate({ seq: g.seq, ok: false, reason: TP.gateMain({ mode: 'live', on: false }) });
  check(w.players.length === 0 && w.notes.length === 3, 'gate: his own Settings choice off: no player and no note');
  w.out(a);
  w.ctl.onGate({ seq: g.seq + 7, ok: true });
  check(w.players.length === 0, 'gate: an answer for another hover is ignored');

  w = world({ local: { reduced: true } });
  a = w.tile(YT);
  w.over(a); w.advance(800);
  check(w.sent.length === 0 && w.players.length === 0 && w.notes.length === 1 && /reduce motion/.test(w.notes[0].text), 'reduce motion: nothing autoplays, no gate asked, the tile says why', w.notes);
  w = world({ local: { hidden: true } });
  w.over(w.tile(YT)); w.advance(2000);
  check(w.sent.length === 0 && w.players.length === 0 && w.notes.length === 0, 'out of sight: nothing at all');
  w = world({ local: { stageOwns: true } });
  w.over(w.tile(YT)); w.advance(2000);
  check(w.sent.length === 0 && w.players.length === 0, 'first row (the hero is up): the tile itself starts nothing (the hero plays it)');
  w = world();
  a = w.tile(YT); w.over(a); w.advance(800); w.gateOk(); w.play();
  w.local.front = false;
  w.ctl.check();
  check(w.alive === 0, 'out of sight mid-preview (the tab went to the back): torn down');
  w.local.front = true;
  a = w.tile(YT); w.over(a); w.advance(800); w.gateOk(); w.play();
  a.alive = false;
  w.ctl.check();
  check(w.alive === 0, 'a row step (the tile left the lens): torn down');
  a = w.tile(YT); w.over(a); w.advance(300); w.hover.clear(); w.advance(500);
  check(w.sent.length === 2 && w.players.length === 2 && w.alive === 0, 'the pointer slipped off without a pointerout: the timer fires and starts nothing');

  /* ---- trailer or nothing ---- */
  w = world();
  const d1 = w.tile(DISNEY);
  w.over(d1); w.advance(800); w.gateOk();
  const tr = w.lastTrailer();
  check(tr && tr.title === 'Andor' && tr.seq >= TP.SEQ_BASE, 'trailer: a Disney+ tile asks main for the TMDB trailer, with a seq from SEQ_BASE up', tr);
  check(TP.createController && w.ctl.onTrailer({ seq: 5, state: 'ok', videoId: 'MOCKtrailr1' }) === false, 'trailer: a stage answer (seq under SEQ_BASE) is not the tile\'s');
  check(w.ctl.onTrailer({ seq: tr.seq, state: 'ok', videoId: 'MOCKtrailr1' }) === true && w.players.length === 1 && w.players[0].url.indexOf('/embed/MOCKtrailr1?') !== -1, 'trailer: TMDB found one: it plays in the tile', w.players.map((p) => p.url));
  w.out(d1);
  w.over(d1); w.advance(800); w.gateOk();
  const tr2 = w.lastTrailer();
  w.ctl.onTrailer({ seq: tr2.seq, state: 'none', reason: 'TMDB lists no YouTube trailer', videoId: '' });
  check(w.players.length === 1 && w.alive === 0 && w.notes.length === 0 && w.ctl.state().phase === 'none', 'trailer: none on TMDB: nothing plays, no note, the tile stays still', w.ctl.state());
  w = world({ tmdbKey: false });
  w.over(w.tile(DISNEY)); w.advance(2000);
  check(w.sent.length === 0 && w.players.length === 0 && w.notes.length === 0, 'trailer: no TMDB key: nothing asked, nothing plays');
  w = world();
  w.over(w.tile(LIVE)); w.advance(2000);
  check(w.sent.length === 0 && w.players.length === 0, 'live ESPN: nothing asked, nothing plays');

  /* ---- the &t= hand-off from the controller ---- */
  w = world();
  a = w.tile(YT);
  w.over(a); w.advance(800); w.gateOk(); w.play();
  w.advance(7200);
  let u = w.ctl.handoff(YT.url);
  check(u === YT.url + '&t=7s', 'hand-off: a click 7.2 s into the preview opens at &t=7s', u);
  check(w.alive === 0 && w.ctl.state().phase === 'idle', 'hand-off: the preview ends when the player opens');
  w.over(a); w.advance(800); w.gateOk(); w.play();
  w.ctl.onMessage(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 41.0, duration: 600 } }));
  w.advance(2000);
  u = w.ctl.handoff(YT.url);
  check(u === YT.url + '&t=43s', 'hand-off: the player\'s own time wins (41 s said, +2 s = &t=43s)', u);
  w.over(a); w.advance(800); w.gateOk();
  u = w.ctl.handoff(YT.url);
  check(u === YT.url, 'hand-off: not playing yet: the plain URL', u);
  const dd = w.tile(DISNEY);
  w.over(dd); w.advance(800); w.gateOk(); w.ctl.onTrailer({ seq: w.lastTrailer().seq, state: 'ok', videoId: 'MOCKtrailr1' }); w.play();
  w.advance(5000);
  u = w.ctl.handoff(DISNEY.url);
  check(u === DISNEY.url && w.alive === 0, 'hand-off: a trailer opens the real title as it is (no t=)', u);
  check(w.ctl.handoff(YT.url) === YT.url, 'hand-off: nothing previewing: the URL as it was');

  /* ---- mute and CC, remembered ---- */
  const shared = new Map();
  w = world({ store: shared });
  a = w.tile(YT);
  w.over(a); w.advance(800); w.gateOk(); w.play();
  check(w.players[0].posts.length === 0, 'mute: muted by default: no unMute sent');
  const m = w.ctl.toggleMute();
  check(m === false && shared.get(TP.MUTE_KEY) === '0' && JSON.parse(w.players[0].posts[0]).func === 'unMute' && w.players[0].mutedNow === false, 'mute: the toggle unmutes the player and is saved', { posts: w.players[0].posts, saved: shared.get(TP.MUTE_KEY) });
  w.ctl.toggleCc();
  check(JSON.parse(w.players[0].posts[1]).func === 'loadModule' && w.players[0].ccNow === true, 'CC: the toggle loads YouTube\'s captions');
  w.out(a);
  const w2 = world({ store: shared });
  const b = w2.tile(YT);
  w2.over(b); w2.advance(800); w2.gateOk();
  check(w2.players[0].view.muted === false && w2.players[0].view.cc === true, 'mute: a new page remembers unmuted (and CC on)', w2.players[0].view);
  w2.play();
  const funcs = w2.players[0].posts.map((p) => JSON.parse(p).func);
  check(funcs.indexOf('unMute') !== -1 && funcs.indexOf('loadModule') !== -1, 'mute: the remembered choice is applied once it plays', funcs);

  /* ---- player failures go back to the still ---- */
  w = world();
  a = w.tile(YT);
  w.over(a); w.advance(800); w.gateOk();
  w.ctl.onMessage(JSON.stringify({ event: 'onError', info: 150 }));
  check(w.alive === 0, 'error: a player error removes the player (the still again)');
  w.over(w.tile(YT)); w.advance(800); w.gateOk();
  w.advance(TP.LOAD_MS + 1);
  check(w.alive === 0, 'error: a player that never loads is removed after ' + TP.LOAD_MS + ' ms');
  {
    /* r62: a failure is never silent: the still again, and the tile's note says why; the note goes with the pointer */
    const e = world();
    const ea = e.tile(YT);
    e.over(ea); e.advance(800); e.gateOk();
    e.ctl.onMessage(JSON.stringify({ event: 'onError', info: 150 }));
    check(e.alive === 0 && e.ctl.state().phase === 'blocked' && e.notes.length === 1 && e.notes[0].alive && /only plays on YouTube/.test(e.notes[0].text), 'error 150: the player goes and the tile says why', e.notes.map((n) => n.text));
    e.out(ea);
    check(e.notes[0].alive === false && e.ctl.state().phase === 'idle', 'error: the note goes with the pointer');
    const eb = e.tile(YT);
    e.over(eb); e.advance(800); e.gateOk();
    e.ctl.onMessage(JSON.stringify({ event: 'onError', info: 5 }));
    check(/(error 5)/.test(e.notes[1] && e.notes[1].text), 'error 5: the note names the code', e.notes.map((n) => n.text));
    const ec = e.tile(YT);
    e.over(ec); e.advance(800); e.gateOk();
    e.advance(TP.LOAD_MS + 1);
    check(e.alive === 0 && /didn.t load/.test(e.notes[e.notes.length - 1].text) && e.notes[e.notes.length - 1].alive, 'load timeout: the tile says the player didn’t load', e.notes.map((n) => n.text));
    /* main never answers the gate, or the trailer: no endless silent wait */
    const ed = e.tile(YT);
    e.over(ed); e.advance(800);
    check(e.ctl.state().phase === 'gate', 'gate: asked main');
    e.advance(10000);
    check(e.ctl.state().phase === 'blocked' && /didn.t answer/.test(e.notes[e.notes.length - 1].text), 'gate: no answer from main: the tile says so', e.ctl.state());
    const late = e.lastGate();
    e.ctl.onGate({ seq: late.seq, ok: true, reason: '' });
    check(e.alive === 0, 'gate: a late answer after the no-answer note plays nothing');
    const ee = e.tile(DISNEY);
    e.over(ee); e.advance(800); e.gateOk();
    check(e.ctl.state().phase === 'trailer', 'trailer: asked main');
    e.advance(10000);
    check(e.ctl.state().phase === 'blocked' && /didn.t answer/.test(e.notes[e.notes.length - 1].text), 'trailer: no answer from main: the tile says so', e.ctl.state());
    /* an answered gate clears the wait: a slow player load is the 9 s load timer's, not "didn't answer" */
    const ef = e.tile(YT);
    e.over(ef); e.advance(800); e.advance(3000); e.gateOk(); e.advance(5000);
    check(e.ctl.state().phase === 'mounted' && e.alive === 1, 'gate: answered at 3 s: the player is still loading at 8 s (no false "didn’t answer")', e.ctl.state());
    /* offline: no request to main, no player, a note */
    const g = world();
    g.offline = true;
    const ga = g.tile(YT);
    g.over(ga); g.advance(800);
    check(g.sent.length === 0 && g.players.length === 0 && /offline/.test(g.notes[0] && g.notes[0].text), 'offline: no player, the tile says why', g.notes.map((n) => n.text));
  }
  w.over(w.tile(YT)); w.advance(800); w.gateOk(); w.ctl.loaded();
  w.advance(TP.REVEAL_FALLBACK_MS + 1);
  check(w.alive === 1 && w.players[w.players.length - 1].revealed === true, 'fallback: a player whose messages never arrive is shown ' + TP.REVEAL_FALLBACK_MS + ' ms after it loaded (the stage\'s rule)');

  /* ---- watch-main's half: quartz-watch:tilepv, the switch, the snapshot word ---- */
  const WM = require('../watch-main');
  check(WM.cleanPrefs({}).tilePreview === true && WM.cleanPrefs({ tilePreview: false }).tilePreview === false && WM.cleanPrefs({ tilePreview: 'no' }).tilePreview === true, 'main: the switch defaults ON; only an explicit false turns it off');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilepv-test-'));
  const fake = { game: '', saver: false, free: 8 };
  const wm = WM.create({
    dir, adapters: {}, bootGraceMs: 0, now: () => Date.now(),
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    freeGb: () => fake.free, send: () => {}, log: () => {},
    openInEdge: () => Promise.resolve({ ok: true }), isBundledPage: (url) => typeof url === 'string' && url.indexOf('file:///app/') === 0,
    test: { preview: 'mock', gameRunning: () => fake.game, saverOn: () => fake.saver, windowShowing: () => true },
    runStep: async () => ({ ok: false, error: { code: 'x', detail: 'no reads in this test' } }),
  });
  const pushed = [];
  const guest = {
    getURL: () => 'file:///app/watch.html?theme=dark', isDestroyed: () => false, on() {},
    executeJavaScript(code) { const mm = /^window\.(__\w+) && window\.\1\(([\s\S]*)\)$/.exec(code); if (mm) pushed.push({ fn: mm[1], payload: JSON.parse(mm[2]) }); return Promise.resolve(); },
  };
  wm.watchGuest(guest);
  const ask = async (seq) => {
    wm.handleGuestLine(guest, 'quartz-watch:tilepv {"seq":' + seq + '}');
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    for (let i = pushed.length - 1; i >= 0; i--) if (pushed[i].fn === '__applyWatchTilePreview' && pushed[i].payload.seq === seq) return pushed[i].payload;
    return null;
  };
  let ans = await ask(3);
  check(ans && ans.ok === true && ans.reason === '', 'main: tilepv with nothing in the way: ok', ans);
  fake.game = 'valorant';
  ans = await ask(4);
  check(ans && ans.ok === false && /VALORANT/.test(ans.reason), 'main: tilepv while VALORANT runs: no, with the reason', ans);
  fake.game = ''; fake.saver = true;
  ans = await ask(5);
  check(ans && ans.ok === false && /battery saver/.test(ans.reason), 'main: tilepv on battery saver: no', ans);
  fake.saver = false; fake.free = 1.3;
  ans = await ask(6);
  check(ans && ans.ok === false && /memory/.test(ans.reason), 'main: tilepv under 1.5 GB free: no', ans);
  fake.free = 8;
  check(wm.describe().tilePreview.on === true, 'main: describe says the switch is on by default');
  const d2 = wm.setTilePreview(false);
  check(d2.tilePreview.on === false && JSON.parse(fs.readFileSync(path.join(dir, WM.PREFS_FILE), 'utf8')).tilePreview === false, 'main: the switch off is saved to watch.json', d2.tilePreview);
  ans = await ask(7);
  check(ans && ans.ok === false && /Settings > Lumen/.test(ans.reason), 'main: tilepv with the switch off: no', ans);
  const snapNow = typeof wm.snapshot === 'function' ? wm.snapshot() : null;
  check(snapNow && snapNow.preview && snapNow.preview.tiles === false && snapNow.preview.on === true, 'main: the snapshot tells the page tiles: false', snapNow && snapNow.preview);
  wm.setTilePreview(true);
  check(wm.snapshot().preview.tiles === true, 'main: and back on');
  try { wm.stop(); } catch (e) { /* fine */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }

  console.log('watch-tilepreview-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('FAIL watch-tilepreview-test crashed: ' + (err && err.stack)); console.log('watch-tilepreview-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
