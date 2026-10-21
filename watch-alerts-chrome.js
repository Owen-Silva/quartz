/*
 * watch-alerts-chrome.js -- Lumen Alerts, the chrome's half (index.html loads it before settings.js).
 *
 * 1. SHOWING AN ALERT. Main (watch-alerts-main.js) sends one alert per check. Where it goes:
 *    - Quartz in the background (the window is not focused): Quartz's own notification path, the
 *      same window.Notification the "Claude is waiting" toast uses (app.js notifyClaudeWaiting:
 *      silent, its permission asked at most once through claudeNotifyPermission). the user's shell
 *      redraws those toasts itself, so Lumen adds no notification mechanism of its own. A click
 *      brings Quartz forward and does the alert's action.
 *    - Quartz in front: a small card in the corner of the chrome (watch-alerts.css), with the
 *      videos as rows (each plays in Lumen's player layer) or, for a game, Open and "Pin this game"
 *      (score pins does the pinning; the card draws no score of its own). It leaves after 12 s
 *      unless the pointer is on it; Esc or x closes it.
 *    - Notifications blocked: the card, and Settings says why.
 *    Every alert answers main (api.shown) with where it went or why it could not be shown.
 *    TESTS ARE SILENT: an alert marked silent never constructs a Notification; it is counted in
 *    window.__lumenAlertsTest.os instead (the card still draws, inside the off-screen test window).
 *
 * 2. SETTINGS > LUMEN > ALERTS. settings.js gives this file its field and its DOM helpers
 *    (LumenAlertsSettings.render(field, helpers)); this file asks main for the state and draws it.
 */
(function () {
  'use strict';
  var api = window.api && window.api.lumenAlerts;
  var CARD_MS = 12000;
  var MAX_CARDS = 3;
  var stack = null;
  var testRec = { os: [], card: [], blocked: [] };
  window.__lumenAlertsTest = testRec;

  /* --- showing -------------------------------------------------------------------------------- */

  function report(a, surface, ok, reason) {
    try { if (api) api.shown(a.id, surface, ok, reason || ''); } catch (e) { /* main hears nothing: Settings keeps "sent" */ }
  }

  function doAction(a, action, index) {
    if (!api) return;
    // A video plays over Lumen, so its tab comes forward first; a game page opens Lumen itself.
    if (a.kind === 'subs' && typeof window.openWatchTab === 'function') { try { window.openWatchTab(); } catch (e) { /* the layer still opens */ } }
    var p;
    try { p = api.act(a.id, action, index); } catch (e) { toast('Lumen couldn’t do that: ' + ((e && e.message) || 'no reason given')); return; }
    Promise.resolve(p).then(function (r) {
      if (r && r.ok === false) toast((action === 'pin' ? 'Couldn’t pin this game' : 'Lumen couldn’t open that') + (r.reason ? ': ' + r.reason : ''));
      else if (action === 'pin' && r && r.already) toast('That game is pinned already');
    }, function (e) { toast('Lumen couldn’t do that: ' + ((e && e.message) || 'no reason given')); });
  }

  function toast(text) {
    try { if (window.Toast && typeof window.Toast.show === 'function') window.Toast.show(text, 4000); } catch (e) { /* optional */ }
  }

  function permission() {
    if (typeof window.Notification !== 'function') return 'unsupported';
    // app.js's own asker: one prompt per window, shared with the Claude toast.
    if (typeof window.claudeNotifyPermission === 'function') { try { return window.claudeNotifyPermission(); } catch (e) { /* fall through */ } }
    try { return window.Notification.permission; } catch (e) { return 'unsupported'; }
  }

  function osBody(a) {
    // Windows shows about three lines; the title already carries the count.
    return String(a.body || '').split('\n').slice(0, 4).join('\n');
  }

  /** Quartz's notification path. true = shown (or, silent, counted). */
  function showOs(a) {
    if (a.silent) { testRec.os.push({ id: a.id, title: a.title, body: osBody(a) }); report(a, 'os', true, ''); return true; }
    var perm = permission();
    if (perm !== 'granted') return perm === 'denied' ? 'Windows notifications are blocked for Quartz' : (perm === 'unsupported' ? 'this Quartz has no notifications' : 'Quartz is still asking Windows for permission to notify');
    var note;
    try { note = new window.Notification(a.title, { body: osBody(a), silent: true, tag: 'lumen-' + a.kind }); } catch (e) { return 'Windows refused the notification'; }
    try {
      note.onclick = function () {
        try { window.focus(); } catch (e) { /* not ours to raise */ }
        doAction(a, a.action, 0);
        try { note.close(); } catch (e) { /* gone */ }
      };
    } catch (e) { /* no onclick: the card path is still there next time */ }
    report(a, 'os', true, '');
    return true;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    stack = el('div', 'lumen-alerts');
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Lumen alerts');
    document.body.appendChild(stack);
    return stack;
  }

  function close(card) {
    if (!card || card.dataset.closing) return;
    card.dataset.closing = '1';
    window.clearTimeout(card._timer);
    card.classList.remove('is-up');
    window.setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 200);
  }

  function arm(card) {
    window.clearTimeout(card._timer);
    card._timer = window.setTimeout(function () { close(card); }, CARD_MS);
  }

  /** The in-Quartz card. */
  function showCard(a, note) {
    if (!document.body) return false;
    var s = ensureStack();
    var card = el('div', 'lumen-alert lumen-alert-' + (a.kind === 'game' ? 'game' : 'subs'));
    card.setAttribute('role', 'status');
    card.setAttribute('data-alert-id', a.id);
    var head = el('div', 'lumen-alert-head');
    head.appendChild(el('span', 'lumen-alert-src', a.kind === 'game' ? 'Lumen · ' + (a.league || 'Sports') : 'Lumen · YouTube'));
    var x = el('button', 'lumen-alert-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', function () { close(card); });
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el('div', 'lumen-alert-title', a.title));
    if (a.kind === 'subs') {
      var list = el('div', 'lumen-alert-list');
      (a.items || []).slice(0, 3).forEach(function (it, i) {
        var row = el('button', 'lumen-alert-row');
        row.type = 'button';
        if (it.channel) row.appendChild(el('span', 'lumen-alert-ch', it.channel));
        row.appendChild(el('span', 'lumen-alert-vt', it.title));
        row.title = 'Play in Lumen';
        row.addEventListener('click', function () { doAction(a, 'play', i); close(card); });
        list.appendChild(row);
      });
      card.appendChild(list);
      if (a.more > 0) card.appendChild(el('div', 'lumen-alert-more', 'and ' + a.more + ' more in your Subscriptions row'));
    } else {
      if (a.body) card.appendChild(el('div', 'lumen-alert-body', a.body));
      var acts = el('div', 'lumen-alert-acts');
      (a.actions || ['open']).forEach(function (act) {
        var b = el('button', 'lumen-alert-btn' + (act === 'pin' ? ' is-primary' : ''), act === 'pin' ? 'Pin this game' : (a.type === 'final' ? 'Open recap' : 'Open game'));
        b.type = 'button';
        b.setAttribute('data-act', act);
        b.addEventListener('click', function () { doAction(a, act, 0); close(card); });
        acts.appendChild(b);
      });
      card.appendChild(acts);
    }
    if (note) card.appendChild(el('div', 'lumen-alert-note', note));
    card.addEventListener('mouseenter', function () { window.clearTimeout(card._timer); });
    card.addEventListener('mouseleave', function () { arm(card); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(card); });
    s.appendChild(card);
    while (s.children.length > MAX_CARDS) s.removeChild(s.firstChild);
    window.requestAnimationFrame(function () { card.classList.add('is-up'); });
    if (!a.hold) arm(card);
    testRec.card.push({ id: a.id, title: a.title });
    return true;
  }

  function show(a) {
    if (!a || typeof a !== 'object' || !a.id) return;
    var front = false;
    try { front = document.hasFocus() && document.visibilityState !== 'hidden'; } catch (e) { front = false; }
    var where = a.surface === 'os' || a.surface === 'card' ? a.surface : (front ? 'card' : 'os');
    if (where === 'os') {
      var r = showOs(a);
      if (r === true) return;
      // Blocked: the card waits in the corner for him, and says why the notification did not come.
      testRec.blocked.push({ id: a.id, reason: r });
      showCard(Object.assign({}, a, { hold: true }), r);
      report(a, 'card', false, r + '; shown inside Quartz instead');
      return;
    }
    showCard(a, '');
    report(a, 'card', true, '');
  }

  if (api && typeof api.onShow === 'function') api.onShow(show);
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !stack || !stack.contains(document.activeElement)) return;
    var c = document.activeElement.closest('.lumen-alert');
    if (c) close(c);
  });

  /* --- Settings > Lumen > Alerts ---------------------------------------------------------------- */

  var st = null;          // the last describe()
  var askedAt = 0;
  var asking = false;
  var failed = '';
  var busy = '';
  var lastField = null;
  var lastHelpers = null;

  function ask(force) {
    if (!api || asking || (!force && Date.now() - askedAt < 1500)) return;
    asking = true;
    askedAt = Date.now();
    var p;
    try { p = api.describe(); } catch (e) { asking = false; failed = (e && e.message) || 'no reason given'; redraw(); return; }
    Promise.resolve(p).then(function (v) { asking = false; if (v) { st = v; failed = ''; } else failed = 'Quartz did not answer'; redraw(); },
      function (e) { asking = false; failed = (e && e.message) || 'no reason given'; redraw(); });
  }

  function redraw() {
    if (lastField && lastField.isConnected && lastHelpers) { lastField.textContent = ''; draw(lastField, lastHelpers); }
  }

  function setKind(kind, on) {
    if (!api || busy) return;
    busy = kind;
    redraw();
    Promise.resolve(api.set(kind, on)).then(function (v) { busy = ''; if (v) st = v; redraw(); },
      function (e) { busy = ''; failed = 'That setting could not be saved: ' + ((e && e.message) || 'no reason given'); redraw(); });
  }

  /** The subscriptions line: what the last check found, or why there is nothing. */
  function subsLine(s, h) {
    if (!s.on) return 'Off.';
    if (s.youtube === 'off') return 'No alerts: YouTube is off in the services above.';
    if (s.youtube === 'signed-out' || s.state === 'signed-out') return 'No alerts: you are signed out of YouTube in Quartz. Sign in from the YouTube row above.';
    if (s.held) return 'Held back: ' + s.held + '. It says what it found once that clears.';
    if (s.state === 'never') return 'Waiting for Lumen’s first Subscriptions read (it follows the next YouTube read).';
    if (s.state === 'error') return 'The last check failed' + (s.readAt ? ' (' + h.ago(s.readAt) + ')' : '') + ': ' + (s.reason || 'no reason given') + '.';
    var when = s.readAt ? 'Checked ' + h.ago(s.readAt) : 'Checked';
    if (s.found > 0) return when + ': ' + s.found + ' new, alerted.';
    return when + ': nothing new' + (s.baselined ? '.' : ' (this read is the starting point).');
  }

  function teamsLine(t, h) {
    if (!t.favs.length) return 'Pick a team in Lumen’s My teams row and game alerts turn on for it.';
    if (!t.on) return 'Off.';
    if (t.espn === 'off') return 'No alerts: ESPN is off in the services above.';
    if (t.missingLeagues && t.missingLeagues.length) return 'No alerts for ' + t.missingLeagues.map(function (l) { return l.toUpperCase(); }).join(', ') + ': add it under Sports leagues above.';
    if (t.held) return 'Held back: ' + t.held + '.';
    if (t.state === 'never') return 'Waiting for Lumen’s first ESPN read.';
    if (t.state === 'error') return 'The last ESPN read failed' + (t.readAt ? ' (' + h.ago(t.readAt) + ')' : '') + ': ' + (t.reason || 'no reason given') + '.';
    return 'Checked ' + (t.readAt ? h.ago(t.readAt) : 'just now') + (t.found ? ': ' + t.found + ' alert' + (t.found === 1 ? '' : 's') + '.' : ': nothing to say yet.');
  }

  function draw(field, h) {
    field.classList.add('lumen-alerts-set');
    field.appendChild(h.el('span', 'set-label', 'Alerts'));
    field.appendChild(h.el('p', 'set-hint lumen-alerts-only', 'Alerts come only while Quartz is running: they ride on Lumen’s own reads (every 15 min while Lumen is on screen, about hourly in the background, every 2 min during a favourite’s game) and nothing is sent anywhere.'));
    if (!api) { field.appendChild(h.el('p', 'set-hint lumen-alerts-err', 'Alerts need a newer Quartz (this one has no alerts bridge).')); return; }
    if (!st) {
      field.appendChild(h.el('p', 'set-hint' + (failed ? ' lumen-alerts-err' : ''), failed ? 'Alerts could not answer: ' + failed + '.' : 'Asking Lumen…'));
      ask(false);
      return;
    }
    ask(false);
    var s = st.subs || {};
    var t = st.teams || { favs: [] };
    var r1 = h.switchRow('New from your subscriptions', !!s.on, function (on) { setKind('subs', on); });
    r1.classList.add('lumen-alerts-subs');
    if (busy === 'subs') r1.disabled = true;
    field.appendChild(r1);
    field.appendChild(h.el('p', 'set-hint lumen-alerts-state lumen-alerts-subs-state', subsLine(s, h)));
    // Said plainly (release 4): with this on, the Subscriptions page is read in the background too.
    field.appendChild(h.el('p', 'set-hint lumen-alerts-bgnote', s.on
      ? 'While Quartz runs, this checks your YouTube Subscriptions in the background, even with no Lumen page open: one hidden read with each background update (about hourly), never during a game, on battery saver or under 2.5 GB free.'
      : 'Off: your Subscriptions are read only while Lumen is on screen.'));

    var r2 = h.switchRow('Game start and final for my teams', !!t.on, function (on) { setKind('teams', on); });
    r2.classList.add('lumen-alerts-teams');
    if (busy === 'teams') r2.disabled = true;
    field.appendChild(r2);
    var teams = h.el('div', 'lumen-alerts-teamlist');
    teams.setAttribute('aria-label', 'Favourite teams');
    if (t.favs.length) {
      t.favs.forEach(function (f) {
        var chip = h.el('span', 'lumen-alerts-team');
        // Words only: a logo here would be one more request from the chrome for nothing.
        chip.appendChild(h.el('span', 'lumen-alerts-abbr', f.abbr || ''));
        chip.appendChild(h.el('span', 'lumen-alerts-tname', (f.name || f.abbr) + ' · ' + String(f.league || '').toUpperCase()));
        teams.appendChild(chip);
      });
    } else teams.appendChild(h.el('span', 'lumen-alerts-none', 'No favourite teams yet'));
    var edit = h.textButton(t.favs.length ? 'Change teams in Lumen' : 'Pick teams in Lumen', 'set-text lumen-alerts-edit', function () {
      if (typeof window.openWatchTab === 'function') window.openWatchTab();
    });
    teams.appendChild(edit);
    field.appendChild(teams);
    field.appendChild(h.el('p', 'set-hint lumen-alerts-state lumen-alerts-teams-state', teamsLine(t, h)));

    if (st.gate) field.appendChild(h.el('p', 'set-hint lumen-alerts-gate', 'Right now: ' + st.gate + '. No alerts and no extra reads until it clears.'));
    if (st.background === false) field.appendChild(h.el('p', 'set-hint', 'With background updates off, alerts come only while Lumen is on screen.'));
    var last = st.last;
    if (last) {
      var where = last.surface === 'os' ? 'as a Windows notification' : (last.surface === 'card' ? 'inside Quartz' : 'to Quartz');
      field.appendChild(h.el('p', 'set-hint lumen-alerts-last' + (last.ok ? '' : ' lumen-alerts-err'),
        (last.ok ? 'Last alert ' + h.ago(last.at) + ', ' + where + ': ' : 'The last alert (' + h.ago(last.at) + ') did not show as a notification: ' + (last.reason || 'no reason given') + '. It was: ') + '“' + last.title + '”.'));
    }
    if (failed) field.appendChild(h.el('p', 'set-hint lumen-alerts-err', failed));
  }

  window.LumenAlertsSettings = {
    render: function (field, helpers) {
      if (!field || !helpers) return;
      lastField = field;
      lastHelpers = helpers;
      draw(field, helpers);
    },
    refresh: function () { ask(true); },
  };
})();
