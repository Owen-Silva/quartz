'use strict';

/*
 * historypage.js — the browser's history, as a page.
 *
 * Runs inside a <webview> on file://, with no node and no preload: plain
 * browser script, no require(), no import. Loaded from <head> above the
 * stylesheet, like reader-page.js, because the chrome can call
 * window.__applyHistory() the moment the page reports ready — possibly
 * before DOMContentLoaded — and that call must never land on nothing.
 *
 * THE CONTRACT, both ways:
 *
 *   in   window.__applyHistory({ items: [{url,title,visits,last}], total })
 *        Newest first, up to 2000 rows. Called once per load and again
 *        after anything changes the store.
 *
 *   out  console.log('__history:' + JSON.stringify(msg))
 *        A page with no preload has exactly one channel back, and this is
 *        it: the chrome listens to console-message and forwards every
 *        '__history:' line to History.handleGuestMessage(). The four
 *        messages are { op:'remove', url }, { op:'clear' },
 *        { op:'clearRange', olderThanMs } and { op:'open', url, background }.
 *
 * TRUST. Every value below came out of localStorage in the chrome, which
 * means it came off the open web: titles and URLs are written with
 * createElement and textContent only, and nothing on this page is ever
 * built by assigning markup.
 *
 * MOTION. Hovers and the highlight step between two states; nothing on
 * this page animates on a loop and nothing slides.
 */

(function () {
  var DEBOUNCE = 60;          // ms of quiet before the list re-filters
  var HOUR = 3.6e6;
  var DAY = 86400000;
  var FAVICON = 'https://www.google.com/s2/favicons?domain=';

  /* --- state ---------------------------------------------------- */

  var items = [];             // everything the chrome sent, newest first
  var total = 0;              // the store's own count (>= items.length)
  var view = [];              // what is on screen right now
  var rowEls = [];            // one element per view entry, same order
  var query = '';
  var hi = -1;                // index into view; -1 = nothing highlighted
  var inputTimer = null;
  var menuOpen = false;

  var listEl = null;
  var emptyEl = null;
  var countEl = null;
  var qEl = null;
  var clearEl = null;
  var menuEl = null;

  /* --- small helpers -------------------------------------------- */

  function toWords(text) {
    return String(text == null ? '' : text).toLowerCase().trim().split(/\s+/)
      .filter(function (w) { return !!w; });
  }

  function hostOf(url) {
    try {
      var h = new URL(String(url)).hostname;
      return h ? h.replace(/^www\./, '') : '';
    } catch (err) {
      return '';
    }
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** Today / Yesterday / a weekday inside the last week / a full date. */
  function dayLabel(ts) {
    if (!ts) return 'Earlier';
    var d = new Date(ts);
    var diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function plural(n, one, many) {
    return n.toLocaleString() + ' ' + (n === 1 ? one : many);
  }

  /** Every word has to land somewhere in the title or the url. */
  function matches(item, words) {
    var hay = ((item.title || '') + ' ' + item.url).toLowerCase();
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(words[i]) === -1) return false;
    }
    return true;
  }

  /**
   * Put `text` in `el`, wrapping every query word in <mark>. Text nodes and
   * elements only — the string itself is never parsed.
   */
  function fill(el, text, words) {
    el.textContent = '';
    var str = String(text == null ? '' : text);
    if (!words || !words.length || !str) { el.textContent = str; return; }

    var lower = str.toLowerCase();
    var hits = [];
    var i;
    for (i = 0; i < words.length; i++) {
      var w = words[i];
      var from = 0;
      var at;
      while (w && (at = lower.indexOf(w, from)) !== -1) {
        hits.push([at, at + w.length]);
        from = at + w.length;
      }
    }
    if (!hits.length) { el.textContent = str; return; }

    hits.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var merged = [];
    for (i = 0; i < hits.length; i++) {
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && hits[i][0] <= last[1]) {
        if (hits[i][1] > last[1]) last[1] = hits[i][1];
      } else {
        merged.push([hits[i][0], hits[i][1]]);
      }
    }

    var pos = 0;
    for (i = 0; i < merged.length; i++) {
      if (merged[i][0] > pos) el.appendChild(document.createTextNode(str.slice(pos, merged[i][0])));
      var mark = document.createElement('mark');
      mark.textContent = str.slice(merged[i][0], merged[i][1]);
      el.appendChild(mark);
      pos = merged[i][1];
    }
    if (pos < str.length) el.appendChild(document.createTextNode(str.slice(pos)));
  }

  /* --- talking back to the chrome -------------------------------- */

  function send(msg) {
    try { console.log('__history:' + JSON.stringify(msg)); } catch (err) { /* nothing to do */ }
  }

  /* --- rendering -------------------------------------------------- */

  function buildRow(item, words) {
    var host = hostOf(item.url);

    var row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('data-url', item.url);

    var favbox = document.createElement('span');
    favbox.className = 'favbox';
    if (host) {
      var img = document.createElement('img');
      img.className = 'fav';
      img.width = 16;
      img.height = 16;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { img.hidden = true; });
      img.src = FAVICON + encodeURIComponent(host) + '&sz=32';
      favbox.appendChild(img);
    }
    row.appendChild(favbox);

    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeLabel(item.last);
    row.appendChild(time);

    var title = document.createElement('span');
    title.className = 'title';
    fill(title, item.title || host || item.url, words);
    row.appendChild(title);

    var hostEl = document.createElement('span');
    hostEl.className = 'host';
    fill(hostEl, host, words);
    row.appendChild(hostEl);

    var rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.tabIndex = -1;
    rm.title = 'Remove from history';
    rm.setAttribute('aria-label', 'Remove from history');
    rm.textContent = '×';
    row.appendChild(rm);

    return row;
  }

  function paintCount() {
    if (!countEl) return;
    countEl.textContent = query
      ? plural(view.length, 'match', 'matches')
      : plural(total || items.length, 'page', 'pages');
  }

  function paintEmpty() {
    if (!emptyEl) return;
    if (view.length) { emptyEl.hidden = true; return; }
    emptyEl.textContent = items.length ? 'No matches' : 'Nothing here yet';
    emptyEl.hidden = false;
  }

  function render() {
    if (!listEl) return;

    var words = toWords(query);
    view = words.length
      ? items.filter(function (it) { return matches(it, words); })
      : items.slice();

    listEl.textContent = '';
    rowEls = [];

    var frag = document.createDocumentFragment();
    var label = null;
    for (var i = 0; i < view.length; i++) {
      var next = dayLabel(view[i].last);
      if (next !== label) {
        label = next;
        var head = document.createElement('h2');
        head.className = 'daybar';
        head.textContent = label;
        frag.appendChild(head);
      }
      var row = buildRow(view[i], words);
      rowEls.push(row);
      frag.appendChild(row);
    }
    listEl.appendChild(frag);

    if (hi >= view.length) hi = view.length - 1;
    paintHighlight(false);
    paintCount();
    paintEmpty();
  }

  function paintHighlight(scroll) {
    for (var i = 0; i < rowEls.length; i++) {
      if (i === hi) rowEls[i].classList.add('hi');
      else rowEls[i].classList.remove('hi');
    }
    if (scroll && hi >= 0 && rowEls[hi] && rowEls[hi].scrollIntoView) {
      rowEls[hi].scrollIntoView({ block: 'nearest' });
    }
  }

  function move(step) {
    if (!view.length) { hi = -1; return; }
    if (hi < 0) hi = step > 0 ? 0 : view.length - 1;
    else hi = Math.min(view.length - 1, Math.max(0, hi + step));
    paintHighlight(true);
  }

  /* --- actions ----------------------------------------------------- */

  function openUrl(url, background) {
    if (!url) return;
    send({ op: 'open', url: url, background: !!background });
  }

  /** Drop it here too, so the row goes now and not on the chrome's next push. */
  function removeUrl(url) {
    if (!url) return;
    send({ op: 'remove', url: url });
    var before = items.length;
    items = items.filter(function (it) { return it.url !== url; });
    if (items.length !== before) total = Math.max(0, total - (before - items.length));
    render();
  }

  function clearAll() {
    send({ op: 'clear' });
    items = [];
    total = 0;
    hi = -1;
    render();
  }

  function clearRange(olderThanMs) {
    send({ op: 'clearRange', olderThanMs: olderThanMs });
    var cutoff = Date.now() - olderThanMs;
    var before = items.length;
    items = items.filter(function (it) { return !(it.last >= cutoff); });
    total = Math.max(0, total - (before - items.length));
    hi = -1;
    render();
  }

  /* --- the clear menu ---------------------------------------------- */

  function setMenu(open) {
    menuOpen = !!open;
    if (menuEl) menuEl.hidden = !menuOpen;
    if (clearEl) clearEl.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
  }

  function onMenuClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('.clearopt') : null;
    if (!btn) return;
    var range = btn.getAttribute('data-range');
    setMenu(false);
    if (range === 'hour') clearRange(HOUR);
    else if (range === 'today') clearRange(Date.now() - startOfDay(Date.now()));
    else if (range === 'all') clearAll();
  }

  /* --- events ------------------------------------------------------ */

  function rowIndex(el) {
    var row = el && el.closest ? el.closest('.row') : null;
    if (!row) return -1;
    return rowEls.indexOf(row);
  }

  function onListClick(event) {
    if (event.target && event.target.closest && event.target.closest('.rm')) {
      event.preventDefault();
      event.stopPropagation();
      var gone = rowIndex(event.target);
      if (gone >= 0) removeUrl(view[gone].url);
      return;
    }
    var index = rowIndex(event.target);
    if (index < 0) return;
    event.preventDefault();
    hi = index;
    paintHighlight(false);
    // Ctrl-click opens behind; the middle button lands on auxclick instead.
    openUrl(view[index].url, event.ctrlKey || event.metaKey);
  }

  function onListAux(event) {
    if (event.button !== 1) return;
    if (event.target && event.target.closest && event.target.closest('.rm')) return;
    var index = rowIndex(event.target);
    if (index < 0) return;
    event.preventDefault();
    openUrl(view[index].url, true);
  }

  function applyQuery(text) {
    query = String(text || '');
    hi = -1;
    render();
  }

  function onInput() {
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      inputTimer = null;
      applyQuery(qEl.value);
    }, DEBOUNCE);
  }

  function onKey(event) {
    if (event.defaultPrevented) return;
    var key = event.key;
    var inField = event.target === qEl;

    if (key === '/' && !inField && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (qEl) { qEl.focus(); qEl.select(); }
      return;
    }

    if (key === 'Escape') {
      if (menuOpen) { setMenu(false); return; }
      if (qEl && qEl.value) {
        event.preventDefault();
        qEl.value = '';
        if (inputTimer !== null) { clearTimeout(inputTimer); inputTimer = null; }
        applyQuery('');
      }
      return;
    }

    if (key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (key === 'ArrowUp') { event.preventDefault(); move(-1); return; }

    // Once a row is highlighted the list owns Enter and Delete, wherever
    // the caret happens to be: highlighting it was a deliberate act.
    if (hi < 0 || !view[hi]) return;

    if (key === 'Enter') {
      event.preventDefault();
      openUrl(view[hi].url, event.ctrlKey || event.metaKey);
      return;
    }
    if (key === 'Delete') {
      event.preventDefault();
      removeUrl(view[hi].url);
    }
  }

  /* --- the chrome's push ------------------------------------------- */

  function applyHistory(payload) {
    var data = payload && typeof payload === 'object' ? payload : {};
    var list = Array.isArray(data.items) ? data.items : [];
    items = [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || typeof row.url !== 'string' || !row.url) continue;
      items.push({
        url: row.url,
        title: typeof row.title === 'string' ? row.title : '',
        visits: Number(row.visits) > 0 ? Number(row.visits) : 1,
        last: Number(row.last) > 0 ? Number(row.last) : 0
      });
    }
    total = Number(data.total) > 0 ? Number(data.total) : items.length;
    hi = -1;
    render();
  }

  window.__applyHistory = applyHistory;
  window.__historyItems = function () {
    return items.map(function (it) {
      return { url: it.url, title: it.title, visits: it.visits, last: it.last };
    });
  };

  /* --- boot --------------------------------------------------------- */

  function attach() {
    listEl = document.getElementById('list');
    emptyEl = document.getElementById('empty');
    countEl = document.getElementById('count');
    qEl = document.getElementById('q');
    clearEl = document.getElementById('clear');
    menuEl = document.getElementById('clearmenu');
    if (!listEl) return;

    if (qEl) {
      qEl.addEventListener('input', onInput);
      qEl.addEventListener('search', function () { applyQuery(qEl.value); });
    }
    if (clearEl) {
      clearEl.addEventListener('click', function (event) {
        event.stopPropagation();
        setMenu(!menuOpen);
      });
    }
    if (menuEl) menuEl.addEventListener('click', onMenuClick);

    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('auxclick', onListAux);
    // Middle-click otherwise starts the scroll widget over the list.
    listEl.addEventListener('mousedown', function (event) {
      if (event.button === 1) event.preventDefault();
    });

    document.addEventListener('keydown', onKey);
    document.addEventListener('click', function () { if (menuOpen) setMenu(false); });

    setMenu(false);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
})();
