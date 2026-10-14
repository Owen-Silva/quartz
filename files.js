'use strict';

/*
 * files.js — the browser's own folder browser, as a page.
 *
 * Runs inside a <webview> on file://, with no node and no preload: plain
 * browser script, no require(), no import. Loaded from <head> above the
 * stylesheet, like historypage.js and reader-page.js, because the chrome can
 * call window.__applyFiles() the moment the page reports ready — possibly
 * before DOMContentLoaded — and that call must never land on nothing. Every
 * push therefore lands in state first and paints only if the document is up;
 * boot() re-paints whatever arrived early.
 *
 * THE CONTRACT, both ways.
 *
 *   out  console.log('files:<verb> ' + JSON.stringify(payload))
 *        A page with no preload has exactly one channel back, and this is it:
 *        the chrome listens to console-message and forwards every 'files:'
 *        line. The five verbs are
 *          files:list      {"path":"C:\\Users\\you"} | {"path":null}
 *          files:open      {"path":...}
 *          files:reveal    {"path":...}
 *          files:icons     {"paths":[...]}        (at most 64 per line)
 *          files:copy-path {"path":...}
 *
 *   in   window.__applyFiles({ path, parent, entries, error, truncated })
 *        window.__applyFilePlaces({ places, drives })
 *        window.__applyFileIcons({ [path]: dataUrl | null })
 *        window.__applyFileResult({ action, path, ok, reason })
 *
 * TRUST. Every name, path and icon below came off the filesystem, which means
 * it can contain anything: names are written with createElement and
 * textContent only, an icon only ever becomes an <img src> when it is a
 * data: URL, and nothing on this page is ever built by assigning markup.
 *
 * STORAGE. file:// localStorage is unreliable and can throw on every call, so
 * both keys (files.sort, files.last) go through readStore/writeStore and a
 * throwing store simply means the authored defaults and the root.
 *
 * MOTION. Hovers and the selection step between two states; nothing here
 * animates on a loop and nothing slides.
 *
 * TESTING. window.__filesInternals exposes the pure half — the formatters,
 * the sort, the filter, the breadcrumb split, the icon batching and the
 * storage helpers — so a plain-node harness with a DOM shim can drive it
 * without Electron. It is a read-only surface; the page never calls through it.
 */

(function () {
  /* --- constants ------------------------------------------------- */

  var PREFIX = 'files:';

  /** localStorage keys. */
  var SORT_KEY = 'files.sort';
  var LAST_KEY = 'files.last';

  /** Icons are asked for in visible-sized bites, never for a whole folder. */
  var ICON_FIRST = 80;        // rows covered by the opening ask
  var ICON_LINE = 64;         // the contract's cap: at most 64 paths per line
  var ICON_AHEAD = 40;        // rows past the viewport a scroll pulls in

  var ROW_H = 32;             // must match .row in files.css
  var FILTER_DEBOUNCE = 60;   // ms of quiet before the listing re-filters
  var STATUS_MS = 3000;       // how long an inline result note stays up

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** The three errors main.js maps, stated for a person. */
  var ERRORS = {
    'not-found': 'Folder not found',
    'access-denied': 'Windows would not let the browser read this folder',
    'not-a-folder': 'That is a file, not a folder'
  };

  /* --- state ----------------------------------------------------- */

  var cwd = null;             // the folder on screen; null = the root
  var parentPath = null;      // what Backspace and Go up mean here
  var entries = [];           // everything the chrome sent for cwd
  var truncated = false;      // the chrome stopped at 2000
  var error = null;           // null, one of ERRORS' keys, or a message
  var view = [];              // what is on screen right now (sorted, filtered)
  var rowEls = [];            // one element per view entry, same order
  var sel = -1;               // index into view; -1 = nothing selected
  var query = '';
  var sort = { key: 'name', dir: 'asc' };
  var places = [];
  var drives = [];
  var icons = {};             // path -> dataUrl | null, as the chrome answered
  var asked = {};             // path -> true once it has been asked for
  var painted = {};           // path -> true once an <img src> has been set
  var editing = false;        // the path bar is showing its text field
  var ready = false;          // boot() has run; the DOM is safe to touch
  var pending = null;         // the path files:list was last sent for
  var filterTimer = null;
  var statusTimer = null;
  var menuFor = null;         // the entry the inline menu belongs to

  var el = {};                // every element boot() grabs, by id

  /* --- pure: sizes and dates ------------------------------------- */

  var KB = 1024;
  var MB = KB * 1024;
  var GB = MB * 1024;
  var TB = GB * 1024;

  function num(value) {
    return (typeof value === 'number' && isFinite(value)) ? value : 0;
  }

  function oneDp(value) {
    return (Math.round(value * 10) / 10).toFixed(1);
  }

  /**
   * A file's size, the way Explorer's column reads it: one decimal, and never
   * a unit smaller than KB. Folders have no size, and neither does a stat the
   * chrome could not take — both answer ''.
   */
  function sizeLabel(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes === 0) return '0 KB';
    if (bytes < MB) return oneDp(bytes / KB) + ' KB';
    if (bytes < GB) return oneDp(bytes / MB) + ' MB';
    if (bytes < TB) return oneDp(bytes / GB) + ' GB';
    return oneDp(bytes / TB) + ' TB';
  }

  /**
   * A drive's size, which is a round number or it is noise: "931 GB", not
   * "930.8 GB". Only terabytes keep a decimal, because whole TB is too coarse.
   */
  function wholeLabel(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes >= TB) return oneDp(bytes / TB) + ' TB';
    if (bytes >= GB) return String(Math.round(bytes / GB)) + ' GB';
    if (bytes >= MB) return String(Math.round(bytes / MB)) + ' MB';
    return String(Math.round(bytes / KB)) + ' KB';
  }

  /** "412 GB free of 931 GB", or '' when the chrome had no numbers. */
  function freeLabel(freeBytes, totalBytes) {
    if (typeof freeBytes !== 'number' || !isFinite(freeBytes)) return '';
    if (typeof totalBytes !== 'number' || !isFinite(totalBytes) || totalBytes <= 0) return '';
    return wholeLabel(freeBytes) + ' free of ' + wholeLabel(totalBytes);
  }

  /** How much of a drive is used, 0..1, for the thin bar. */
  function usedFraction(freeBytes, totalBytes) {
    if (typeof freeBytes !== 'number' || !isFinite(freeBytes)) return 0;
    if (typeof totalBytes !== 'number' || !isFinite(totalBytes) || totalBytes <= 0) return 0;
    var used = 1 - (freeBytes / totalBytes);
    if (!(used > 0)) return 0;
    return used > 1 ? 1 : used;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * Modified, at three resolutions: today is a clock, this year drops the
   * year, anything older states it. `nowMs` is injectable so the harness does
   * not have to wait for midnight.
   */
  function timeLabel(ms, nowMs) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    var when = new Date(ms);
    if (isNaN(when.getTime())) return '';
    var now = new Date(typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now());

    if (when.getFullYear() === now.getFullYear()
      && when.getMonth() === now.getMonth()
      && when.getDate() === now.getDate()) {
      return pad2(when.getHours()) + ':' + pad2(when.getMinutes());
    }

    var stamp = when.getDate() + ' ' + MONTHS[when.getMonth()];
    if (when.getFullYear() === now.getFullYear()) return stamp;
    return stamp + ' ' + when.getFullYear();
  }

  /** 2000 -> "2,000". The only place this page needs a thousands separator. */
  function groupDigits(n) {
    var text = String(Math.round(num(n)));
    var out = '';
    var count = 0;
    for (var i = text.length - 1; i >= 0; i--) {
      out = text.charAt(i) + out;
      count++;
      if (count % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
  }

  /* --- pure: paths ----------------------------------------------- */

  /**
   * A Windows path as breadcrumbs: [{ label, path }], drive or share first.
   * The root (null, '', junk, a relative path) has no crumbs at all.
   */
  function splitCrumbs(path) {
    if (typeof path !== 'string' || !path) return [];
    var norm = path.replace(/\//g, '\\');
    var head = '';
    var rest = '';

    var unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(norm);
    if (unc) {
      head = '\\\\' + unc[1] + '\\' + unc[2];
      rest = norm.slice(unc[0].length);
    } else {
      var drive = /^([A-Za-z]:)/.exec(norm);
      if (!drive) return [];
      head = drive[1].toUpperCase();
      rest = norm.slice(2);
    }

    var out = [{ label: head, path: head + '\\' }];
    var parts = rest.split('\\');
    var acc = head;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      acc = acc + '\\' + parts[i];
      out.push({ label: parts[i], path: acc });
    }
    return out;
  }

  /**
   * The folder above this one, or null when there is none — a drive root's
   * parent is the places view, which is what null means everywhere here.
   */
  function parentOf(path) {
    var crumbs = splitCrumbs(path);
    if (crumbs.length < 2) return null;
    return crumbs[crumbs.length - 2].path;
  }

  /** The last segment of a path, for a name the chrome did not send. */
  function baseName(path) {
    var crumbs = splitCrumbs(path);
    if (!crumbs.length) return typeof path === 'string' ? path : '';
    return crumbs[crumbs.length - 1].label;
  }

  function isAbsolutePath(text) {
    if (typeof text !== 'string') return false;
    var s = text.trim();
    if (/^[A-Za-z]:[\\/]/.test(s)) return true;
    return /^\\\\[^\\]+\\[^\\]+/.test(s);
  }

  /**
   * What the user typed into the path bar, as something worth sending, or
   * null. Quotes (Explorer's own "Copy as path") and forward slashes are
   * forgiven; a bare drive letter grows its root slash; a relative path is
   * refused rather than guessed at, because the chrome would refuse it too.
   */
  function normalizeTyped(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim().replace(/^"+/, '').replace(/"+$/, '').trim();
    if (!s) return null;
    s = s.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(s)) s = s + '\\';
    if (!isAbsolutePath(s)) return null;
    if (s.length > 3) s = s.replace(/\\+$/, '');
    return s;
  }

  /* --- pure: the listing ----------------------------------------- */

  var COLLATOR = null;
  try {
    COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  } catch (err) {
    COLLATOR = null;
  }

  function byName(a, b) {
    if (COLLATOR) return COLLATOR.compare(a, b);
    var la = String(a).toLowerCase();
    var lb = String(b).toLowerCase();
    if (la < lb) return -1;
    return la > lb ? 1 : 0;
  }

  function nameOf(entry) {
    if (!entry) return '';
    if (typeof entry.name === 'string' && entry.name) return entry.name;
    return baseName(entry.path);
  }

  /**
   * Folders first in both directions — that is what a folder browser is —
   * then the clicked column. A tie inside a numeric column falls back to A-Z
   * whichever way the column points, so two 0-byte files never swap places on
   * a re-render.
   */
  function sortEntries(list, key, dir) {
    if (!Array.isArray(list)) return [];
    var k = (key === 'size' || key === 'mtime') ? key : 'name';
    var d = dir === 'desc' ? -1 : 1;
    var out = list.slice();

    out.sort(function (a, b) {
      var ad = (a && a.kind === 'dir') ? 0 : 1;
      var bd = (b && b.kind === 'dir') ? 0 : 1;
      if (ad !== bd) return ad - bd;

      var cmp;
      if (k === 'size') cmp = num(a && a.size) - num(b && b.size);
      else if (k === 'mtime') cmp = num(a && a.mtime) - num(b && b.mtime);
      else cmp = byName(nameOf(a), nameOf(b));

      if (cmp) return cmp * d;
      if (k === 'name') return 0;
      return byName(nameOf(a), nameOf(b));
    });

    return out;
  }

  /** Narrow by name, case-insensitively. An empty query is every entry. */
  function filterEntries(list, text) {
    if (!Array.isArray(list)) return [];
    var needle = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!needle) return list.slice();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (nameOf(list[i]).toLowerCase().indexOf(needle) >= 0) out.push(list[i]);
    }
    return out;
  }

  /* --- pure: icon batching --------------------------------------- */

  /**
   * The paths rows [start, end) still need an icon for: in order, no
   * duplicates, and nothing that has been asked for once already. Asking is
   * what costs — the chrome shells out to app.getFileIcon — so a re-render or
   * a scroll back up must not ask again.
   */
  function pendingIconPaths(list, start, end, already) {
    var out = [];
    if (!Array.isArray(list)) return out;
    var from = Math.max(0, Math.floor(num(start)));
    var to = Math.min(list.length, Math.floor(num(end)));
    var seen = {};
    for (var i = from; i < to; i++) {
      var path = list[i] && list[i].path;
      if (typeof path !== 'string' || !path) continue;
      if (already && already[path]) continue;
      if (seen[path]) continue;
      seen[path] = true;
      out.push(path);
    }
    return out;
  }

  /** One ask, as console lines: the contract caps a line at 64 paths. */
  function chunk(list, size) {
    var step = (typeof size === 'number' && size > 0) ? Math.floor(size) : 1;
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
    return out;
  }

  /** Which rows the scroller is showing, plus a little lookahead. */
  function visibleRange(scrollTop, height, rowHeight, count, ahead) {
    var h = num(rowHeight) > 0 ? num(rowHeight) : ROW_H;
    var total = Math.max(0, Math.floor(num(count)));
    var first = Math.floor(num(scrollTop) / h);
    var last = Math.ceil((num(scrollTop) + num(height)) / h) + Math.max(0, Math.floor(num(ahead)));
    if (first < 0) first = 0;
    if (first > total) first = total;
    if (last > total) last = total;
    if (last < first) last = first;
    return { start: first, end: last };
  }

  /* --- pure: storage --------------------------------------------- */

  function readStore(key) {
    try {
      var value = window.localStorage.getItem(key);
      return typeof value === 'string' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** The persisted sort, or the authored default. Never throws, never null. */
  function readSort() {
    var raw = readStore(SORT_KEY);
    var msg = null;
    try { msg = raw ? JSON.parse(raw) : null; } catch (err) { msg = null; }
    var key = msg && msg.key;
    var dir = msg && msg.dir;
    return {
      key: (key === 'size' || key === 'mtime') ? key : 'name',
      dir: dir === 'desc' ? 'desc' : 'asc'
    };
  }

  function writeSort(state) {
    var payload = '';
    try {
      payload = JSON.stringify({
        key: state && state.key === 'size' ? 'size'
          : (state && state.key === 'mtime' ? 'mtime' : 'name'),
        dir: state && state.dir === 'desc' ? 'desc' : 'asc'
      });
    } catch (err) { return false; }
    return writeStore(SORT_KEY, payload);
  }

  /** The folder to open on boot: last session's, when it still looks like one. */
  function readLast() {
    return normalizeTyped(readStore(LAST_KEY));
  }

  /**
   * The folder the chrome opened this tab on (filesUrl(path) puts it in
   * ?path=), or null. Read once at boot and then taken OUT of the address with
   * replaceState: the URL is what a reload and a restored session reopen, and
   * by then the folder on screen (files.last) is the one that should come back,
   * not the one the tab happened to be opened on.
   */
  function readUrlPath() {
    var found = null;
    try {
      var url = new URL(window.location.href);
      var raw = url.searchParams.get('path');
      if (raw === null) return null;
      found = normalizeTyped(raw);
      url.searchParams.delete('path');
      window.history.replaceState(window.history.state, '', url.href);
    } catch (err) { /* an odd address: the remembered folder still opens */ }
    return found;
  }

  function writeLast(path) {
    if (typeof path !== 'string' || !path) return false;
    return writeStore(LAST_KEY, path);
  }

  function forgetLast() {
    try { window.localStorage.removeItem(LAST_KEY); return true; } catch (err) { return false; }
  }

  /* --- talking back to the chrome -------------------------------- */

  /** One console line, or null when the payload will not serialise. */
  function buildLine(verb, payload) {
    var body = '';
    try { body = JSON.stringify(payload); } catch (err) { return null; }
    return PREFIX + verb + ' ' + body;
  }

  function send(verb, payload) {
    var text = buildLine(verb, payload);
    if (text === null) return false;
    try { console.log(text); return true; } catch (err) { return false; }
  }

  function askList(path) {
    pending = (typeof path === 'string' && path) ? path : null;
    send('list', { path: pending });
  }

  /**
   * Ask for the icons rows [start, end) are missing, as however many lines
   * the 64-per-line cap needs. Marks them asked first: a second scroll in the
   * same direction must not re-ask while the first answer is in flight.
   */
  function askIcons(start, end) {
    var want = pendingIconPaths(view, start, end, asked);
    if (!want.length) return 0;
    for (var i = 0; i < want.length; i++) asked[want[i]] = true;
    var lines = chunk(want, ICON_LINE);
    for (var j = 0; j < lines.length; j++) send('icons', { paths: lines[j] });
    return lines.length;
  }

  /* --- glyphs ---------------------------------------------------- */

  /* A folder outline and a page outline, hairline, no fill, in the quietest
     foreground: what a row wears until its real icon lands, and what it keeps
     when there is no real icon to have. Right in both themes because --fg-3
     is defined in both. */
  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function glyphFor(kind) {
    var svg = svgEl('svg', {
      'class': 'files-glyph',
      viewBox: '0 0 16 16',
      width: '16',
      height: '16',
      'aria-hidden': 'true',
      focusable: 'false'
    });

    if (kind === 'dir') {
      svg.appendChild(svgEl('path', {
        d: 'M1.5 4.5h4l1.5 2h7.5v7h-13z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1',
        'stroke-linejoin': 'round'
      }));
    } else {
      svg.appendChild(svgEl('path', {
        d: 'M3.5 1.5h6l3 3v10h-9z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1',
        'stroke-linejoin': 'round'
      }));
      svg.appendChild(svgEl('path', {
        d: 'M9.5 1.5v3h3',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1',
        'stroke-linejoin': 'round'
      }));
    }

    return svg;
  }

  /* --- the path bar ---------------------------------------------- */

  function renderCrumbs() {
    var box = el.crumbs;
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    var crumbs = splitCrumbs(cwd);
    if (!crumbs.length) {
      var root = document.createElement('span');
      root.className = 'crumb is-root';
      root.textContent = 'This PC';
      box.appendChild(root);
      return;
    }

    for (var i = 0; i < crumbs.length; i++) {
      if (i) {
        var sep = document.createElement('span');
        sep.className = 'crumbsep';
        sep.textContent = '\u203A';
        sep.setAttribute('aria-hidden', 'true');
        box.appendChild(sep);
      }
      var btn = document.createElement('button');
      btn.className = 'crumb';
      btn.type = 'button';
      btn.textContent = crumbs[i].label;
      btn.setAttribute('data-path', crumbs[i].path);
      if (i === crumbs.length - 1) btn.className = 'crumb is-here';
      box.appendChild(btn);
    }
  }

  function startEdit() {
    if (!el.pathinput || !el.crumbs) return;
    editing = true;
    el.pathinput.value = typeof cwd === 'string' ? cwd : '';
    el.crumbs.hidden = true;
    el.pathinput.hidden = false;
    el.pathinput.focus();
    el.pathinput.select();
  }

  function stopEdit() {
    if (!el.pathinput || !el.crumbs) return;
    editing = false;
    el.pathinput.hidden = true;
    el.crumbs.hidden = false;
  }

  /* --- the rail -------------------------------------------------- */

  function railButton(name, path, extraClass) {
    var btn = document.createElement('button');
    btn.className = 'railitem' + (extraClass ? ' ' + extraClass : '');
    btn.type = 'button';
    btn.setAttribute('data-path', path);
    if (samePath(path, cwd)) {
      btn.className += ' is-cur';
      btn.setAttribute('aria-current', 'true');
    }

    var label = document.createElement('span');
    label.className = 'railname';
    label.textContent = name;
    btn.appendChild(label);
    return btn;
  }

  function renderRail() {
    var box = el.places;
    var i;
    if (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      for (i = 0; i < places.length; i++) {
        if (!places[i] || typeof places[i].path !== 'string') continue;
        box.appendChild(railButton(String(places[i].name || baseName(places[i].path)),
          places[i].path, ''));
      }
    }

    var dbox = el.drives;
    if (!dbox) return;
    while (dbox.firstChild) dbox.removeChild(dbox.firstChild);

    for (i = 0; i < drives.length; i++) {
      var drive = drives[i];
      if (!drive || typeof drive.path !== 'string') continue;

      var name = drive.label ? (String(drive.label) + ' (' + String(drive.name || baseName(drive.path)) + ')')
        : String(drive.name || baseName(drive.path));
      var btn = railButton(name, drive.path, 'raildrive');

      var text = freeLabel(drive.freeBytes, drive.totalBytes);
      if (text) {
        var bar = document.createElement('span');
        bar.className = 'freebar';
        var fill = document.createElement('span');
        fill.className = 'freefill';
        fill.style.width = (Math.round(usedFraction(drive.freeBytes, drive.totalBytes) * 1000) / 10) + '%';
        bar.appendChild(fill);
        btn.appendChild(bar);

        var note = document.createElement('span');
        note.className = 'freetext';
        note.textContent = text;
        btn.appendChild(note);
      }

      dbox.appendChild(btn);
    }
  }

  function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase();
  }

  /* --- the listing ----------------------------------------------- */

  function buildRow(entry, index) {
    var row = document.createElement('div');
    row.className = 'row';
    row.id = 'files-row-' + index;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('data-index', String(index));

    var nameCell = document.createElement('span');
    nameCell.className = 'cell cell-name';

    var slot = document.createElement('span');
    slot.className = 'iconslot';
    var url = icons[entry.path];
    if (typeof url === 'string' && url.indexOf('data:') === 0) {
      slot.appendChild(iconImg(url));
      painted[entry.path] = true;
    } else {
      slot.appendChild(glyphFor(entry.kind));
    }
    nameCell.appendChild(slot);

    var text = document.createElement('span');
    text.className = 'rowname';
    text.textContent = nameOf(entry);
    nameCell.appendChild(text);
    row.appendChild(nameCell);

    var size = document.createElement('span');
    size.className = 'cell cell-size';
    size.textContent = entry.kind === 'dir' ? '' : sizeLabel(entry.size);
    row.appendChild(size);

    var when = document.createElement('span');
    when.className = 'cell cell-mtime';
    when.textContent = timeLabel(entry.mtime);
    row.appendChild(when);

    return row;
  }

  function iconImg(url) {
    var img = document.createElement('img');
    img.className = 'rowicon';
    img.width = 16;
    img.height = 16;
    img.alt = '';
    img.draggable = false;
    img.src = url;
    return img;
  }

  function renderRows() {
    var box = el.rows;
    if (!box) return;

    while (box.firstChild) box.removeChild(box.firstChild);
    rowEls = [];

    for (var i = 0; i < view.length; i++) {
      var row = buildRow(view[i], i);
      rowEls.push(row);
      box.appendChild(row);
    }

    if (truncated && view.length) {
      var note = document.createElement('div');
      note.className = 'row is-note';
      note.textContent = 'Showing the first ' + groupDigits(2000) + ' items';
      box.appendChild(note);
    }

    paintSelection();
  }

  function paintSelection() {
    for (var i = 0; i < rowEls.length; i++) {
      var on = i === sel;
      if (on) rowEls[i].className = 'row is-sel';
      else rowEls[i].className = 'row';
      rowEls[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (el.rows) {
      if (sel >= 0 && rowEls[sel]) el.rows.setAttribute('aria-activedescendant', rowEls[sel].id);
      else el.rows.removeAttribute('aria-activedescendant');
    }
  }

  function renderCols() {
    if (!el.cols) return;
    for (var i = 0; i < el.cols.length; i++) {
      var btn = el.cols[i];
      var key = btn.getAttribute('data-sort');
      var on = key === sort.key;
      btn.className = 'col sortbtn col-' + key + (on ? ' is-active' : '')
        + (on && sort.dir === 'desc' ? ' is-desc' : '');
      btn.setAttribute('aria-sort', on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    }
  }

  function renderBlank() {
    if (!el.blank || !el.blankmsg || !el.blankup) return;

    var message = '';
    if (error) {
      message = (typeof ERRORS[error] === 'string') ? ERRORS[error] : String(error);
    } else if (!entries.length) {
      message = (cwd === null) ? 'Pick a place or a drive' : 'Nothing here';
    } else if (!view.length) {
      message = 'Nothing matches ' + query;
    }

    el.blank.hidden = !message;
    el.blankmsg.textContent = message;
    el.blankup.hidden = !(error && cwd !== null);
  }

  function render() {
    if (!ready) return;
    view = sortEntries(filterEntries(entries, query), sort.key, sort.dir);
    if (sel >= view.length) sel = view.length ? view.length - 1 : -1;
    renderCrumbs();
    renderCols();
    renderRows();
    renderBlank();
    renderRail();
    if (el.up) el.up.disabled = (cwd === null);
    askIcons(0, Math.min(view.length, ICON_FIRST));
  }

  /* --- navigation ------------------------------------------------ */

  function navigate(path) {
    closeMenu();
    query = '';
    if (el.filter) el.filter.value = '';
    sel = -1;
    askList(path);
  }

  function goUp() {
    if (cwd === null) return;
    navigate(parentPath !== null ? parentPath : parentOf(cwd));
  }

  function openEntry(entry) {
    if (!entry || typeof entry.path !== 'string') return;
    if (entry.kind === 'dir') {
      navigate(entry.path);
      return;
    }
    send('open', { path: entry.path });
  }

  function selectRow(index, scroll) {
    if (index < 0 || index >= view.length) return;
    sel = index;
    paintSelection();
    if (scroll && rowEls[sel] && rowEls[sel].scrollIntoView) {
      try { rowEls[sel].scrollIntoView({ block: 'nearest' }); } catch (err) { /* older shim */ }
    }
  }

  /* --- the inline menu ------------------------------------------- */

  function openMenu(entry, x, y) {
    if (!el.menu || !entry) return;
    menuFor = entry;
    el.menu.hidden = false;
    var w = el.menu.offsetWidth || 176;
    var h = el.menu.offsetHeight || 100;
    var maxX = (window.innerWidth || 0) - w - 8;
    var maxY = (window.innerHeight || 0) - h - 8;
    el.menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    el.menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }

  function closeMenu() {
    menuFor = null;
    if (el.menu) el.menu.hidden = true;
  }

  function runMenu(action) {
    var entry = menuFor;
    closeMenu();
    if (!entry) return;
    if (action === 'open') openEntry(entry);
    else if (action === 'reveal') send('reveal', { path: entry.path });
    else if (action === 'copy') send('copy-path', { path: entry.path });
  }

  /* --- the inline result note ------------------------------------ */

  var RESULT_OK = {
    'copy-path': 'Path copied',
    reveal: 'Shown in Explorer'
  };

  var RESULT_BAD = {
    open: 'Windows could not open that',
    reveal: 'Windows could not show that',
    'copy-path': 'Could not copy that path'
  };

  function setStatus(text) {
    if (!el.status) return;
    el.status.textContent = text || '';
    if (statusTimer) { window.clearTimeout(statusTimer); statusTimer = null; }
    if (!text) return;
    statusTimer = window.setTimeout(function () {
      statusTimer = null;
      if (el.status) el.status.textContent = '';
    }, STATUS_MS);
  }

  /* --- pushes from the chrome ------------------------------------ */

  function applyFiles(msg) {
    if (!msg || typeof msg !== 'object') return;

    var path = (typeof msg.path === 'string' && msg.path) ? msg.path : null;
    var nextError = null;
    if (typeof msg.error === 'string' && msg.error) nextError = msg.error;

    // A pushed answer for a folder we are no longer asking about is stale,
    // except at boot, where `pending` is whatever we asked for first.
    if (pending !== null && path !== null && !samePath(path, pending) && !nextError) {
      // A chrome-initiated refresh of the folder on screen is not stale.
      if (!samePath(path, cwd)) return;
    }

    cwd = path;
    error = nextError;
    parentPath = (typeof msg.parent === 'string' && msg.parent) ? msg.parent : parentOf(path);
    truncated = !!msg.truncated;
    entries = [];
    icons = {};
    asked = {};
    painted = {};
    sel = -1;
    pending = null;

    if (Array.isArray(msg.entries)) {
      for (var i = 0; i < msg.entries.length; i++) {
        var raw = msg.entries[i];
        if (!raw || typeof raw !== 'object') continue;
        if (typeof raw.path !== 'string' || !raw.path) continue;
        entries.push({
          name: typeof raw.name === 'string' ? raw.name : baseName(raw.path),
          path: raw.path,
          kind: raw.kind === 'dir' ? 'dir' : 'file',
          size: (typeof raw.size === 'number' && isFinite(raw.size)) ? raw.size : null,
          mtime: (typeof raw.mtime === 'number' && isFinite(raw.mtime)) ? raw.mtime : null,
          ext: typeof raw.ext === 'string' ? raw.ext : ''
        });
      }
    }

    // A folder that answered is worth coming back to; one that is gone must
    // not be tried again on the next boot.
    if (!error && cwd !== null) writeLast(cwd);
    if (error === 'not-found') forgetLast();

    render();
  }

  function applyFilePlaces(msg) {
    if (!msg || typeof msg !== 'object') return;

    places = [];
    drives = [];
    var i;

    if (Array.isArray(msg.places)) {
      for (i = 0; i < msg.places.length; i++) {
        var place = msg.places[i];
        if (!place || typeof place.path !== 'string' || !place.path) continue;
        places.push({ name: String(place.name || baseName(place.path)), path: place.path });
      }
    }

    if (Array.isArray(msg.drives)) {
      for (i = 0; i < msg.drives.length; i++) {
        var drive = msg.drives[i];
        if (!drive || typeof drive.path !== 'string' || !drive.path) continue;
        drives.push({
          name: String(drive.name || baseName(drive.path)),
          path: drive.path,
          label: typeof drive.label === 'string' ? drive.label : '',
          freeBytes: (typeof drive.freeBytes === 'number' && isFinite(drive.freeBytes)) ? drive.freeBytes : null,
          totalBytes: (typeof drive.totalBytes === 'number' && isFinite(drive.totalBytes)) ? drive.totalBytes : null
        });
      }
    }

    if (ready) renderRail();
  }

  /**
   * 16px icons, as data URLs. An <img src> is set once per path and never
   * again: a re-render reads `icons` and a late answer patches the row in
   * place, so scrolling back over a folder costs nothing.
   */
  function applyFileIcons(map) {
    if (!map || typeof map !== 'object') return;
    for (var path in map) {
      if (!Object.prototype.hasOwnProperty.call(map, path)) continue;
      var url = map[path];
      icons[path] = (typeof url === 'string' && url.indexOf('data:') === 0) ? url : null;
      asked[path] = true;
    }
    if (ready) patchIcons();
  }

  function patchIcons() {
    for (var i = 0; i < rowEls.length; i++) {
      var entry = view[i];
      if (!entry) continue;
      if (painted[entry.path]) continue;
      var url = icons[entry.path];
      if (typeof url !== 'string') continue;
      var slot = rowEls[i].firstChild && rowEls[i].firstChild.firstChild;
      if (!slot) continue;
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      slot.appendChild(iconImg(url));
      painted[entry.path] = true;
    }
  }

  function applyFileResult(res) {
    if (!res || typeof res !== 'object') return;
    var action = typeof res.action === 'string' ? res.action : '';
    if (res.ok) {
      setStatus(RESULT_OK[action] || '');
      return;
    }
    var reason = (typeof res.reason === 'string' && res.reason) ? res.reason : '';
    setStatus(RESULT_BAD[action] || reason || 'That did not work');
  }

  window.__applyFiles = applyFiles;
  window.__applyFilePlaces = applyFilePlaces;
  window.__applyFileIcons = applyFileIcons;
  window.__applyFileResult = applyFileResult;

  /* --- wiring ---------------------------------------------------- */

  function rowIndexFrom(node) {
    var at = node;
    while (at && at !== el.rows) {
      if (at.className === 'row' || at.className === 'row is-sel') {
        var index = parseInt(at.getAttribute('data-index'), 10);
        return isNaN(index) ? -1 : index;
      }
      at = at.parentNode;
    }
    return -1;
  }

  function onRowsClick(event) {
    var index = rowIndexFrom(event.target);
    if (index < 0) return;
    closeMenu();
    selectRow(index, false);
  }

  function onRowsDblClick(event) {
    var index = rowIndexFrom(event.target);
    if (index < 0) return;
    selectRow(index, false);
    openEntry(view[index]);
  }

  function onRowsContext(event) {
    var index = rowIndexFrom(event.target);
    if (index < 0) { closeMenu(); return; }
    event.preventDefault();
    selectRow(index, false);
    openMenu(view[index], event.clientX, event.clientY);
  }

  /* Every key this handles is stopped here as well as prevented: the
     document-level handler owns Backspace for the rest of the page, and an
     unstopped one would go up twice — two files:list lines for one press. */
  function onRowsKey(event) {
    var key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End'
      || key === 'Enter' || key === 'Backspace') {
      event.stopPropagation();
    }

    if (key === 'ArrowDown') {
      event.preventDefault();
      selectRow(sel < 0 ? 0 : Math.min(sel + 1, view.length - 1), true);
    } else if (key === 'ArrowUp') {
      event.preventDefault();
      selectRow(sel <= 0 ? 0 : sel - 1, true);
    } else if (key === 'Home') {
      event.preventDefault();
      selectRow(0, true);
    } else if (key === 'End') {
      event.preventDefault();
      selectRow(view.length - 1, true);
    } else if (key === 'Enter') {
      event.preventDefault();
      if (sel >= 0) openEntry(view[sel]);
    } else if (key === 'Backspace') {
      event.preventDefault();
      goUp();
    }
  }

  function onRowsScroll() {
    if (!el.rows) return;
    var span = visibleRange(el.rows.scrollTop, el.rows.clientHeight, ROW_H, view.length, ICON_AHEAD);
    askIcons(span.start, span.end);
  }

  function onFilterInput() {
    if (filterTimer) window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(function () {
      filterTimer = null;
      query = el.filter ? el.filter.value : '';
      sel = -1;
      render();
    }, FILTER_DEBOUNCE);
  }

  function onSortClick(event) {
    var key = event.currentTarget.getAttribute('data-sort');
    if (key !== 'name' && key !== 'size' && key !== 'mtime') return;
    if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    else sort = { key: key, dir: 'asc' };
    writeSort(sort);
    render();
  }

  /* A crumb navigates; anything else in the box — the chevrons between them,
     the empty area past the last one — means "let me type a path". */
  function onPathbarClick(event) {
    var target = event.target;
    var path = target && target.getAttribute ? target.getAttribute('data-path') : null;
    if (path) { navigate(path); return; }
    if (!editing) startEdit();
  }

  function onPathKey(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      var path = normalizeTyped(el.pathinput.value);
      stopEdit();
      if (path) navigate(path);
      else setStatus('That is not a folder path');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      stopEdit();
      if (el.rows) el.rows.focus();
    }
  }

  function onDocKey(event) {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      startEdit();
      return;
    }
    if (event.key === 'Escape') {
      if (menuFor) { closeMenu(); return; }
      if (editing) { stopEdit(); return; }
    }
    // Backspace anywhere that is not a field goes up, the way Explorer does.
    if (event.key === 'Backspace' && !editing) {
      var tag = event.target && event.target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        event.preventDefault();
        goUp();
      }
    }
  }

  function onDocPointerDown(event) {
    if (!menuFor) return;
    var at = event.target;
    while (at) {
      if (at === el.menu) return;
      at = at.parentNode;
    }
    closeMenu();
  }

  function onRailClick(event) {
    var at = event.target;
    while (at && at !== el.places && at !== el.drives) {
      var path = at.getAttribute && at.getAttribute('data-path');
      if (path) { navigate(path); return; }
      at = at.parentNode;
    }
  }

  /* --- boot ------------------------------------------------------ */

  function boot() {
    if (ready) return;

    el.up = document.getElementById('up');
    el.pathbar = document.getElementById('pathbar');
    el.crumbs = document.getElementById('crumbs');
    el.pathinput = document.getElementById('pathinput');
    el.filter = document.getElementById('filter');
    el.status = document.getElementById('status');
    el.places = document.getElementById('places');
    el.drives = document.getElementById('drives');
    el.rows = document.getElementById('rows');
    el.blank = document.getElementById('blank');
    el.blankmsg = document.getElementById('blankmsg');
    el.blankup = document.getElementById('blankup');
    el.menu = document.getElementById('menu');
    el.cols = document.querySelectorAll('.sortbtn');

    var i;
    for (i = 0; i < el.cols.length; i++) {
      el.cols[i].addEventListener('click', onSortClick);
    }

    if (el.rows) {
      el.rows.addEventListener('click', onRowsClick);
      el.rows.addEventListener('dblclick', onRowsDblClick);
      el.rows.addEventListener('contextmenu', onRowsContext);
      el.rows.addEventListener('keydown', onRowsKey);
      el.rows.addEventListener('scroll', onRowsScroll);
    }
    if (el.filter) el.filter.addEventListener('input', onFilterInput);
    if (el.pathbar) el.pathbar.addEventListener('click', onPathbarClick);
    if (el.pathinput) {
      el.pathinput.addEventListener('keydown', onPathKey);
      el.pathinput.addEventListener('blur', function () { if (editing) stopEdit(); });
    }
    if (el.up) el.up.addEventListener('click', goUp);
    if (el.blankup) el.blankup.addEventListener('click', goUp);
    if (el.places) el.places.addEventListener('click', onRailClick);
    if (el.drives) el.drives.addEventListener('click', onRailClick);
    if (el.menu) {
      var opts = el.menu.querySelectorAll('.menuopt');
      for (i = 0; i < opts.length; i++) {
        opts[i].addEventListener('click', function (event) {
          runMenu(event.currentTarget.getAttribute('data-act'));
        });
      }
    }

    document.addEventListener('keydown', onDocKey);
    document.addEventListener('mousedown', onDocPointerDown);
    window.addEventListener('blur', closeMenu);

    sort = readSort();
    ready = true;

    // Whatever the chrome pushed before the document was up paints now.
    render();

    // One ask, either way: the folder in the URL (filesUrl(path)), else last
    // session's folder when it still looks like a path, the root otherwise.
    // The chrome answers not-found if it is gone, and pushes the places
    // alongside it. The URL is read even when a push got here first, so it
    // never lingers in the address for a reload to reopen.
    var urlPath = readUrlPath();
    if (cwd === null && !entries.length) askList(urlPath || readLast());

    if (el.rows) el.rows.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* --- the test surface ------------------------------------------ */

  /* Read-only, and nothing on the page goes through it: it exists so the
     pure half can be driven under plain node with a DOM shim, with no
     Electron and no window. */
  window.__filesInternals = {
    sizeLabel: sizeLabel,
    wholeLabel: wholeLabel,
    freeLabel: freeLabel,
    usedFraction: usedFraction,
    timeLabel: timeLabel,
    groupDigits: groupDigits,
    splitCrumbs: splitCrumbs,
    parentOf: parentOf,
    baseName: baseName,
    isAbsolutePath: isAbsolutePath,
    normalizeTyped: normalizeTyped,
    sortEntries: sortEntries,
    filterEntries: filterEntries,
    pendingIconPaths: pendingIconPaths,
    chunk: chunk,
    visibleRange: visibleRange,
    readStore: readStore,
    writeStore: writeStore,
    readSort: readSort,
    writeSort: writeSort,
    readLast: readLast,
    writeLast: writeLast,
    buildLine: buildLine,
    samePath: samePath,
    ICON_FIRST: ICON_FIRST,
    ICON_LINE: ICON_LINE,
    ICON_AHEAD: ICON_AHEAD,
    ROW_H: ROW_H,
    ERRORS: ERRORS
  };
})();
