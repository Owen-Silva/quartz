/*
 * scorepins-chrome.js -- the chrome's half of Lumen's pinned scores (index.html loads it).
 *
 * Two jobs, both small:
 *   1. THE PALETTE. tabsearch.js's buildCommands() asks ScorePins.commands(GLYPH) for its rows:
 *      "Pin score: SEA at FLA" per live or upcoming game Lumen already knows (main answers
 *      from Lumen's cached ESPN rows; nothing is fetched for this), "Unpin score: ..." for a
 *      pinned one, "Turn score sounds off/on" (the one global switch), and, with no games
 *      known, "Pin a game score" which opens Lumen. The rows are kept in a small cache,
 *      refreshed when this file loads, when the palette builds its rows (at most every 15 s)
 *      and when main says a pin changed.
 *   2. THE LOOK. The cards wear Quartz's theme, palette and accent. Those live here, in the
 *      chrome (data-theme / data-palette on <html>, Settings' accent hue), so a change is
 *      forwarded to main (api.scores.look) the moment <html> changes.
 * A refused pin is said in a toast (window.Toast, settings.js), never dropped.
 */
(function () {
  'use strict';
  var api = window.api && window.api.scores;
  if (!api) return;
  var cache = { games: [], pinned: [], sound: true };
  var askedAt = 0;
  var asking = false;

  function toast(text) {
    try { if (window.Toast && typeof window.Toast.show === 'function') window.Toast.show(text); } catch (e) { /* the toast is optional */ }
  }

  function refresh() {
    if (asking) return;
    asking = true;
    askedAt = Date.now();
    var p;
    try { p = api.games(); } catch (e) { asking = false; return; }
    Promise.resolve(p).then(function (r) {
      asking = false;
      if (r && Array.isArray(r.games)) cache = { games: r.games, pinned: Array.isArray(r.pinned) ? r.pinned : [], sound: r.sound !== false };
    }, function () { asking = false; });
  }

  function title(g) { return (g.away && g.away.abbr ? g.away.abbr : '?') + ' at ' + (g.home && g.home.abbr ? g.home.abbr : '?'); }
  function hint(g) {
    var bits = [g.leagueName || String(g.league || '').toUpperCase()];
    if (g.state === 'in') {
      bits.push('Live');
      if (g.away && g.home && g.away.score !== '' && g.home.score !== '') bits.push(g.away.score + '–' + g.home.score);
    }
    if (g.detail) bits.push(g.detail);
    return bits.join(' · ');
  }

  function commands(GLYPH) {
    if (Date.now() - askedAt > 15000) refresh();
    var G = GLYPH || {};
    var rows = [];
    var games = cache.games.filter(function (g) { return g.state === 'in' || (g.state === 'pre' && g.startsAt - Date.now() < 12 * 3600e3); }).slice(0, 8);
    games.forEach(function (g) {
      var on = cache.pinned.indexOf(g.key) !== -1;
      rows.push(on ? {
        id: 'unpin-score:' + g.key, glyph: G.unpin, label: 'Unpin score: ' + title(g), hint: 'Close its card on your desktop',
        run: function () { Promise.resolve(api.unpin(g.key)).then(refresh, function () { toast("Couldn't close that score card"); }); }
      } : {
        id: 'pin-score:' + g.key, glyph: G.pin, label: 'Pin score: ' + title(g), hint: hint(g),
        run: function () {
          Promise.resolve(api.pin(g)).then(function (r) {
            if (!r || !r.ok) toast("Couldn't pin " + title(g) + ': ' + ((r && r.reason) || 'Quartz did not answer'));
            refresh();
          }, function (err) { toast("Couldn't pin " + title(g) + ': ' + ((err && err.message) || 'Quartz did not answer')); });
        }
      });
    });
    if (!games.length) {
      rows.push({
        id: 'pin-score', glyph: G.pin, label: 'Pin a game score',
        hint: 'Lumen lists today’s games; pin one from its card',
        run: function () { if (typeof window.openWatchTab === 'function') window.openWatchTab(); }
      });
    }
    rows.push({
      id: 'score-sounds', glyph: G.video, label: cache.sound ? 'Turn score sounds off' : 'Turn score sounds on',
      hint: cache.sound ? 'Goal horns and penalty tones on every pinned card' : 'Every pinned card is silent now',
      run: function () {
        var want = !cache.sound;
        Promise.resolve(api.setSound(want)).then(function (r) { if (r && r.ok) cache.sound = r.sound; }, function () { toast("Couldn't change the score sounds"); });
      }
    });
    return rows;
  }

  /* ---- the look, forwarded whenever <html> changes ---- */
  var lastLook = '';
  function sendLook() {
    var root = document.documentElement;
    var hue = null, palette = '';
    try {
      var all = window.Settings && typeof window.Settings.all === 'function' ? window.Settings.all() || {} : {};
      if (typeof all.accentHue === 'number' && isFinite(all.accentHue)) hue = all.accentHue;
      if (all.palette && all.palette !== 'aurora') palette = String(all.palette);
    } catch (e) { /* the defaults are fine */ }
    var look = { theme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark', hue: hue, palette: palette };
    var s = JSON.stringify(look);
    if (s === lastLook) return;
    lastLook = s;
    try { api.look(look); } catch (e) { /* main will use its default until the next change */ }
  }
  try {
    new MutationObserver(sendLook).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'style'] });
  } catch (e) { /* no observer: the first look still goes */ }
  // lumenShow: a score card was clicked and its game page is opening in Lumen (sports-main.js)
  if (typeof api.onChanged === 'function') api.onChanged(function (m) { if (m && m.lumenShow && typeof window.openWatchTab === 'function') window.openWatchTab(); refresh(); });

  window.ScorePins = { commands: commands, refresh: refresh, _cache: function () { return cache; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { sendLook(); refresh(); });
  else { sendLook(); refresh(); }
})();
