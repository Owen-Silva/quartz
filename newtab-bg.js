/* ============================================================
   newtab-bg.js — the board behind the field.

   "The search field is the processor." A top-down circuit board
   fills the page: a socket ring sits around the search capsule,
   traces leave it perpendicular to its sides, bend at 45 degrees
   the way real PCB traces do, and end at vias or at the pads of a
   few peripheral chips. Light packets run the traces and the via
   they reach blooms.

   Two layers, and neither one is redrawn per frame:

     canvas#board   the board itself, painted ONCE per layout.
                    Nothing animates on it, so its bitmap never has
                    to be re-uploaded. Canvas 2D is not accelerated
                    in this guest, and any change to a full-screen
                    bitmap costs a whole-canvas commit.
     div#board-live packets and blooms as DOM elements on CSS motion
                    paths, driven by the Web Animations API. The
                    compositor moves them; script does no per-frame
                    work at all and there is no rAF draw loop.

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no require, no modules. The styles for
   the live layer are injected from here so this file stays the only
   thing that owns the effect.
   ============================================================ */

'use strict';

(function () {

  /* The chrome calls window.__boardPaused() whenever an overlay with a
     backdrop-filter opens over this page, and it must not have to care
     whether the board ever started. Stand the API up as a no-op first;
     the real one replaces it at the bottom of this file. */
  window.__boardPaused = function () {};
  window.__boardState = function () {
    return { running: false, paused: false, hidden: !!document.hidden, mode: 'none' };
  };

  const canvas = document.getElementById('board');
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* --- the board's measurements ------------------------------- */
  const CELL = 22;              // grid pitch in CSS px; every vertex sits on it
  const SOCKET_INFLATE = 36;    // the ring stands this far off the capsule
  const SOCKET_RADIUS = 14;
  const EXCLUSION_CELLS = 4;    // no chips this close to the socket
  const PAD_STEP = 2;           // a socket pad every 2 cells
  const TRACE_MIN_CELLS = 8;
  const TRACE_MAX_CELLS = 40;
  const SEG_MIN_CELLS = 3;      // cells run before a bend is considered
  const SEG_MAX_CELLS = 10;
  const BEND_GAP_CELLS = 2;     // cells between one 45 degree step and the next

  /* --- packets and blooms ------------------------------------- */
  const MAX_PACKETS = 16;
  const SPAWN_MIN_MS = 320;
  const SPAWN_MAX_MS = 520;
  const SPEED_MIN = 140;        // px/s
  const SPEED_MAX = 220;
  const TAIL_PX = 44;
  const VIOLET_SHARE = 0.15;
  const FORWARD_SHARE = 0.7;
  const BLOOM_MS = 420;

  /* 8-direction movement, clockwise from north. A bend is +-1. */
  const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* One seed per page load: a resize regenerates the same board
     rather than reshuffling it under the user. */
  const SEED = (Math.random() * 0xffffffff) >>> 0;

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /*                                                                     */
  /* data-theme="light" on <html> swaps the whole palette: the canvas is */
  /* repainted from the board it already has, and the live layer picks   */
  /* the new colours up through its custom properties.                   */
  /*                                                                     */
  /* The accent hue arrives the same way. newtab-theme.js writes the     */
  /* --ion* tokens as inline hsl() custom properties on <html>, so every */
  /* cool colour on the board is authored here as an OFFSET from its     */
  /* theme's base hue rather than as a fixed rgba literal: move the base */
  /* and the traces, pads, vias, packets and blooms all move with it and */
  /* keep the relationships they were drawn with. Neutrals do not move — */
  /* the near-black ground, the white chip lines, the light theme's ink. */
  /*                                                                     */
  /* With no accent set the base is read back off the --ion token, which */
  /* is the authored one by default and a preset's when data-palette is  */
  /* set: the board follows the palette the same way it follows a hue,   */
  /* and the default round-trips to the exact colours it always had.     */
  /* Saturation follows too, so mono's near-grey accent greys the board. */
  /* ------------------------------------------------------------------ */

  /* Measured off the authored art, so the default round-trips:
       dark    #7dd3ff  h 200.308  s 100     l 74.51    the base
               #a78bfa  h 255.135  s 91.74   l 76.27    base + 54.83  traces
               #c4b5fd  h 252.500  s 94.74   l 85.10    base + 52.19  packets
       light   #0b7fd6  h 205.714  s 90.22   l 44.12    the base
               #7c3aed  h 262.123  s 83.26   l 57.84    base + 56.41   */
  const PALETTE = {
    dark: {
      base: 200.308,
      ink: {
        cool:      { dh: 0,      s: 100,   l: 74.51 },
        violet:    { dh: 54.827, s: 91.74, l: 76.27 },
        violetPkt: { dh: 52.192, s: 94.74, l: 85.10 }
      },
      fixed: {
        under: 'rgba(5,6,10,.9)',
        viaFill: '#05060a',
        chipFill: 'rgba(255,255,255,.03)',
        chipLine: 'rgba(255,255,255,.12)',
        chipPin: 'rgba(255,255,255,.14)',
        chipNotch: 'rgba(255,255,255,.20)'
      },
      tint: {
        dot:         ['cool', 0.045],
        trace:       ['cool', 0.15],
        traceViolet: ['violet', 0.14],
        socket:      ['cool', 0.18],
        pad:         ['cool', 0.35],
        via:         ['cool', 0.38]
      },
      liveFixed: {},
      liveTint: {
        '--pkt':        ['cool', 1],
        '--pkt-core':   ['cool', 1],
        '--pkt-glow':   ['cool', 0.55],
        '--pkt-tail':   ['cool', 0.7],
        '--pkt-v':      ['violetPkt', 1],
        '--pkt-core-v': ['violetPkt', 1],
        '--pkt-glow-v': ['violetPkt', 0.55],
        '--pkt-tail-v': ['violetPkt', 0.7],
        '--bloom':      ['cool', 0.9]
      }
    },
    light: {
      base: 205.714,
      ink: {
        cool:   { dh: 0,      s: 90.22, l: 44.12 },
        violet: { dh: 56.409, s: 83.26, l: 57.84 }
      },
      fixed: {
        dot: 'rgba(18,22,42,.08)',
        under: 'rgba(247,248,252,.9)',
        viaFill: '#f7f8fc',
        chipFill: 'rgba(18,22,42,.04)',
        chipLine: 'rgba(18,22,42,.14)',
        chipPin: 'rgba(18,22,42,.16)',
        chipNotch: 'rgba(18,22,42,.22)'
      },
      tint: {
        trace:       ['cool', 0.22],
        traceViolet: ['violet', 0.18],
        socket:      ['cool', 0.28],
        pad:         ['cool', 0.5],
        via:         ['cool', 0.5]
      },
      liveFixed: {
        '--pkt-core': '#ffffff',
        '--pkt-core-v': '#ffffff'
      },
      liveTint: {
        '--pkt':        ['cool', 1],
        '--pkt-glow':   ['cool', 0.55],
        '--pkt-tail':   ['cool', 0.7],
        '--pkt-v':      ['violet', 1],
        '--pkt-glow-v': ['violet', 0.55],
        '--pkt-tail-v': ['violet', 0.7],
        '--bloom':      ['cool', 0.9]
      }
    }
  };

  function hsla(h, s, l, a) {
    const hue = ((h % 360) + 360) % 360;
    return 'hsla(' + (Math.round(hue * 1000) / 1000) + ', ' + s + '%, ' + l + '%, ' + a + ')';
  }

  /* hue === null means "no accent": every ink sits on its authored base.
     satScale (default 1) multiplies every authored saturation — see
     currentSatScale() for why a pale accent has to pull the board with it. */
  function buildTheme(name, hueValue, satScale) {
    const spec = PALETTE[name] || PALETTE.dark;
    const base = (typeof hueValue === 'number' && isFinite(hueValue)) ? hueValue : spec.base;
    const scale = (typeof satScale === 'number' && isFinite(satScale))
      ? Math.max(0, Math.min(1, satScale))
      : 1;
    const out = {};
    let key;

    function tinted(entry) {
      const ink = spec.ink[entry[0]];
      const s = Math.round(ink.s * scale * 100) / 100;   // scale 1 round-trips exactly
      return hsla(base + ink.dh, s, ink.l, entry[1]);
    }

    for (key in spec.fixed) out[key] = spec.fixed[key];
    for (key in spec.tint) out[key] = tinted(spec.tint[key]);

    const live = {};
    for (key in spec.liveFixed) live[key] = spec.liveFixed[key];
    for (key in spec.liveTint) live[key] = tinted(spec.liveTint[key]);
    out.live = live;

    return out;
  }

  function currentThemeName() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function normalizeHue(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    return ((value % 360) + 360) % 360;
  }

  /* The hue the accent is currently set to.

     A user-chosen hue comes straight from newtab-theme.js. With no custom
     hue that helper returns null, and the accent is then whatever the
     stylesheet authored — which a data-palette preset moves. So the token
     is read back off <html> EVERY time rather than cached: a palette swap
     changes nothing else observable, and the board has to follow it.
     Reading --ion is also the fallback for a page loaded without the
     helper at all. null only when neither can name a hue (a grey accent,
     or no computed style). */
  function currentHue() {
    if (typeof window.__accentHue === 'function') {
      const custom = normalizeHue(window.__accentHue());
      if (custom !== null) return custom;
    }
    return hueFromIonToken();
  }

  /* How saturated the board should paint, 0-1, as a multiplier on the
     authored inks.

     The board's colours are fixed S/L offsets from a base hue, so a hue
     alone cannot express a near-grey accent: the mono preset's
     hsl(215 25% 88%) would still come out as saturated blue traces. Scale
     by the accent's own saturation instead, relative to 0.9 — the authored
     accents sit at 100% (dark) and 90.22% (light), so both round-trip at
     scale 1 and only a genuinely pale accent pulls the circuitry toward
     grey. A user-chosen hue is always painted at full strength (the chrome
     derives it at s 90-100%), so it never desaturates anything. */
  function currentSatScale() {
    if (typeof window.__accentHue === 'function' &&
        normalizeHue(window.__accentHue()) !== null) {
      return 1;
    }
    const s = satFromIonToken();
    if (s === null) return 1;
    return Math.min(1, s / 0.9);
  }

  function ionToken() {
    if (!window.getComputedStyle) return null;
    try {
      return window.getComputedStyle(document.documentElement).getPropertyValue('--ion');
    } catch (err) {
      return null;
    }
  }

  function hueFromIonToken() {
    const value = ionToken();
    return value === null ? null : hueOfColor(value);
  }

  function satFromIonToken() {
    const value = ionToken();
    return value === null ? null : satOfColor(value);
  }

  /* Just enough colour parsing for what can land in --ion: an hsl() in
     either syntax, a hex, or an rgb(). Anything else has no hue. */
  function hueOfColor(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;

    const hsl = /^hsla?\(\s*([+-]?\d*\.?\d+)(deg|grad|rad|turn)?\s*[\s,]/i.exec(text);
    if (hsl) {
      let h = parseFloat(hsl[1]);
      const unit = (hsl[2] || 'deg').toLowerCase();
      if (unit === 'grad') h *= 0.9;
      else if (unit === 'rad') h *= 180 / Math.PI;
      else if (unit === 'turn') h *= 360;
      return normalizeHue(h);
    }

    const rgb = rgbOfColor(text);
    if (!rgb) return null;
    return hueOfRgb(rgb[0], rgb[1], rgb[2]);
  }

  /* The same value's saturation, 0-1. An hsl() states it; a hex or an
     rgb() is converted with the HSL formula. A grey is 0 — not null —
     because "no saturation" is exactly the answer there. */
  function satOfColor(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;

    const hsl = /^hsla?\(\s*[+-]?\d*\.?\d+(?:deg|grad|rad|turn)?\s*[\s,]\s*([+-]?\d*\.?\d+)%/i.exec(text);
    if (hsl) {
      const s = parseFloat(hsl[1]) / 100;
      if (!isFinite(s)) return null;
      return Math.max(0, Math.min(1, s));
    }

    const rgb = rgbOfColor(text);
    if (!rgb) return null;
    return satOfRgb(rgb[0], rgb[1], rgb[2]);
  }

  function rgbOfColor(text) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (hex) {
      const d = hex[1];
      return d.length === 3
        ? [parseInt(d[0] + d[0], 16), parseInt(d[1] + d[1], 16), parseInt(d[2] + d[2], 16)]
        : [parseInt(d.slice(0, 2), 16), parseInt(d.slice(2, 4), 16), parseInt(d.slice(4, 6), 16)];
    }
    const fn = /^rgba?\(\s*([+-]?\d*\.?\d+)\s*[\s,]\s*([+-]?\d*\.?\d+)\s*[\s,]\s*([+-]?\d*\.?\d+)/i.exec(text);
    if (fn) return [parseFloat(fn[1]), parseFloat(fn[2]), parseFloat(fn[3])];
    return null;
  }

  function satOfRgb(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!(d > 0)) return 0;
    const l = (max + min) / 2;
    const denom = 1 - Math.abs(2 * l - 1);
    if (!(denom > 0)) return 0;
    return Math.max(0, Math.min(1, d / denom));
  }

  function hueOfRgb(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!(d > 0)) return null;             // a grey has no hue to follow
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return normalizeHue(h * 60);
  }

  let themeName = currentThemeName();
  let hue = currentHue();
  let satScale = currentSatScale();
  let theme = buildTheme(themeName, hue, satScale);

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  function shuffle(list, rng) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function inflateRect(r, by) {
    return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function pointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function polylinePath(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  }

  /* An SVG path string for a polyline, in CSS px, for offset-path. */
  function pathString(pts) {
    let d = 'M ' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2);
    for (let i = 1; i < pts.length; i++) {
      d += ' L ' + pts[i].x.toFixed(2) + ' ' + pts[i].y.toFixed(2);
    }
    return d;
  }

  /* Collapse runs of collinear points down to real vertices. */
  function simplify(raw) {
    if (raw.length < 3) return raw.slice();
    const out = [raw[0]];
    for (let i = 1; i < raw.length - 1; i++) {
      const ax = raw[i].x - raw[i - 1].x, ay = raw[i].y - raw[i - 1].y;
      const bx = raw[i + 1].x - raw[i].x, by = raw[i + 1].y - raw[i].y;
      const cross = ax * by - ay * bx;
      const dot = ax * bx + ay * by;
      if (Math.abs(cross) > 1e-6 || dot <= 0) out.push(raw[i]);
    }
    out.push(raw[raw.length - 1]);
    return out;
  }

  /**
   * The capsule's box in page coordinates. offsetLeft/offsetTop walked up
   * the offset chain, NOT getBoundingClientRect: the page carries an
   * entrance transform that would skew a measured rect.
   */
  function measureBox(el) {
    let x = 0, y = 0, node = el;
    while (node && node !== document.body) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function capsuleBox(w, h) {
    // The whole column (wordmark, capsule, chips), so traces route around the
    // chips as well and packets never cross them.
    const form = document.querySelector('.column') || document.getElementById('search');
    if (form && form.offsetWidth && form.offsetHeight) return measureBox(form);
    // Fallback: where the capsule would sit if the page had not laid out.
    const cw = Math.min(720, w - 48);
    return { x: (w - cw) / 2, y: h / 2 - 28, w: cw, h: 56 };
  }

  /* ------------------------------------------------------------------ */
  /* Board generation                                                    */
  /* ------------------------------------------------------------------ */

  function buildBoard(w, h, cap) {
    const rng = mulberry32(SEED);

    const cols = Math.floor(w / CELL) + 1;
    const rows = Math.floor(h / CELL) + 1;
    const offX = (w - (cols - 1) * CELL) / 2;
    const offY = (h - (rows - 1) * CELL) / 2;

    const gx = (c) => offX + c * CELL;
    const gy = (r) => offY + r * CELL;
    const colAt = (x) => (x - offX) / CELL;
    const rowAt = (y) => (y - offY) / CELL;

    const occupied = new Set();     // hard: nothing may enter
    const soft = new Set();         // soft: no trace may START or turn here
    const chipCells = new Set();
    const key = (c, r) => c + ',' + r;
    const inBounds = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
    const mark = (c, r) => occupied.add(key(c, r));
    const isFree = (c, r) =>
      inBounds(c, r) && !occupied.has(key(c, r)) && !soft.has(key(c, r));

    /* --- socket: the capsule's box, inflated -------------------- */
    const socket = inflateRect(cap, SOCKET_INFLATE);
    const exclusion = inflateRect(socket, EXCLUSION_CELLS * CELL);

    // Nothing routes across the processor itself.
    for (let c = 0; c < cols; c++) {
      const x = gx(c);
      if (x < socket.x || x > socket.x + socket.w) continue;
      for (let r = 0; r < rows; r++) {
        const y = gy(r);
        if (y < socket.y || y > socket.y + socket.h) continue;
        mark(c, r);
      }
    }

    /* --- chips: 4 to 7, outside the exclusion zone -------------- */
    const chips = [];
    const chipCount = randInt(rng, 4, 7);
    for (let i = 0; i < chipCount; i++) {
      for (let attempt = 0; attempt < 140; attempt++) {
        let wc = randInt(rng, 4, 8);
        let hc = randInt(rng, 6, 10);
        if (rng() < 0.5) { const t = wc; wc = hc; hc = t; }
        if (wc + 4 >= cols || hc + 4 >= rows) break;

        const c0 = randInt(rng, 2, cols - wc - 3);
        const r0 = randInt(rng, 2, rows - hc - 3);
        const box = { x: gx(c0) - CELL / 2, y: gy(r0) - CELL / 2, w: wc * CELL, h: hc * CELL };

        if (rectsOverlap(box, exclusion)) continue;
        let clash = false;
        for (const other of chips) {
          if (rectsOverlap(box, inflateRect(other.box, CELL))) { clash = true; break; }
        }
        if (clash) continue;

        const chip = { c0: c0, r0: r0, wc: wc, hc: hc, box: box, vertical: hc >= wc, pins: [] };

        // Pins every cell along the two long sides, heading outward.
        if (chip.vertical) {
          for (let r = r0; r < r0 + hc; r++) {
            chip.pins.push({ x: box.x, y: gy(r), dir: 6, c: c0 - 1, r: r });
            chip.pins.push({ x: box.x + box.w, y: gy(r), dir: 2, c: c0 + wc, r: r });
          }
        } else {
          for (let c = c0; c < c0 + wc; c++) {
            chip.pins.push({ x: gx(c), y: box.y, dir: 0, c: c, r: r0 - 1 });
            chip.pins.push({ x: gx(c), y: box.y + box.h, dir: 4, c: c, r: r0 + hc });
          }
        }

        for (let c = c0; c < c0 + wc; c++) {
          for (let r = r0; r < r0 + hc; r++) { mark(c, r); chipCells.add(key(c, r)); }
        }
        chips.push(chip);
        break;
      }
    }

    /* --- socket pads: every 2 cells around the ring ------------- */
    const pads = [];
    const cFirst = Math.ceil(colAt(socket.x + CELL));
    const cLast = Math.floor(colAt(socket.x + socket.w - CELL));
    const rowAbove = Math.ceil(rowAt(socket.y)) - 1;
    const rowBelow = Math.floor(rowAt(socket.y + socket.h)) + 1;
    for (let c = cFirst; c <= cLast; c += PAD_STEP) {
      if (c < 0 || c >= cols) continue;
      pads.push({ x: gx(c), y: socket.y, dir: 0, c: c, r: rowAbove });
      pads.push({ x: gx(c), y: socket.y + socket.h, dir: 4, c: c, r: rowBelow });
    }
    const rFirst = Math.ceil(rowAt(socket.y + CELL));
    const rLast = Math.floor(rowAt(socket.y + socket.h - CELL));
    const colLeft = Math.ceil(colAt(socket.x)) - 1;
    const colRight = Math.floor(colAt(socket.x + socket.w)) + 1;
    for (let r = rFirst; r <= rLast; r += PAD_STEP) {
      if (r < 0 || r >= rows) continue;
      pads.push({ x: socket.x, y: gy(r), dir: 6, c: colLeft, r: r });
      pads.push({ x: socket.x + socket.w, y: gy(r), dir: 2, c: colRight, r: r });
    }

    /* --- traces -------------------------------------------------- */
    const socketCx = socket.x + socket.w / 2;
    const socketCy = socket.y + socket.h / 2;

    function growTrace(start) {
      if (!isFree(start.c, start.r)) return null;

      const own = new Set([key(start.c, start.r)]);
      const cells = [[start.c, start.r]];
      const raw = [{ x: start.x, y: start.y }, { x: gx(start.c), y: gy(start.r) }];

      let c = start.c, r = start.r, dir = start.dir;
      let endType = 'via';
      let steps = 1;
      let segLeft = randInt(rng, SEG_MIN_CELLS, SEG_MAX_CELLS);
      let sinceBend = BEND_GAP_CELLS;
      const total = randInt(rng, TRACE_MIN_CELLS, TRACE_MAX_CELLS);

      while (steps < total) {
        // A bend is one 45 degree step, and only once the trace has
        // cleared the exclusion zone around the socket.
        if (segLeft <= 0 && sinceBend >= BEND_GAP_CELLS && !pointInRect(gx(c), gy(r), exclusion)) {
          // Mostly turn away from the socket, the way an escape fan does:
          // neighbouring traces then stay parallel instead of colliding.
          const left = (dir + 7) % 8, right = (dir + 1) % 8;
          const rx = gx(c) - socketCx, ry = gy(r) - socketCy;
          const outward = (DIRS[right][0] * rx + DIRS[right][1] * ry) >=
                          (DIRS[left][0] * rx + DIRS[left][1] * ry) ? right : left;
          dir = rng() < 0.75 ? outward : (outward === right ? left : right);
          segLeft = randInt(rng, SEG_MIN_CELLS, SEG_MAX_CELLS);
          sinceBend = 0;
        }

        const nc = c + DIRS[dir][0];
        const nr = r + DIRS[dir][1];
        if (!inBounds(nc, nr)) break;
        if (own.has(key(nc, nr))) break;
        if (occupied.has(key(nc, nr))) {
          if (chipCells.has(key(nc, nr))) endType = 'pad';
          break;
        }
        // The soft ring only keeps starts apart; a trace already running
        // may pass through it.
        if (steps < 2 && soft.has(key(nc, nr))) break;
        // A diagonal step cuts the corner between two cells, so two
        // opposite diagonals would cross without ever sharing a cell.
        // Keep both corners clear and that can never happen.
        if (DIRS[dir][0] !== 0 && DIRS[dir][1] !== 0) {
          const cornerA = key(c, nr), cornerB = key(nc, r);
          if (occupied.has(cornerA) || occupied.has(cornerB) ||
              own.has(cornerA) || own.has(cornerB)) break;
        }

        c = nc; r = nr;
        own.add(key(c, r));
        cells.push([c, r]);
        raw.push({ x: gx(c), y: gy(r) });
        steps++; segLeft--; sinceBend++;
      }

      if (cells.length < 3) return null;

      // Claim the cells. The first two also claim their 8 neighbours
      // softly, so starts sitting side by side never merge into one smear.
      for (let i = 0; i < cells.length; i++) {
        mark(cells[i][0], cells[i][1]);
        if (i < 2) {
          for (const d of DIRS) soft.add(key(cells[i][0] + d[0], cells[i][1] + d[1]));
        }
      }

      // A trace that ran into a chip stops on its edge with a pad.
      if (endType === 'pad') {
        const last = raw[raw.length - 1];
        raw.push({ x: last.x + DIRS[dir][0] * CELL / 2, y: last.y + DIRS[dir][1] * CELL / 2 });
      }

      const pts = simplify(raw);
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }

      const reversed = pts.slice().reverse();
      return {
        pts: pts,
        len: len,
        endType: endType,
        violet: rng() < 0.3,
        path: 'path("' + pathString(pts) + '")',
        pathRev: 'path("' + pathString(reversed) + '")'
      };
    }

    const traceCount = Math.max(40, Math.min(220, Math.round((w * h) / 9000)));
    const pins = [];
    for (const chip of chips) for (const pin of chip.pins) pins.push(pin);
    const padQueue = shuffle(pads.slice(), rng);
    const pinQueue = shuffle(pins, rng);

    const traces = [];
    let padIdx = 0, pinIdx = 0;
    for (let i = 0; i < traceCount; i++) {
      let start = null;
      if (rng() < 0.7 && padIdx < padQueue.length) start = padQueue[padIdx++];
      else if (pinIdx < pinQueue.length) start = pinQueue[pinIdx++];
      else if (padIdx < padQueue.length) start = padQueue[padIdx++];
      if (!start) break;
      const trace = growTrace(start);
      if (trace) traces.push(trace);
    }

    return {
      w: w, h: h, cols: cols, rows: rows, gx: gx, gy: gy,
      socket: socket, chips: chips, pads: pads, traces: traces
    };
  }

  /* ------------------------------------------------------------------ */
  /* The board layer — painted once per layout, then left alone          */
  /* ------------------------------------------------------------------ */

  function drawBoard(c, board) {
    const gx = board.gx, gy = board.gy;

    // The dot grid the whole board is built on.
    c.fillStyle = theme.dot;
    for (let col = 0; col < board.cols; col++) {
      const x = gx(col) - 0.5;
      for (let row = 0; row < board.rows; row++) c.fillRect(x, gy(row) - 0.5, 1, 1);
    }

    // Traces: every path once in the page's own ground so it separates
    // from the aurora, then the copper itself.
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = theme.under;
    c.lineWidth = 4;
    for (const trace of board.traces) { polylinePath(c, trace.pts); c.stroke(); }
    c.lineWidth = 1.5;
    for (const trace of board.traces) {
      c.strokeStyle = trace.violet ? theme.traceViolet : theme.trace;
      polylinePath(c, trace.pts);
      c.stroke();
    }

    // Chips.
    for (const chip of board.chips) {
      const b = chip.box;
      roundRectPath(c, b.x, b.y, b.w, b.h, 6);
      c.fillStyle = theme.chipFill;
      c.fill();
      c.strokeStyle = theme.chipLine;
      c.lineWidth = 1;
      c.stroke();

      c.strokeStyle = theme.chipPin;
      c.beginPath();
      for (const pin of chip.pins) {
        c.moveTo(pin.x, pin.y);
        c.lineTo(pin.x + DIRS[pin.dir][0] * 3, pin.y + DIRS[pin.dir][1] * 3);
      }
      c.stroke();

      c.fillStyle = theme.chipNotch;
      c.beginPath();
      c.arc(b.x + 7, b.y + 7, 1.5, 0, Math.PI * 2);
      c.fill();
    }

    // The socket around the capsule, and its pads.
    const s = board.socket;
    roundRectPath(c, s.x, s.y, s.w, s.h, SOCKET_RADIUS);
    c.strokeStyle = theme.socket;
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = theme.pad;
    for (const pad of board.pads) c.fillRect(pad.x - 1, pad.y - 1, 2, 2);

    // Trace ends: a via, or a pad where the trace met a chip.
    for (const trace of board.traces) {
      const end = trace.pts[trace.pts.length - 1];
      if (trace.endType === 'pad') {
        c.fillStyle = theme.pad;
        c.fillRect(end.x - 1, end.y - 1, 2, 2);
      } else {
        c.beginPath();
        c.arc(end.x, end.y, 3, 0, Math.PI * 2);
        c.fillStyle = theme.viaFill;
        c.fill();
        c.strokeStyle = theme.via;
        c.lineWidth = 1;
        c.stroke();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* The live layer — packets and blooms as compositor-driven DOM        */
  /*                                                                     */
  /* A packet is one element on a CSS motion path built from the trace   */
  /* polyline. offset-rotate:auto turns its local x axis along the path, */
  /* so the tail is simply a bar to its left and follows every bend for  */
  /* free. Script touches an element twice in its life: once to create   */
  /* it, once to remove it.                                              */
  /* ------------------------------------------------------------------ */

  const STYLE_ID = 'board-style';
  const LIVE_ID = 'board-live';

  const LIVE_CSS =
    // No mask on the live layer: a masked layer with moving children gets
    // re-masked full-screen every frame. Each packet carries its own edge
    // fade as opacity instead (see vignetteAt), which costs nothing per frame.
    '#' + LIVE_ID + '{position:fixed;inset:0;pointer-events:none;}' +

    '#' + LIVE_ID + ' .pkt{position:absolute;left:0;top:0;width:0;height:0;' +
    'will-change:transform,opacity;}' +

    '#' + LIVE_ID + ' .pkt.violet{--pkt:var(--pkt-v);--pkt-core:var(--pkt-core-v);' +
    '--pkt-glow:var(--pkt-glow-v);--pkt-tail:var(--pkt-tail-v);}' +

    '#' + LIVE_ID + ' .tail{position:absolute;left:-' + TAIL_PX + 'px;top:-1.5px;' +
    'width:' + TAIL_PX + 'px;height:3px;border-radius:1.5px;' +
    'background:linear-gradient(90deg,transparent 0%,var(--pkt-tail) 100%);}' +

    '#' + LIVE_ID + ' .head{position:absolute;left:-8px;top:-8px;width:16px;height:16px;' +
    'border-radius:50%;background:' +
    'radial-gradient(circle at 50% 50%,var(--pkt-core) 0 1.5px,transparent 2px),' +
    'radial-gradient(circle at 50% 50%,var(--pkt-glow) 0%,transparent 70%);}' +

    /* margin centres the ring on the via, which leaves transform free
       for the scale animation. */
    '#' + LIVE_ID + ' .bloom{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;' +
    'border:1.5px solid var(--bloom);border-radius:50%;will-change:transform,opacity;}';

  let live = null;
  const running = new Set();
  let livePackets = 0;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = LIVE_CSS;
    document.head.appendChild(style);
  }

  function applyThemeVars() {
    if (!live) return;
    const vars = theme.live;
    for (const name in vars) live.style.setProperty(name, vars[name]);
  }

  function ensureLive() {
    if (live || reducedMotion) return;
    if (typeof canvas.animate !== 'function') return;   // Web Animations is all we need

    injectStyle();
    live = document.createElement('div');
    live.id = LIVE_ID;
    live.setAttribute('aria-hidden', 'true');
    // Stack exactly where the canvas stacks, whatever the page's CSS says;
    // being later in the DOM puts it above.
    // Above the search column, not under it: anything moving beneath a
    // backdrop-filter surface makes that surface re-blur every frame. The
    // socket keeps traces clear of the column, so nothing is ever covered.
    const z = parseInt(window.getComputedStyle(canvas).zIndex, 10);
    live.style.zIndex = String((Number.isFinite(z) ? z : 1) + 2);
    applyThemeVars();
    canvas.parentNode.insertBefore(live, canvas.nextSibling);
  }

  function clearLive() {
    if (!live) return;
    for (const anim of running) anim.cancel();
    running.clear();
    live.replaceChildren();
    livePackets = 0;
  }

  /* The same falloff the static canvas gets from its CSS mask, evaluated at a
     point, so a packet can carry it as its own opacity. */
  function vignetteAt(x, y, w, h) {
    const rx = 0.4 * w;
    const ry = 0.375 * h;
    const r = Math.hypot((x - 0.5 * w) / rx, (y - 0.48 * h) / ry);
    if (r <= 0.45) return 1;
    if (r >= 1) return 0;
    return 1 - (r - 0.45) / 0.55;
  }

  /* Compositor-only motion. offset-path animations are driven from the main
     thread every frame; transform/opacity keyframes run on the compositor.
     Two keyframes per segment, spaced by arc length: the tail holds the
     segment's angle and snaps round at each bend, and speed stays constant. */
  function packetKeyframes(pts, w, h) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    if (!total) return null;

    const frames = [];
    let cum = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI).toFixed(1);
      const at = (p) => 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) rotate(' + deg + 'deg)';
      frames.push({ transform: at(a), opacity: vignetteAt(a.x, a.y, w, h), offset: cum / total });
      cum += Math.hypot(b.x - a.x, b.y - a.y);
      frames.push({ transform: at(b), opacity: vignetteAt(b.x, b.y, w, h), offset: Math.min(1, cum / total) });
    }
    frames[0].offset = 0;
    frames[frames.length - 1].offset = 1;
    return frames;
  }

  function spawnPacket() {
    if (!live || !board || !board.traces.length || livePackets >= MAX_PACKETS) return;

    const trace = board.traces[(Math.random() * board.traces.length) | 0];
    if (!trace || !trace.len) return;
    const forward = Math.random() < FORWARD_SHARE;
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);

    // A reverse packet runs the reversed polyline, so its tail still trails.
    const pts = forward ? trace.pts : trace.pts.slice().reverse();
    const frames = packetKeyframes(pts, live.clientWidth || window.innerWidth, live.clientHeight || window.innerHeight);
    if (!frames) return;

    const el = document.createElement('div');
    el.className = Math.random() < VIOLET_SHARE ? 'pkt violet' : 'pkt';
    const tail = document.createElement('span');
    tail.className = 'tail';
    const head = document.createElement('span');
    head.className = 'head';
    el.appendChild(tail);
    el.appendChild(head);
    live.appendChild(el);
    livePackets++;

    // steps(): 24 position updates a second instead of one per display frame.
    // The compositor only draws when a value changed, so this cuts the cost
    // of a moving packet by more than half at no visible loss for a small dot.
    const dur = Math.max(140, (trace.len / speed) * 1000);
    const anim = el.animate(
      frames,
      { duration: dur, easing: 'steps(' + Math.max(1, Math.round(dur * 0.024)) + ')', fill: 'forwards' });
    running.add(anim);
    anim.onfinish = function () {
      running.delete(anim);
      el.remove();
      livePackets--;
      // Only the far end of a trace carries a via; the near end is a pad.
      if (forward && trace.endType === 'via') spawnBloom(trace.pts[trace.pts.length - 1]);
    };
  }

  function spawnBloom(pt) {
    if (!live || !pt) return;
    const el = document.createElement('div');
    el.className = 'bloom';
    el.style.left = pt.x.toFixed(2) + 'px';
    el.style.top = pt.y.toFixed(2) + 'px';
    live.appendChild(el);

    const peak = 0.9 * vignetteAt(pt.x, pt.y, live.clientWidth || window.innerWidth, live.clientHeight || window.innerHeight);
    const anim = el.animate(
      [{ transform: 'scale(.25)', opacity: peak }, { transform: 'scale(1)', opacity: 0 }],
      { duration: BLOOM_MS, easing: 'ease-out', fill: 'forwards' });
    running.add(anim);
    anim.onfinish = function () {
      running.delete(anim);
      el.remove();
    };
  }

  /* ------------------------------------------------------------------ */
  /* Layout and lifecycle                                                */
  /* ------------------------------------------------------------------ */

  let board = null;
  let layoutStamp = '';
  let spawnTimer = 0;
  let resizeTimer = 0;

  /* Set by the chrome through window.__boardPaused(). An overlay with a
     backdrop-filter (settings, tab search, downloads, shield, site info,
     omnibox suggestions) has to re-blur everything under it on every frame
     the page paints, so a board that keeps moving costs the OVERLAY about
     eleven points of CPU on top of its own. While one is open the board
     freezes exactly the way a hidden page freezes: in-flight sprites are
     Animation.pause()d rather than cancelled, so they resume from where
     they stopped instead of blinking out and respawning. */
  let chromePaused = false;

  /* A palette repaint that arrived while frozen. One canvas commit is
     deferred to the resume rather than dropped — the board would otherwise
     keep the old theme's colours until the next layout. */
  let pendingRepaint = false;

  /* NOT gated on document.hasFocus(): a new tab sitting in a split pane, or
     behind a focused panel, is still on screen and still expected to animate.
     Only the three signals below stop the board. */
  function motionFrozen() {
    return chromePaused || !!document.hidden || !boardActive();
  }

  function pauseAnims() {
    for (const anim of running) anim.pause();
  }

  function playAnims() {
    for (const anim of running) anim.play();
  }

  function flushRepaint() {
    if (!pendingRepaint) return;
    pendingRepaint = false;
    paintBoardNow();
  }

  /* data-bg on <html> — written by newtab.js from ?bg= and from the chrome's
     __applyBackground() push — decides whether this file has any work at all:

       board                        yes, the board is the background
       aurora                       no: the canvas and the live layer are
                                    display:none, so every packet and every
                                    repaint would be work nobody can see
       image                        no, unless the picture asked the board
       image + data-bg-board="over" back as a texture over it

     A hidden board is not just invisible: it costs a full-canvas commit per
     repaint and one compositor element per packet. Everything below checks
     this before spending anything. */
  function boardActive() {
    const root = document.documentElement;
    const kind = root.getAttribute('data-bg') || 'board';
    if (kind === 'aurora') return false;
    if (kind === 'image') return root.getAttribute('data-bg-board') === 'over';
    return true;                     // 'board', and any value we don't know
  }

  function scheduleSpawn() {
    if (reducedMotion || document.hidden || spawnTimer || !live) return;
    if (chromePaused || !boardActive()) return;
    const wait = SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
    spawnTimer = setTimeout(function () {
      spawnTimer = 0;
      spawnPacket();
      scheduleSpawn();
    }, wait);
  }

  function stopSpawn() {
    if (spawnTimer) clearTimeout(spawnTimer);
    spawnTimer = 0;
  }

  function layout(force) {
    if (!boardActive()) return;      // nothing on screen to lay out
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || document.documentElement.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || document.documentElement.clientHeight || window.innerHeight;
    if (!w || !h) return;

    // The shortcut row is filled in by newtab.js, which moves the capsule.
    // Keying on its box means a settle pass is free when nothing moved.
    const cap = capsuleBox(w, h);
    const sig = [w, h, dpr, cap.x, cap.y, cap.w, cap.h].join(':');
    if (!force && board && sig === layoutStamp) return;
    layoutStamp = sig;

    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    board = buildBoard(w, h, cap);
    drawBoard(ctx, board);

    // Every live element points at a path from the old board.
    clearLive();
  }

  /* The gate. A repaint asked for while the board is frozen is remembered,
     not spent: one commit on resume instead of one under a live blur. */
  function repaintBoard() {
    if (!board || !boardActive()) return;
    if (chromePaused || document.hidden) { pendingRepaint = true; return; }
    paintBoardNow();
  }

  /* The commit itself. */
  function paintBoardNow() {
    pendingRepaint = false;
    if (!board) return;
    ctx.clearRect(0, 0, board.w, board.h);
    drawBoard(ctx, board);
  }

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      layout(true);
      scheduleSpawn();
    }, 150);
  }

  function onVisibility() {
    if (document.hidden) {
      stopSpawn();
      pauseAnims();
      return;
    }
    layout();                        // covers a page that loaded hidden
    // An overlay can outlive the tab switch: coming back visible with the
    // chrome still paused leaves everything frozen until it says otherwise.
    if (chromePaused) return;
    playAnims();
    flushRepaint();
    scheduleSpawn();
  }

  /* data-theme, data-palette and the accent all land as attributes on
     <html>, and a hue drag fires a burst of them. Coalesce to one check
     per frame: the
     static canvas is still painted once per CHANGE, never per frame, and
     an unchanged palette costs nothing but the compare. */
  let paletteFrame = 0;

  function onRootAttrChange() {
    if (paletteFrame) return;
    paletteFrame = requestAnimationFrame(function () {
      paletteFrame = 0;
      applyBgMode();
      applyPalette();
    });
  }

  /* Whether the board was doing work the last time we looked. data-bg lands
     on <html> the same way the palette does, so it arrives here too. */
  let boardOn = true;

  function applyBgMode() {
    const next = boardActive();
    if (next === boardOn) return;
    boardOn = next;
    if (!next) {
      // Off: no timer, no live elements, no canvas commits until it is back.
      stopSpawn();
      clearLive();
      return;
    }
    // Back on: the board was never built for the current size, so force it.
    layout(true);
    ensureLive();
    scheduleSpawn();
  }

  function applyPalette() {
    const nextName = currentThemeName();
    const nextHue = currentHue();
    const nextSat = currentSatScale();
    if (nextName === themeName && nextHue === hue && nextSat === satScale) return;
    themeName = nextName;
    hue = nextHue;
    satScale = nextSat;
    theme = buildTheme(themeName, hue, satScale);
    repaintBoard();
    applyThemeVars();                // running packets pick the colours up
  }

  function start() {
    boardOn = boardActive();
    layout();
    if (reducedMotion) return;       // static board only: no sprites, no timers
    if (!boardOn) return;            // aurora or a picture: nothing to run
    ensureLive();
    scheduleSpawn();
  }

  function init() {
    window.addEventListener('resize', onResize);
    if (!reducedMotion) document.addEventListener('visibilitychange', onVisibility);

    if (window.MutationObserver) {
      const themeWatch = new window.MutationObserver(onRootAttrChange);
      themeWatch.observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'data-bg', 'data-bg-board', 'style'] });
    }

    // Settle passes: newtab.js fills the shortcut row in its own
    // DOMContentLoaded handler, which moves the capsule. Measuring a
    // frame later — and again at load — catches it. Both no-op when the
    // capsule has not moved. Apart from the palette coalescer above, this
    // is the only requestAnimationFrame in the file; nothing draws per
    // frame.
    window.addEventListener('load', function () { layout(); });
    requestAnimationFrame(start);
  }

  /* ------------------------------------------------------------------ */
  /* The chrome's handle on the board                                     */
  /*                                                                      */
  /* __boardPaused(true) when an overlay with a backdrop-filter opens over */
  /* the page, false when the last one closes. Idempotent, and it is only  */
  /* ONE of three reasons the board can be frozen — a hidden page and an   */
  /* inactive data-bg mode are the others, and any one of them is enough.  */
  /* Resuming therefore resumes nothing the other two still veto.          */
  /* ------------------------------------------------------------------ */

  window.__boardPaused = function (flag) {
    const next = !!flag;
    if (next === chromePaused) return;   // repeat calls cost nothing
    chromePaused = next;

    if (next) {
      stopSpawn();                       // no new packets
      pauseAnims();                      // the live ones hold their position
      return;
    }

    // Still frozen for another reason: onVisibility()/applyBgMode() own it.
    if (document.hidden || !boardActive()) return;
    playAnims();
    flushRepaint();                      // the palette change we sat on
    scheduleSpawn();
  };

  window.__boardState = function () {
    return {
      running: !reducedMotion && !!live && !motionFrozen(),
      paused: chromePaused,
      hidden: !!document.hidden,
      mode: document.documentElement.getAttribute('data-bg') || 'board'
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();
