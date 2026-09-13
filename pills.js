'use strict';

/*
 * pills.js — the two titlebar readouts: the Claude budget pill (#budget-slot)
 * and the now-playing pill (#np-slot). Both slots are static in index.html,
 * between the spacer and the window controls.
 *
 * Plain browser script (contextIsolation on): reads window.api.budget and
 * window.api.media only; owns every .pill-* class and everything inside the
 * two slots, nothing else.
 *
 * WHAT EACH ONE IS
 *
 *   budget   Always present. Shows the higher of the two Claude limits at a
 *            glance and everything else on hover/focus. It never goes blank:
 *            a reading that is stale, unreadable or missing says so IN the
 *            pill, with the reason in the card, because a slot that empties
 *            itself when the source breaks is the definition of a silent
 *            failure. main pushes it (budget.js, 30 s poll); this file only
 *            re-words the age between pushes, off its own clock.
 *
 *   now      Hidden unless something is actually playing or paused. There is
 *            no "nothing playing" state on purpose: a pill saying "no music"
 *            is noise in a titlebar, and an empty slot costs no width. It
 *            polls the cheap no-art /now every 2 s while this document is
 *            visible, and asks for the art only when the track's art hash
 *            changes.
 *
 * WHAT IT CANNOT SHOW. The bridge's ad-ducking state ("quieted for an ad")
 * is not reachable from a renderer in time to be true: main caches it from
 * GET /config and only refreshes that cache inside the 'autopause:status'
 * handler, so the value riding on 'autopause:changed' can be hours old. A
 * fourth pill state driven off an hours-old cache would be a lie, so it is
 * not built. The one-line main change that would make it honest is in the
 * lane report (attach a 3 s-cached adDuck to the 'media:now' answer).
 *
 * MOTION. Both pills sit on the titlebar's backdrop-filter, where every
 * animated frame re-blurs the row behind them. Nothing here animates: the
 * transitions are stepped and none runs longer than 150ms.
 */

(function () {
  /* --- shared ---------------------------------------------------------- */

  /** How wide a track line may get before it is cut, in characters. */
  var TRACK_CHARS = 28;

  /** The no-art /now poll. Matches app.js's own media gate. */
  var NP_POLL_MS = 2000;

  /** How often the budget card's "read 4 min ago" is re-worded locally. */
  var AGE_TICK_MS = 30000;

  /** How long a refused transport command stays on the card. */
  var REASON_MS = 8000;

  /** Both cards survive the pointer crossing the gap under the titlebar. */
  var CLOSE_GRACE_MS = 140;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(node, text) {
    var next = String(text === undefined || text === null ? '' : text);
    if (node && node.textContent !== next) node.textContent = next;
  }

  /** A string cut to n characters with an ellipsis, never mid-space. */
  function clip(text, n) {
    var s = String(text === undefined || text === null ? '' : text).trim();
    if (s.length <= n) return s;
    return s.slice(0, Math.max(1, n - 1)).replace(/\s+$/, '') + '…';
  }

  /**
   * "Title · Artist" inside TRACK_CHARS, with both halves still readable: the
   * title gives up its characters first, but never below eight, and the
   * artist keeps at least six. The titlebar must not reflow the tab strip
   * because a track has a long name, so the CSS caps the width too — this is
   * what makes the cut land in a sensible place rather than mid-word.
   */
  function trackLine(title, artist) {
    var t = String(title || '').trim();
    var a = String(artist || '').trim();
    if (!t) return clip(a, TRACK_CHARS);
    if (!a) return clip(t, TRACK_CHARS);
    var sep = ' · ';
    if ((t + sep + a).length <= TRACK_CHARS) return t + sep + a;
    var room = TRACK_CHARS - sep.length;
    var tLen = Math.max(8, Math.min(t.length, room - Math.min(a.length, 10)));
    var aLen = Math.max(6, room - tLen);
    return clip(t, tLen) + sep + clip(a, aLen);
  }

  /** "3 h 12 m", "14 min", "under a minute" — a span in plain words. */
  function spanWords(ms) {
    var n = Math.max(0, Math.round(ms / 60000));
    if (n < 1) return 'under a minute';
    if (n < 60) return n + ' min';
    var h = Math.floor(n / 60);
    var m = n % 60;
    return m ? h + ' h ' + m + ' m' : h + ' h';
  }

  /** The short form the pill uses when it has no room for words: "14 m". */
  function spanShort(ms) {
    var n = Math.max(0, Math.round(ms / 60000));
    if (n < 60) return Math.max(1, n) + ' m';
    var h = Math.floor(n / 60);
    var m = n % 60;
    return m ? h + ' h ' + m + ' m' : h + ' h';
  }

  /** "5:00 pm", in the machine's own clock. */
  function clockWords(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var period = h < 12 ? 'am' : 'pm';
    var hour = h % 12 === 0 ? 12 : h % 12;
    var min = d.getMinutes() < 10 ? '0' + d.getMinutes() : String(d.getMinutes());
    return hour + ':' + min + ' ' + period;
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** "today 5:00 pm", "tomorrow 5:00 pm", "Tue 5:00 pm", "12 Oct 5:00 pm". */
  function whenWords(ms, from) {
    var day = new Date(ms); day.setHours(0, 0, 0, 0);
    var today = new Date(from); today.setHours(0, 0, 0, 0);
    var days = Math.round((day.getTime() - today.getTime()) / 86400000);
    var time = clockWords(ms);
    if (days === 0) return 'today ' + time;
    if (days === 1) return 'tomorrow ' + time;
    if (days > 1 && days < 7) return DAYS[new Date(ms).getDay()] + ' ' + time;
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + time;
  }

  /**
   * One hover/focus card wired to one pill. The card is a DOM CHILD of the
   * slot, so the pointer moving down onto it never leaves the slot and
   * mouseleave does not fire; the grace timer covers the few pixels of gap
   * under the titlebar all the same. Click toggles it open so it is usable
   * without a pointer to hold still.
   */
  function wireCard(slot, pill, card) {
    var closeTimer = 0;
    var stuck = false;

    /* The card is positioned by CSS alone (absolute, under its own slot) and
       not by measuring: #titlebar carries a backdrop-filter and .chrome-layer
       a boot transform, and either one makes a position:fixed descendant
       resolve against THAT box instead of the viewport — so a top measured in
       viewport coordinates lands in the wrong place by however much the chrome
       is transformed. Anchoring to the slot sidesteps the whole question. */

    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
      if (!card.hidden) return;
      card.hidden = false;
      pill.setAttribute('aria-expanded', 'true');
    }

    function close(now) {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
      if (!now && !card.hidden) {
        closeTimer = setTimeout(function () { closeTimer = 0; close(true); }, CLOSE_GRACE_MS);
        return;
      }
      stuck = false;
      card.hidden = true;
      pill.setAttribute('aria-expanded', 'false');
    }

    slot.addEventListener('mouseenter', open);
    slot.addEventListener('mouseleave', function () { if (!stuck) close(false); });
    slot.addEventListener('focusin', open);
    slot.addEventListener('focusout', function (event) {
      if (stuck) return;
      if (event.relatedTarget && slot.contains(event.relatedTarget)) return;
      close(true);
    });
    pill.addEventListener('click', function () {
      stuck = !stuck;
      if (stuck) open(); else close(true);
    });
    slot.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !card.hidden) { close(true); pill.focus(); }
    });

    return { open: open, close: close, isOpen: function () { return !card.hidden; } };
  }

  /* ====================================================================== */
  /* The budget pill                                                        */
  /* ====================================================================== */

  var budget = (function () {
    var slot = document.getElementById('budget-slot');
    if (!slot) return null;

    var pill = el('button', 'pill pill-budget');
    pill.type = 'button';
    pill.id = 'budget-pill';
    pill.setAttribute('aria-haspopup', 'true');
    pill.setAttribute('aria-expanded', 'false');
    var pillText = el('span', 'pill-text', 'budget: reading…');
    pill.appendChild(pillText);

    var card = el('div', 'pill-card pill-card-budget');
    card.id = 'budget-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Claude usage');
    card.hidden = true;

    var rows = el('div', 'pill-rows');
    function makeRow(label) {
      var row = el('div', 'pill-row');
      row.appendChild(el('span', 'pill-row-label', label));
      var value = el('span', 'pill-row-value', '--');
      var note = el('span', 'pill-row-note', '');
      row.appendChild(value);
      row.appendChild(note);
      rows.appendChild(row);
      return { row: row, value: value, note: note };
    }
    var rowFive = makeRow('5-hour');
    var rowWeek = makeRow('Week');
    var rowToday = makeRow("Today's sessions");
    var source = el('p', 'pill-note pill-source', '');
    var reason = el('p', 'pill-note pill-reason', '');
    card.appendChild(rows);
    card.appendChild(source);
    card.appendChild(reason);

    slot.appendChild(pill);
    slot.appendChild(card);
    pill.setAttribute('aria-describedby', card.id);
    var cardCtl = wireCard(slot, pill, card);

    /** The last snapshot main sent, or a locally-made one when it cannot. */
    var snap = null;

    /** neutral under 80%, amber from 80, red from 95 — on the HIGHER limit. */
    function toneOf(snapshot) {
      var top = -1;
      if (snapshot.fiveHour) top = Math.max(top, snapshot.fiveHour.pct);
      if (snapshot.week) top = Math.max(top, snapshot.week.pct);
      if (top < 0) return 'none';
      if (top >= 95) return 'hot';
      if (top >= 80) return 'warm';
      return 'cool';
    }

    function pct(window_) {
      return window_ ? Math.round(window_.pct) + '%' : '--';
    }

    function money(usd) {
      if (usd === null || usd === undefined || !isFinite(usd)) return '--';
      return '$' + Number(usd).toFixed(2);
    }

    /**
     * The age of the reading, measured HERE. main's snapshot carries the age
     * it had when it was taken; between pushes this clock is the honest one,
     * which is also what makes a main that stopped pushing visible instead of
     * frozen at "1 min ago".
     */
    function ageMs() {
      if (!snap || !snap.source) return null;
      return Math.max(0, Date.now() - snap.source.receivedAt);
    }

    function paint() {
      if (!snap) return;
      var state = snap.state === 'ok' || snap.state === 'stale' ? snap.state : 'error';
      var age = ageMs();
      /* main marks a reading stale at ten minutes; this clock keeps that
         true between pushes rather than waiting for the next one. */
      if (state === 'ok' && age !== null && age > 600000) state = 'stale';

      var numbers = (snap.fiveHour || snap.week)
        ? '5H ' + pct(snap.fiveHour) + ' · WK ' + pct(snap.week)
        : '';

      if (state === 'error') {
        setText(pillText, 'budget: error');
      } else if (state === 'stale') {
        /* A stale reading still holds the last real percentages, so they stay
           on the pill with the staleness marked beside them; only a stale
           reading with no numbers at all falls back to words. */
        setText(pillText, numbers
          ? numbers + ' · stale ' + spanShort(age === null ? 0 : age)
          : 'budget: stale ' + spanShort(age === null ? 0 : age));
      } else {
        setText(pillText, numbers || 'budget: no reading');
      }

      pill.setAttribute('data-state', state);
      pill.setAttribute('data-tone', state === 'error' ? 'none' : toneOf(snap));
      pill.title = state === 'ok'
        ? 'Claude usage — hover for the detail'
        : 'Claude usage — ' + (snap.reason || state);

      setText(rowFive.value, pct(snap.fiveHour));
      setText(rowFive.note, snap.fiveHour && snap.fiveHour.resetsAt
        ? 'resets in ' + spanWords(snap.fiveHour.resetsAt - Date.now())
        : 'no reset time in the reading');
      setText(rowWeek.value, pct(snap.week));
      setText(rowWeek.note, snap.week && snap.week.resetsAt
        ? 'resets ' + whenWords(snap.week.resetsAt, Date.now())
        : 'no reset time in the reading');
      setText(rowToday.value, money(snap.todayUsd));
      setText(rowToday.note, snap.todayUsd === null
        ? 'no readings to add up'
        : '(' + snap.sessionsToday + (snap.sessionsToday === 1 ? ' session)' : ' sessions)'));

      if (snap.source) {
        setText(source, 'read ' + spanWords(age === null ? 0 : age) + ' ago · ' + snap.source.file);
      } else {
        setText(source, 'no reading has landed');
      }
      var text = snap.reason || '';
      setText(reason, text);
      reason.hidden = !text;
    }

    function apply(next) {
      if (!next || typeof next !== 'object') return;
      snap = next;
      paint();
    }

    /** A state this file made up, because the bridge is not there at all. */
    function local(reason_) {
      return {
        state: 'error', reason: reason_, at: Date.now(),
        fiveHour: null, week: null, todayUsd: null, sessionsToday: 0, source: null
      };
    }

    function start() {
      var api = (window.api && window.api.budget) ? window.api.budget : null;
      if (!api || typeof api.describe !== 'function') {
        /* Feature-detected end to end: an older preload has no budget group,
           and the pill says which piece is missing rather than vanishing. */
        apply(local('this build has no budget bridge (preload has no api.budget)'));
        return;
      }
      if (typeof api.onUpdate === 'function') api.onUpdate(apply);
      Promise.resolve(api.describe()).then(function (first) {
        if (first) apply(first);
        else apply(local('main refused the reading (this window is not the chrome)'));
      }).catch(function (err) {
        apply(local('the reading could not be fetched: ' + ((err && err.message) || 'error')));
      });
      setInterval(function () {
        /* Only the words age; a hidden window re-words nothing. */
        if (!document.hidden) paint();
      }, AGE_TICK_MS);
    }

    return {
      start: start,
      /* For a DOM probe over CDP, and for a doctor line later. */
      state: function () {
        return {
          text: pillText.textContent,
          state: pill.getAttribute('data-state'),
          tone: pill.getAttribute('data-tone'),
          cardOpen: !card.hidden,
          rows: {
            five: rowFive.value.textContent + ' ' + rowFive.note.textContent,
            week: rowWeek.value.textContent + ' ' + rowWeek.note.textContent,
            today: rowToday.value.textContent + ' ' + rowToday.note.textContent
          },
          source: source.textContent,
          reason: reason.hidden ? '' : reason.textContent,
          snapshot: snap
        };
      },
      open: function () { cardCtl.open(); },
      apply: apply
    };
  })();

  /* ====================================================================== */
  /* The now-playing pill                                                   */
  /* ====================================================================== */

  var nowPlaying = (function () {
    var slot = document.getElementById('np-slot');
    if (!slot) return null;

    var pill = el('button', 'pill pill-np');
    pill.type = 'button';
    pill.id = 'np-pill';
    pill.setAttribute('aria-haspopup', 'true');
    pill.setAttribute('aria-expanded', 'false');
    var glyph = el('span', 'glyph pill-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    var pillText = el('span', 'pill-text', '');
    pill.appendChild(glyph);
    pill.appendChild(pillText);

    var card = el('div', 'pill-card pill-card-np');
    card.id = 'np-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Now playing');
    card.hidden = true;

    var head = el('div', 'np-head');
    var art = el('img', 'np-art');
    art.alt = '';
    art.hidden = true;
    var lines = el('div', 'np-lines');
    var npTitle = el('p', 'np-title', '');
    var npArtist = el('p', 'np-artist', '');
    var npAlbum = el('p', 'np-album', '');
    lines.appendChild(npTitle);
    lines.appendChild(npArtist);
    lines.appendChild(npAlbum);
    head.appendChild(art);
    head.appendChild(lines);

    var acts = el('div', 'np-acts');
    function actButton(cmd, label, mark) {
      var button = el('button', 'np-btn');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('data-cmd', cmd);
      var span = el('span', 'glyph', mark);
      span.setAttribute('aria-hidden', 'true');
      button.appendChild(span);
      button.addEventListener('click', function () { control(cmd); });
      acts.appendChild(button);
      return button;
    }
    /* Segoe Fluent Icons: E892 previous, E768 play, E769 pause, E893 next. */
    var prevBtn = actButton('prev', 'Previous track', '');
    var toggleBtn = actButton('toggle', 'Play or pause', '');
    var nextBtn = actButton('next', 'Next track', '');

    var note = el('p', 'pill-note np-note', '');
    note.hidden = true;
    card.appendChild(head);
    card.appendChild(acts);
    card.appendChild(note);

    slot.appendChild(pill);
    slot.appendChild(card);
    pill.setAttribute('aria-describedby', card.id);
    var cardCtl = wireCard(slot, pill, card);

    /** The last /now answer, the art we hold for it, and the last refusal. */
    var last = null;
    var artHash = '';
    var artData = '';
    var refusal = '';
    var refusalTimer = 0;
    var timer = 0;
    var inFlight = false;

    function api() {
      var group = (window.api && window.api.media) ? window.api.media : null;
      return group && typeof group.now === 'function' ? group : null;
    }

    /**
     * The bridge hands art over as raw base64 with the type beside it, not as
     * a data URL — assigning it to img.src as-is resolves it as a file path
     * and shows a broken image. Same rule the new tab page's media tile keeps.
     */
    function artUrl(raw, mime) {
      var s = String(raw === undefined || raw === null ? '' : raw);
      if (!s) return '';
      if (s.slice(0, 5) === 'data:') return s;
      return 'data:' + (mime || 'image/jpeg') + ';base64,' + s;
    }

    /** Nothing to show: the slot goes back to costing no width at all. */
    function hide() {
      if (!pill.hidden) {
        pill.hidden = true;
        cardCtl.close(true);
      }
      slot.setAttribute('data-showing', '0');
    }

    function playable(answer) {
      if (!answer || answer.ok !== true) return false;
      var status = String(answer.status || 'none');
      if (status === 'none' || status === 'stopped') return false;
      if (!answer.source && !answer.title) return false;
      return !!(answer.title || answer.artist);
    }

    function paint() {
      if (!playable(last)) { hide(); return; }
      var playing = String(last.status) === 'playing';
      var held = last.held === true;

      pill.hidden = false;
      slot.setAttribute('data-showing', '1');
      setText(glyph, playing ? '' : '');
      setText(pillText, trackLine(last.title, last.artist));
      pill.setAttribute('data-state', playing ? 'playing' : 'paused');
      pill.setAttribute('data-held', held ? '1' : '0');
      pill.title = (last.title || '') + (last.artist ? ' — ' + last.artist : '') +
        (held ? ' (paused for a video)' : playing ? ' (playing)' : ' (paused)');

      setText(npTitle, last.title || 'Unknown track');
      setText(npArtist, last.artist || '');
      npArtist.hidden = !last.artist;
      setText(npAlbum, last.album || '');
      npAlbum.hidden = !last.album;
      if (artData) { art.src = artData; art.hidden = false; } else { art.hidden = true; }

      setText(toggleBtn.querySelector('.glyph'), playing ? '' : '');
      toggleBtn.title = playing ? 'Pause' : 'Play';
      prevBtn.disabled = last.canPrev === false;
      nextBtn.disabled = last.canNext === false;
      toggleBtn.disabled = last.canPlayPause === false;

      /* One line under the buttons, and it is the most important line on the
         card: why a press did nothing, or why the music is quiet. */
      var text = refusal;
      if (!text && held) {
        text = 'paused for a video — auto-pause is holding Spotify until the video stops';
      }
      setText(note, text);
      note.hidden = !text;
    }

    function showRefusal(text) {
      refusal = text;
      if (refusalTimer) clearTimeout(refusalTimer);
      refusalTimer = setTimeout(function () { refusalTimer = 0; refusal = ''; paint(); }, REASON_MS);
      paint();
    }

    function control(cmd) {
      var group = api();
      if (!group || typeof group.control !== 'function') {
        showRefusal('this build cannot drive the player (preload has no media.control)');
        return;
      }
      Promise.resolve(group.control(cmd)).then(function (answer) {
        if (answer && answer.ok === true) {
          refusal = '';
          if (refusalTimer) { clearTimeout(refusalTimer); refusalTimer = 0; }
          /* The bridge takes a beat to report the new state. */
          setTimeout(poll, 350);
          return;
        }
        var why = (answer && answer.reason) ? String(answer.reason) : 'the bridge refused it';
        showRefusal(why === 'held'
          ? 'held: auto-pause is holding Spotify for a video and will not be overruled'
          : cmd + ': ' + why);
      }).catch(function (err) {
        showRefusal(cmd + ': ' + ((err && err.message) || 'the call failed'));
      });
    }

    /**
     * One cheap read. Art is asked for only when the hash we hold is not the
     * hash the bridge just named, and then exactly once per change — the art
     * is ~30 KB of base64 and this runs every two seconds.
     */
    function poll() {
      var group = api();
      if (!group) { hide(); return; }
      if (inFlight) return;
      inFlight = true;
      Promise.resolve(group.now()).then(function (answer) {
        inFlight = false;
        last = answer;
        if (!playable(answer)) { artHash = ''; artData = ''; paint(); return; }
        var hash = String(answer.artHash || '');
        if (hash && hash !== artHash) {
          /* Pass the hash we HOLD: the bridge answers with the bytes only
             because it differs from the one it has. */
          Promise.resolve(group.now(artHash || '')).then(function (full) {
            if (full && full.ok === true && typeof full.art === 'string' && full.art) {
              artHash = String(full.artHash || hash);
              artData = artUrl(full.art, full.artMime);
              paint();
            } else {
              /* No art for this track: the card shows the lines alone. */
              artHash = hash;
              artData = '';
              paint();
            }
          }).catch(function () { artHash = hash; artData = ''; paint(); });
        } else if (!hash && artData) {
          artHash = '';
          artData = '';
        }
        paint();
      }).catch(function () {
        inFlight = false;
        /* A bridge that is not answering is not a player that is playing:
           the pill goes away. The bridge's own health is in Settings ->
           Spotify auto-pause, which says what is wrong and why. */
        last = null;
        hide();
      });
    }

    function sync() {
      if (document.visibilityState === 'visible') {
        if (!timer) timer = setInterval(poll, NP_POLL_MS);
        poll();
      } else if (timer) {
        clearInterval(timer);
        timer = 0;
      }
    }

    function start() {
      pill.hidden = true;
      slot.setAttribute('data-showing', '0');
      pill.addEventListener('click', function (event) {
        /* The click that toggles the card also drives the player: the pill IS
           the play/pause control, and the card is what the hover already
           showed. Modifier-free left click only. */
        if (event.altKey || event.ctrlKey || event.shiftKey) return;
        control('toggle');
      });
      document.addEventListener('visibilitychange', sync);
      sync();
    }

    return {
      start: start,
      poll: poll,
      /* For a DOM probe over CDP. */
      state: function () {
        return {
          hidden: pill.hidden,
          text: pillText.textContent,
          state: pill.getAttribute('data-state'),
          held: pill.getAttribute('data-held'),
          cardOpen: !card.hidden,
          note: note.hidden ? '' : note.textContent,
          hasArt: !art.hidden,
          answer: last
        };
      },
      open: function () { cardCtl.open(); },
      control: control
    };
  })();

  /* --- boot -------------------------------------------------------------- */

  function start() {
    if (budget) budget.start();
    if (nowPlaying) nowPlaying.start();
    /* One handle for both, so a CDP probe or a later doctor page can read
       exactly what the titlebar is showing without touching the DOM. */
    window.Pills = {
      budget: budget ? budget.state : function () { return null; },
      np: nowPlaying ? nowPlaying.state : function () { return null; },
      openBudget: budget ? budget.open : function () {},
      openNp: nowPlaying ? nowPlaying.open : function () {},
      pollNp: nowPlaying ? nowPlaying.poll : function () {},
      npControl: nowPlaying ? nowPlaying.control : function () {},
      applyBudget: budget ? budget.apply : function () {}
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
