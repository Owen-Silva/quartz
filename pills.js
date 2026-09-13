'use strict';

/*
 * pills.js — the titlebar readout: the Claude budget pill (#budget-slot),
 * a static slot in index.html between the spacer and the window controls.
 *
 * Plain browser script (contextIsolation on): reads window.api.budget only;
 * owns every .pill-* class and everything inside its slot, nothing else.
 *
 * WHAT IT IS. Always present. It shows the higher of the two Claude limits at
 * a glance and everything else on hover/focus, and it never goes blank: a
 * reading that is old, unreadable or missing says so IN the pill, with the
 * reason in the card, because a slot that empties itself when the source
 * breaks is the definition of a silent failure. main pushes it (budget.js,
 * 30 s poll); this file only re-words the age between pushes, off its own
 * clock, which is also what makes a main that STOPPED pushing visible rather
 * than frozen at "1 min ago".
 *
 * AGE IS NOT A FAULT. A Claude Code session that goes idle simply stops
 * writing, so ten minutes without a tick buys the age beside the numbers and
 * a dashed border, nothing more — the percentages are still the truth. Only
 * an hour earns the word "stale" and a dimmed pill.
 *
 * THE CARD IS IN <body>. See wireCard: a card inside the titlebar is trapped
 * in that row's stacking context and the nav row paints over it.
 *
 * MOTION. The pill sits on the titlebar's backdrop-filter, where every
 * animated frame re-blurs the row behind it. Nothing here animates: the
 * transitions are stepped and none runs longer than 150ms.
 */

(function () {
  /* --- shared ---------------------------------------------------------- */

  /** How often the budget card's "read 4 min ago" is re-worded locally. */
  var AGE_TICK_MS = 30000;

  /** The card survives the pointer crossing the gap under the titlebar. */
  var CLOSE_GRACE_MS = 140;

  /** How close a card may come to the window's edge. #workspaces-panel's. */
  var GUTTER = 8;

  /**
   * From here the budget pill shows the age of the reading beside the
   * numbers. A Claude Code session that goes idle simply stops writing: the
   * limits it last reported are still the truth, only older.
   */
  var AGE_NOTE_MS = 600000;

  /** And from here it is old enough to be CALLED stale, and the pill dims. */
  var STALE_MS = 3600000;

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
   * One hover/focus card wired to one pill.
   *
   * THE CARD LIVES IN <body>, not in its slot. A card inside #titlebar is
   * trapped in that row's stacking context — the titlebar carries a
   * backdrop-filter, which makes one — so no z-index can lift it over the nav
   * row below, and the nav row painted straight over its top. #workspaces-panel
   * met this first and this follows it exactly: appended to the body, fixed,
   * z-index 20, placed from the slot's rect on every open and every resize.
   *
   * Measuring is right HERE and was wrong before: a fixed element in the body
   * resolves against the viewport, while a fixed DESCENDANT of #titlebar or
   * .chrome-layer (a boot transform) resolves against that box instead — which
   * is what the comment that used to sit here was about.
   *
   * The pointer now has to LEAVE the slot to reach the card, so the card
   * carries the same enter/leave pair and the same grace timer covers the gap
   * between the two. Click toggles it open so it is usable without a pointer
   * to hold still.
   */
  function wireCard(slot, pill, card) {
    var closeTimer = 0;
    var stuck = false;

    document.body.appendChild(card);

    /**
     * Right-aligned under the slot, and never off the edge of the window: a
     * pill near the window controls would otherwise hang a 268px card over the
     * right edge, and a short window would hang it off the bottom.
     */
    function position() {
      var r = slot.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var w = card.offsetWidth || 268;
      var h = card.offsetHeight || 0;
      var left = Math.round(r.right - w);
      if (vw && left + w > vw - GUTTER) left = vw - GUTTER - w;
      if (left < GUTTER) left = GUTTER;
      var top = Math.round(r.bottom + 6);
      if (vh && h && top + h > vh - GUTTER) top = vh - GUTTER - h;
      if (top < GUTTER) top = GUTTER;
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    }

    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
      if (!card.hidden) { position(); return; }
      card.hidden = false;
      pill.setAttribute('aria-expanded', 'true');
      /* After it is shown, so offsetWidth/Height are real numbers. */
      position();
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

    /** Focus that went from one of the pair to the other has not left. */
    function stillInside(event) {
      var to = event.relatedTarget;
      return !!(to && (slot.contains(to) || card.contains(to)));
    }

    /* Escape puts focus back on the pill, and the pill is inside the slot
       whose focusin OPENS the card — so without this flag the card closed and
       reopened in the same tick and Escape did nothing at all. It is cleared
       the moment focus really leaves, or the pointer deliberately arrives. */
    var dismissed = false;

    function onEnter() { dismissed = false; open(); }
    function onLeave() { if (!stuck) close(false); }
    function onFocusIn() { if (!dismissed) open(); }
    function onFocusOut(event) {
      if (stillInside(event)) return;
      dismissed = false;
      if (stuck) return;
      close(true);
    }
    function onKey(event) {
      if (event.key !== 'Escape' || card.hidden) return;
      dismissed = true;
      close(true);
      pill.focus();
    }

    slot.addEventListener('mouseenter', onEnter);
    slot.addEventListener('mouseleave', onLeave);
    card.addEventListener('mouseenter', onEnter);
    card.addEventListener('mouseleave', onLeave);
    slot.addEventListener('focusin', onFocusIn);
    card.addEventListener('focusin', onFocusIn);
    slot.addEventListener('focusout', onFocusOut);
    card.addEventListener('focusout', onFocusOut);
    pill.addEventListener('click', function () {
      stuck = !stuck;
      if (stuck) open(); else close(true);
    });
    slot.addEventListener('keydown', onKey);
    card.addEventListener('keydown', onKey);
    /* A resized window has moved the slot; an open card follows it instead of
       hanging where the slot used to be. */
    window.addEventListener('resize', function () { if (!card.hidden) position(); });

    return {
      open: open,
      close: close,
      position: position,
      isOpen: function () { return !card.hidden; }
    };
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
    /* "Today", not "Today's sessions": the figure is what has been SPENT
       today, not what the sessions have cost in their lifetimes. */
    var rowToday = makeRow('Today');
    /* Shown only when a baseline had to be taken mid-flight, because only then
       is the figure a partial one and only then does the user need to know. */
    var since = el('p', 'pill-note pill-since', '');
    since.hidden = true;
    var source = el('p', 'pill-note pill-source', '');
    var reason = el('p', 'pill-note pill-reason', '');
    card.appendChild(rows);
    card.appendChild(since);
    card.appendChild(source);
    card.appendChild(reason);

    /* The card is appended to <body> by wireCard, not to the slot: see the
       comment there. Only the pill belongs to the titlebar. */
    slot.appendChild(pill);
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
      /* main calls a reading stale at an hour; this clock keeps that true
         between pushes rather than waiting for the next one, in BOTH
         directions — a snapshot that arrives already stale is stale, and one
         that ages past the hour on screen becomes stale without a push. */
      if (state !== 'error' && age !== null) state = age >= STALE_MS ? 'stale' : 'ok';
      /* Ten minutes is not a fault, it is an age: the pill says how old the
         numbers are and keeps showing them in their own tone. */
      var aged = state !== 'error' && age !== null && age >= AGE_NOTE_MS;

      var numbers = (snap.fiveHour || snap.week)
        ? '5H ' + pct(snap.fiveHour) + ' · WK ' + pct(snap.week)
        : '';

      if (state === 'error') {
        setText(pillText, 'budget: error');
      } else if (!numbers) {
        /* Only a reading with no percentages at all falls back to words. */
        setText(pillText, state === 'stale'
          ? 'budget: stale ' + spanShort(age === null ? 0 : age)
          : 'budget: no reading');
      } else if (state === 'stale') {
        setText(pillText, numbers + ' · stale ' + spanShort(age));
      } else if (aged) {
        setText(pillText, numbers + ' · ' + spanShort(age));
      } else {
        setText(pillText, numbers);
      }

      pill.setAttribute('data-state', state);
      /* Two separate things: 'old' dashes the border from ten minutes and
         leaves the limit's tone alone, 'stale' dims the type from an hour. */
      pill.setAttribute('data-age', aged ? 'old' : 'fresh');
      pill.setAttribute('data-tone', state === 'error' ? 'none' : toneOf(snap));
      pill.title = (state === 'ok' && !aged)
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

      /* A figure counted from part-way through a session says so. Without
         this line "Today $3.10" would look like the whole day. */
      var sinceText = snap.todaySince
        ? 'counted since the browser first looked today at ' + clockWords(snap.todaySince)
        : '';
      setText(since, sinceText);
      since.hidden = !sinceText;

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
        fiveHour: null, week: null, todayUsd: null, sessionsToday: 0,
        todaySince: null, source: null
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
          age: pill.getAttribute('data-age'),
          tone: pill.getAttribute('data-tone'),
          cardOpen: !card.hidden,
          rows: {
            five: rowFive.value.textContent + ' ' + rowFive.note.textContent,
            week: rowWeek.value.textContent + ' ' + rowWeek.note.textContent,
            today: rowToday.value.textContent + ' ' + rowToday.note.textContent
          },
          since: since.hidden ? '' : since.textContent,
          source: source.textContent,
          reason: reason.hidden ? '' : reason.textContent,
          snapshot: snap
        };
      },
      open: function () { cardCtl.open(); },
      close: function () { cardCtl.close(true); },
      apply: apply
    };
  })();

  /* --- boot -------------------------------------------------------------- */

  function start() {
    if (budget) budget.start();
    /* One handle, so a CDP probe or a later doctor page can read exactly what
       the titlebar is showing without touching the DOM. */
    window.Pills = {
      budget: budget ? budget.state : function () { return null; },
      openBudget: budget ? budget.open : function () {},
      closeBudget: budget ? budget.close : function () {},
      applyBudget: budget ? budget.apply : function () {}
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
