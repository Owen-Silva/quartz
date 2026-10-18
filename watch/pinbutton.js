/*
 * watch/pinbutton.js -- the "Pin score" control on Lumen's game cards (watch.html).
 *
 * watch.js's gameEl() asks ScorePinButton.make(ev) for one button per game and puts it in the
 * card's wrapper (beside the card's own button, never inside it). Like watch.js, this page has
 * no preload: it speaks to Quartz in console lines, which score-pins-main.js hears only from
 * OUR watch.html and validates there (watch/scores.js cleanPin):
 *
 *   out  quartz-scores:hello {}                       which games are pinned?
 *        quartz-scores:pin   {"game": <the event>}    pin it (a card appears on the desktop)
 *        quartz-scores:unpin {"key": "nhl:401892522"}  close that card
 *   in   window.__applyScorePins(["nhl:401892522", ...])   after hello and after every change
 *        window.__scorePinFailed("reason")                  a pin was refused: said on the button
 *
 * The button shows on hover, and always once its game is pinned (so a glance says which).
 * A finished game has no button: there is nothing left to watch.
 */
(function () {
  'use strict';
  var LINE = 'quartz-scores:';
  var pinned = {};
  var buttons = [];
  var failTimer = 0;

  function send(verb, msg) {
    var json = '{}';
    try { json = JSON.stringify(msg || {}); } catch (e) { json = '{}'; }
    try { console.log(LINE + verb + ' ' + json); } catch (e) { /* nothing to tell */ }
  }
  function keyOf(ev) { return String(ev.league || '') + ':' + String(ev.id || '').replace(/^espn:/, ''); }

  // Its own stylesheet (CSP: style-src file:), so watch.html carries one script tag and no more.
  try {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'watch/pinbutton.css';
    document.head.appendChild(link);
  } catch (e) { /* unstyled is still usable */ }

  function paint(b) {
    var on = !!pinned[b._key];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.querySelector('.spb-t').textContent = on ? 'Pinned' : 'Pin score';
    var t = on ? 'Close the pinned score for ' + b._title : 'Pin ' + b._title + "'s score to your desktop";
    b.title = t;
    b.setAttribute('aria-label', t);
  }

  function make(ev) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'spb';
    b.tabIndex = -1;                       // the lens owns the keyboard; the palette pins by name
    b._key = keyOf(ev);
    b._made = Date.now();
    b._event = ev;
    b._title = (ev.away && ev.away.abbr ? ev.away.abbr : '') + ' at ' + (ev.home && ev.home.abbr ? ev.home.abbr : '');
    if (ev.state === 'post') b.hidden = true;
    var g = document.createElement('span');
    g.className = 'spb-g';
    g.setAttribute('aria-hidden', 'true');
    g.textContent = '';
    var t = document.createElement('span');
    t.className = 'spb-t';
    b.appendChild(g);
    b.appendChild(t);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (pinned[b._key]) send('unpin', { key: b._key });
      else send('pin', { game: b._event });
    });
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    paint(b);
    buttons.push(b);
    if (buttons.length > 200) buttons = buttons.filter(function (x) { return x.isConnected || Date.now() - x._made < 5000; });
    return b;
  }

  window.__applyScorePins = function (keys) {
    pinned = {};
    (Array.isArray(keys) ? keys : []).forEach(function (k) { if (typeof k === 'string') pinned[k] = true; });
    // Drop the buttons of rows Lumen rebuilt (a just-made one may not be in the page yet).
    buttons = buttons.filter(function (x) { return x.isConnected || Date.now() - x._made < 5000; });
    buttons.forEach(paint);
  };
  window.__scorePinFailed = function (reason) {
    var text = "Couldn't pin: " + String(reason || 'unknown reason').slice(0, 120);
    buttons.forEach(function (b) { if (b.isConnected && !pinned[b._key]) { b.querySelector('.spb-t').textContent = text; b.classList.add('err'); } });
    clearTimeout(failTimer);
    failTimer = setTimeout(function () { buttons.forEach(function (b) { b.classList.remove('err'); paint(b); }); }, 5000);
  };

  window.ScorePinButton = { make: make, keyOf: keyOf, pinned: function () { return Object.keys(pinned); } };
  send('hello', {});
})();
