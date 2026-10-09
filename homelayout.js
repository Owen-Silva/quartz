/* ============================================================
   homelayout.js — the new tab Home's layout rules, in one place.

   The Home is ten pieces in three columns (left rail, centre column,
   right rail). Each piece can be hidden and put back, and dragged to a
   new place in any column; the result is ONE stored setting:

     homeLayout: {
       v: 1,
       columns: { left: [ids], centre: [ids], right: [ids] },
       hidden:  [ids]
     }

   or null, which means "the default" (today's arrangement, exactly).

   Hidden pieces KEEP their place in a column. That is what lets a piece
   switched off in Settings come back where it was, rather than at the end
   of some column: `hidden` is a flag over the order, not a second list.

   WHY THIS FILE IS SHARED. Two documents need the same rules: the chrome
   (settings.js stores the layout, app.js answers the page and gates each
   piece's feed) and the new tab page (it draws the layout, and applies its
   own edits at once while the chrome confirms them). The page is a
   preload-less file:// guest and the chrome is another document, so the
   only way to keep one set of rules is one plain script that both load.
   It defines window.HomeLayout and nothing else, needs no DOM, and is also
   require()-able from Node for the harness.

   NEVER TRUST THE INPUT. sanitize() turns anything at all — a stored value
   from an older or newer build, a hand-edited file, a page's request — into
   a complete layout: unknown ids are dropped, duplicates keep their first
   place, and any piece this build has that the value does not mention is
   appended to its default column (so a piece added in a later build simply
   appears). parseOp() is the same for one page request.
   ============================================================ */

(function (root) {
  'use strict';

  var VERSION = 1;

  /* The three columns, left to right. 'centre' is the middle column. */
  var COLUMNS = ['left', 'centre', 'right'];

  /*
   * Every piece, in default order. `column` is where it lives by default;
   * `kind` is how it is drawn away from home: a 'card' (a rail tile with a
   * fixed width) or 'wide' (fills whatever column it is in, like the centre
   * column's rows). `label` is what the Edit tray and Settings call it;
   * `hint` is the one line Settings adds under the switch.
   */
  var PIECES = [
    { id: 'clock',   column: 'left',   kind: 'card', label: 'Clock',
      hint: 'The time and the date' },
    { id: 'media',   column: 'left',   kind: 'card', label: 'Now playing',
      hint: 'What this computer is playing, with its controls' },
    { id: 'logo',    column: 'centre', kind: 'wide', label: 'Quartz logo',
      hint: 'The Q over the search box' },
    { id: 'search',  column: 'centre', kind: 'wide', label: 'Search box',
      hint: 'The address bar still takes the caret on a new tab' },
    { id: 'saved',   column: 'centre', kind: 'wide', label: 'Saved',
      hint: 'Your saved sites' },
    { id: 'links',   column: 'centre', kind: 'wide', label: 'Shortcuts',
      hint: 'The shortcut chips' },
    { id: 'stats',   column: 'centre', kind: 'wide', label: 'System stats',
      hint: 'CPU, memory, disk, network, GPU and processes' },
    { id: 'apps',    column: 'centre', kind: 'wide', label: 'Apps',
      hint: 'The app dock' },
    { id: 'session', column: 'right',  kind: 'card', label: 'Session',
      hint: 'Tabs open, Spotify auto-pause and idle music' },
    { id: 'markets', column: 'right',  kind: 'card', label: 'Markets',
      hint: 'Live prices' }
  ];

  var BY_ID = Object.create(null);
  PIECES.forEach(function (p, i) { BY_ID[p.id] = { piece: p, rank: i }; });

  function isPiece(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
  }

  function isColumn(name) {
    return typeof name === 'string' && COLUMNS.indexOf(name) >= 0;
  }

  /** The default layout, as a fresh object every time (callers may mutate). */
  function defaults() {
    var columns = { left: [], centre: [], right: [] };
    PIECES.forEach(function (p) { columns[p.column].push(p.id); });
    return { v: VERSION, columns: columns, hidden: [] };
  }

  /**
   * Anything -> a complete layout. Pure; never throws; never returns the
   * object it was given (or anything inside it).
   */
  function sanitize(value) {
    var out = { v: VERSION, columns: { left: [], centre: [], right: [] }, hidden: [] };
    var src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
    var cols = src && src.columns && typeof src.columns === 'object' && !Array.isArray(src.columns)
      ? src.columns : null;
    if (!cols) return defaults();

    var seen = Object.create(null);
    COLUMNS.forEach(function (name) {
      var list = Array.isArray(cols[name]) ? cols[name] : [];
      for (var i = 0; i < list.length && i < 64; i++) {
        var id = list[i];
        if (!isPiece(id) || seen[id]) continue;
        seen[id] = true;
        out.columns[name].push(id);
      }
    });

    // A piece the value never mentions goes to the end of its own column:
    // that is how a piece added by a later build appears for someone who
    // has already customised the page.
    PIECES.forEach(function (p) {
      if (!seen[p.id]) out.columns[p.column].push(p.id);
    });

    var hidden = Array.isArray(src.hidden) ? src.hidden : [];
    var off = Object.create(null);
    for (var j = 0; j < hidden.length && j < 64; j++) {
      if (isPiece(hidden[j])) off[hidden[j]] = true;
    }
    // Stored in PIECES order, so two equal layouts are equal as strings.
    PIECES.forEach(function (p) { if (off[p.id]) out.hidden.push(p.id); });
    return out;
  }

  /** Byte-for-byte equality of two layouts after sanitising both. */
  function same(a, b) {
    return JSON.stringify(sanitize(a)) === JSON.stringify(sanitize(b));
  }

  function isDefault(layout) {
    return same(layout, defaults());
  }

  function isHidden(layout, id) {
    return sanitize(layout).hidden.indexOf(id) >= 0;
  }

  /** The column a piece is in ('left' | 'centre' | 'right'). */
  function columnOf(layout, id) {
    var l = sanitize(layout);
    for (var i = 0; i < COLUMNS.length; i++) {
      if (l.columns[COLUMNS[i]].indexOf(id) >= 0) return COLUMNS[i];
    }
    return isPiece(id) ? BY_ID[id].piece.column : null;
  }

  /**
   * One request, validated. Returns a clean op or null. The shapes:
   *   { op: 'hide', id }
   *   { op: 'show', id }
   *   { op: 'move', id, column, before: id|null, show?: true }
   *   { op: 'reset' }
   * `before` names the piece to land in front of; null (or a piece that is
   * not in that column) means the end of the column. Naming a piece rather
   * than an index is deliberate: the page counts only what it can see, the
   * store also holds hidden pieces, and a name means the same thing to both.
   */
  function parseOp(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var op = raw.op;
    if (op === 'reset') return { op: 'reset' };
    if (op !== 'hide' && op !== 'show' && op !== 'move') return null;
    if (!isPiece(raw.id)) return null;
    if (op !== 'move') return { op: op, id: raw.id };
    if (!isColumn(raw.column)) return null;
    var before = isPiece(raw.before) && raw.before !== raw.id ? raw.before : null;
    var out = { op: 'move', id: raw.id, column: raw.column, before: before };
    if (raw.show === true) out.show = true;
    return out;
  }

  /**
   * Apply one op to a layout. Returns { ok, layout, reason }: layout is
   * always complete (the input, sanitised, when the op was refused), and
   * every refusal says why in words a person can read.
   */
  function apply(layout, rawOp) {
    var base = sanitize(layout);
    var op = parseOp(rawOp);
    if (!op) return { ok: false, layout: base, reason: 'That change was not understood' };
    if (op.op === 'reset') return { ok: true, layout: defaults(), reason: '' };

    var next = sanitize(base);   // a copy to edit
    var hiddenAt = next.hidden.indexOf(op.id);

    if (op.op === 'hide') {
      if (hiddenAt < 0) next.hidden.push(op.id);
      return { ok: true, layout: sanitize(next), reason: '' };   // back in PIECES order
    }
    if (op.op === 'show') {
      if (hiddenAt >= 0) next.hidden.splice(hiddenAt, 1);
      return { ok: true, layout: next, reason: '' };
    }

    // move: out of wherever it is, into the target in front of `before`.
    COLUMNS.forEach(function (name) {
      var at = next.columns[name].indexOf(op.id);
      if (at >= 0) next.columns[name].splice(at, 1);
    });
    var list = next.columns[op.column];
    var to = op.before ? list.indexOf(op.before) : -1;
    if (to < 0) list.push(op.id);
    else list.splice(to, 0, op.id);
    if (op.show && hiddenAt >= 0) next.hidden.splice(hiddenAt, 1);
    return { ok: true, layout: next, reason: '' };
  }

  /** The value to STORE: null for the default, so a reset follows future defaults. */
  function toStored(layout) {
    var l = sanitize(layout);
    return isDefault(l) ? null : l;
  }

  function label(id) {
    return isPiece(id) ? BY_ID[id].piece.label : '';
  }

  var api = {
    VERSION: VERSION,
    COLUMNS: COLUMNS.slice(),
    PIECES: PIECES.map(function (p) {
      return { id: p.id, column: p.column, kind: p.kind, label: p.label, hint: p.hint };
    }),
    isPiece: isPiece,
    isColumn: isColumn,
    defaults: defaults,
    sanitize: sanitize,
    same: same,
    isDefault: isDefault,
    isHidden: isHidden,
    columnOf: columnOf,
    parseOp: parseOp,
    apply: apply,
    toStored: toStored,
    label: label
  };

  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HomeLayout = api;
}(typeof window !== 'undefined' ? window : null));
