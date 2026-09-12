/* ============================================================
   newtab.js — the new tab page's own behaviour.

   There is no search field on this page: the window's address bar
   is where it searches. What sits in the field's old place is the
   instrument strip, five readouts the chrome pushes in every two
   seconds through window.__applyStats().

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.

   The browser's settings reach it two ways:

     1. query params, for the first paint —
        ?theme=dark&palette=ocean&hue=300&chips=<JSON>&bg=image
        (every param optional; theme, palette and hue are handled
        earlier, in newtab-theme.js, so colour never flashes)

     2. window.__applySettings({ accentHue, palette, chips })
        pushed later with executeJavaScript. A null or missing
        field means "back to this page's own default". searchEngine
        may still arrive and is ignored: nothing here searches.

     3. window.__applyBackground({ kind, boardOverImage, dim, dataUrl })
        pushed the same way, because the picture is a data: URL far too
        big to hang off the URL.

     4. window.__applyStats(sample) every 2000 ms while this guest is
        the one on screen — see "the instrument strip" below.
   ============================================================ */

'use strict';

/* The shortcut row, used whenever the browser sends no chips of its own. */
const LINKS = [
  { label: 'Wiki',      url: 'https://www.wikipedia.org' },
  { label: 'GitHub',    url: 'https://github.com' },
  { label: 'YouTube',   url: 'https://www.youtube.com' },
  { label: 'Gmail',     url: 'https://mail.google.com' },
  { label: 'Claude',    url: 'https://claude.ai' },
];

/* One shared favicon service; the chip falls back to its label if it 404s. */
const FAVICON_URL = 'https://www.google.com/s2/favicons?domain=';

/* Recent sites. The chrome may hand us more than we show: we accept up to
   RECENT_ACCEPT and draw at most RECENT_LIMIT tiles under the shortcuts. */
const RECENT_ACCEPT = 8;
const RECENT_LIMIT = 6;

/* ------------------------------------------------------------------ */
/* URL handling — only ever validation, never navigation               */
/* ------------------------------------------------------------------ */

function parseUrlOrNull(text) {
  try {
    return new URL(text);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/* The chip list the chrome sent (null = LINKS). */
let chipList = null;

/* Validated recents, most recent first, deduped by host. [] until the
   chrome pushes some in with __applyRecent(). */
let recentList = [];

/** One host, compared the way a person would: case- and www-blind. */
function hostKey(hostname) {
  return String(hostname == null ? '' : hostname).toLowerCase().replace(/^www\./, '');
}

/**
 * Validate one chip list from the chrome. Keeps only entries with an
 * http(s) url; a missing label becomes the bare hostname. Anything that
 * is not an array yields null, meaning "use LINKS".
 */
function normalizeChips(list) {
  if (!Array.isArray(list)) return null;

  const out = [];

  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;

    const parsed = parseUrlOrNull(item.url.trim());
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const host = parsed.hostname.replace(/^www\./i, '');
    const label = (typeof item.label === 'string' && item.label.trim())
      ? item.label.trim()
      : host;

    out.push({ label: label, url: parsed.href, host: parsed.hostname });
  }

  return out;
}

/* LINKS goes through the same validator, so every rendered chip has a host. */
const DEFAULT_CHIPS = normalizeChips(LINKS) || [];

/** Whatever should be on screen right now. */
function currentChips() {
  return chipList || DEFAULT_CHIPS;
}

/**
 * Validate one recent list from the chrome: [{ url, title, last }, …],
 * most recent first. http(s) only, one entry per host (the first, i.e. the
 * most recent, wins), at most RECENT_ACCEPT of them. `last` is carried by
 * the chrome for its own ordering and is not read here.
 */
function normalizeRecent(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;

    const parsed = parseUrlOrNull(item.url.trim());
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const key = hostKey(parsed.hostname);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const label = (typeof item.title === 'string' && item.title.trim())
      ? item.title.trim()
      : key;

    out.push({ label: label, url: parsed.href, host: parsed.hostname, key: key });
    if (out.length >= RECENT_ACCEPT) break;
  }

  return out;
}

/**
 * The recents worth drawing: anything already sitting in the shortcut row
 * is one click away, so it is dropped rather than shown twice.
 */
function visibleRecent() {
  const chipHosts = new Set(currentChips().map(function (chip) { return hostKey(chip.host); }));
  const out = [];

  for (const item of recentList) {
    if (chipHosts.has(item.key)) continue;
    out.push(item);
    if (out.length >= RECENT_LIMIT) break;
  }

  return out;
}

/** ?chips=<encodeURIComponent(JSON)>. Malformed JSON is ignored, not fatal. */
function parseChipsParam(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function setChips(list) {
  chipList = normalizeChips(list);
  renderLinks();
  renderRecent();          // a new chip host may hide (or free) a recent tile
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const linkRow = document.getElementById('links');
const recentRow = document.getElementById('recent');

/* What the nav currently shows, so a settings push that changes nothing
   does not rebuild the row (and re-request every favicon). */
let renderedKey = null;

/* The same trick for the recent row: a repeated push leaves the DOM (and
   its favicons) exactly where it was. */
let renderedRecentKey = null;

function faviconUrl(host) {
  return FAVICON_URL + encodeURIComponent(host) + '&sz=32';
}

/**
 * One 16px favicon. A blocked or missing icon must not leave a hole, so
 * the <img> removes itself on error and the row keeps its normal padding.
 */
function faviconImg(host, className) {
  const icon = document.createElement('img');
  icon.className = className;
  icon.src = faviconUrl(host);
  icon.width = 16;
  icon.height = 16;
  icon.alt = '';
  icon.loading = 'lazy';
  icon.setAttribute('aria-hidden', 'true');
  icon.onerror = function () {
    if (icon.parentNode) icon.parentNode.removeChild(icon);
  };
  return icon;
}

/** Identity of a chip list, cheap enough to compare on every push. */
function chipsKey(list) {
  return list.map(function (item) { return item.url + ' ' + item.label; }).join('\n');
}

/** Build the shortcut chips from the current list. */
function renderLinks() {
  if (!linkRow) return;

  const list = currentChips();
  const key = chipsKey(list);
  if (key === renderedKey) return;      // nothing moved: leave the DOM alone
  renderedKey = key;

  const frag = document.createDocumentFragment();

  for (const item of list) {
    const chip = document.createElement('a');
    chip.className = 'chip';
    chip.href = item.url;

    if (item.host) chip.appendChild(faviconImg(item.host, 'chip-icon'));

    chip.appendChild(document.createTextNode(item.label));
    frag.appendChild(chip);
  }

  linkRow.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* Recent sites                                                        */
/* ------------------------------------------------------------------ */

/** Build the small tile row under the shortcuts. Hidden when empty. */
function renderRecent() {
  if (!recentRow) return;

  const list = visibleRecent();
  const key = list.map(function (item) { return item.url; }).join('\n');
  if (key === renderedRecentKey) return;   // same sites: leave the favicons alone
  renderedRecentKey = key;

  const frag = document.createDocumentFragment();

  if (!list.length) {
    recentRow.replaceChildren(frag);
    recentRow.hidden = true;
    return;
  }

  const caption = document.createElement('p');
  caption.className = 'recent-caption';
  caption.appendChild(document.createTextNode('Recent'));
  frag.appendChild(caption);

  for (const item of list) {
    const tile = document.createElement('a');
    tile.className = 'rtile';
    tile.href = item.url;
    tile.title = item.host;

    tile.appendChild(faviconImg(item.host, 'rtile-icon'));

    const label = document.createElement('span');
    label.className = 'rtile-label';
    label.appendChild(document.createTextNode(item.label));
    tile.appendChild(label);

    frag.appendChild(tile);
  }

  recentRow.replaceChildren(frag);
  recentRow.hidden = false;
}

/* ------------------------------------------------------------------ */
/* The clock module                                                    */
/*                                                                     */
/* One timeout, aligned to the next minute, rescheduled from inside     */
/* itself. No setInterval and no per-second tick: nothing on this face  */
/* changes between minutes, and a timer that fires sixty times for one  */
/* repaint is sixty wake-ups of a guest that is often not even on       */
/* screen. A hidden page's timers are throttled, so coming back from    */
/* hidden — or from a restored webview — repaints and re-aligns rather  */
/* than trusting the timer that was asleep.                            */
/* ------------------------------------------------------------------ */

const clockTime = document.getElementById('clock-time');
const clockPeriod = document.getElementById('clock-period');
const clockDate = document.getElementById('clock-date');

let clockTimer = 0;

/** Write only when it actually changed: this runs on every window focus. */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * The time as the window's own locale states it, with the meridiem split
 * out: "9:05" + "AM" in a 12-hour locale, "09:05" + "" in a 24-hour one,
 * so the big readout is only ever digits and the AM/PM can sit small
 * beside it.
 */
function clockParts(now) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
      .formatToParts(now);
    let time = '';
    let period = '';

    for (const part of parts) {
      if (part.type === 'dayPeriod') period = part.value;
      else if (part.type === 'literal' && !part.value.trim()) continue;  // the space before AM
      else time += part.value;
    }

    if (time) return { time: time, period: period };
  } catch (err) {
    /* no Intl, or a locale it cannot build: fall through to 24-hour */
  }

  const m = now.getMinutes();
  return { time: now.getHours() + ':' + (m < 10 ? '0' + m : String(m)), period: '' };
}

/** "Thursday, 11 September" — whichever order the locale puts it in. */
function clockDateText(now) {
  try {
    return now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (err) {
    return '';
  }
}

function paintClock() {
  const now = new Date();
  const parts = clockParts(now);
  setText(clockTime, parts.time);
  setText(clockPeriod, parts.period);
  setText(clockDate, clockDateText(now));
}

function scheduleClock() {
  if (clockTimer) clearTimeout(clockTimer);
  const now = new Date();
  // Just after the turn, never on it: a timer that fires a few ms early
  // paints the minute it is already showing and then has to do it twice.
  const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  clockTimer = setTimeout(function () {
    clockTimer = 0;
    paintClock();
    scheduleClock();
  }, Math.max(250, wait));
}

/** Back on screen: the throttled timer may be up to a minute behind. */
function refreshClock() {
  if (document.hidden) return;
  paintClock();
  scheduleClock();
}

/* ------------------------------------------------------------------ */
/* The session readout                                                 */
/*                                                                     */
/* The chrome pushes it in on every tab change and every status change: */
/*                                                                     */
/*   window.__applyReadout({ tabs, claude, autopause })                 */
/*     tabs       number of open tabs                                   */
/*     claude     number of live Claude sessions                        */
/*     autopause  'off' | 'on' | 'holding' | 'unknown'                  */
/*                                                                     */
/* The tile is [hidden] until the first call, because a readout of      */
/* three dashes is worse than no readout — and because a hidden tile    */
/* has no box, which is exactly what the board needs to know. Showing   */
/* it therefore re-seats it on the board (see __boardRelayout).         */
/* ------------------------------------------------------------------ */

const sessionModule = document.getElementById('mod-session');
const readTabs = document.getElementById('read-tabs');
const readTabsLabel = document.getElementById('read-tabs-label');
const readClaude = document.getElementById('read-claude');
const readClaudeLabel = document.getElementById('read-claude-label');
const readAutopause = document.getElementById('read-autopause');

/* Sentence case, and the only four states the bridge can be in. */
const AUTOPAUSE_TEXT = { off: 'Off', on: 'On', holding: 'Holding', unknown: '--' };

let readoutState = { tabs: null, claude: null, autopause: 'unknown' };

/** A count, or null for "the chrome did not say". Never negative. */
function readoutCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function paintReadout() {
  const tabs = readoutState.tabs;
  const claude = readoutState.claude;

  setText(readTabs, tabs === null ? '--' : String(tabs));
  setText(readTabsLabel, tabs === 1 ? 'tab open' : 'tabs open');
  setText(readClaude, claude === null ? '--' : String(claude));
  setText(readClaudeLabel, claude === 1 ? 'Claude session' : 'Claude sessions');
  setText(readAutopause, AUTOPAUSE_TEXT[readoutState.autopause]);
}

window.__applyReadout = function (data) {
  const next = (data && typeof data === 'object') ? data : {};
  const mode = String(next.autopause == null ? 'unknown' : next.autopause).toLowerCase();

  readoutState = {
    tabs: readoutCount(next.tabs),
    claude: readoutCount(next.claude),
    autopause: Object.prototype.hasOwnProperty.call(AUTOPAUSE_TEXT, mode) ? mode : 'unknown'
  };
  paintReadout();

  if (sessionModule && sessionModule.hidden) {
    sessionModule.hidden = false;
    // It has a box now: the board has to seat it and route around it.
    if (typeof window.__boardRelayout === 'function') window.__boardRelayout();
  }

  return window.__readout();
};

/** What the readout actually shows, for tests. */
window.__readout = function () {
  return {
    tabs: readoutState.tabs,
    claude: readoutState.claude,
    autopause: readoutState.autopause,
    shown: !!(sessionModule && !sessionModule.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* The instrument strip                                                 */
/*                                                                      */
/* Five readouts where the search field used to be. The chrome samples   */
/* the machine in the main process and pushes one object in every two    */
/* seconds with window.__applyStats(sample):                             */
/*                                                                      */
/*   { t, cpu:{percent,cores}, mem:{usedBytes,totalBytes,percent},       */
/*     disk:{percent,readBps,writeBps}, net:{downBps,upBps},             */
/*     gpu:{percent}, uptimeSec }                                       */
/*                                                                      */
/* A null field means "this machine cannot say", and shows a dash for    */
/* good — the strip never guesses and never interpolates.                */
/*                                                                      */
/* Cost: there is no timer and no requestAnimationFrame anywhere in      */
/* here. A sample landing is the only thing that repaints the five       */
/* canvases, so a page nobody is pushing to costs exactly nothing. The   */
/* other two repaints are a theme flip and a resize, both one-shot.      */
/* ------------------------------------------------------------------ */

/* The chrome asks this before it subscribes: a page that did not want
   stats would set it false and the sampler would never start. */
window.__statsWanted = true;

const STAT_SAMPLES = 60;         // ~2 minutes of history at one per 2 s
const DASH = '—';

/* The floor the network graph is scaled against, so an idle link draws a
   flat line near the bottom instead of amplifying its own noise to full
   height. 131072 bytes/s is 1 Mb/s. */
const NET_FLOOR_BPS = 131072;

const statText = {
  cpu:     document.getElementById('st-cpu'),
  mem:     document.getElementById('st-mem'),
  disk:    document.getElementById('st-disk'),
  netDown: document.getElementById('st-net-down'),
  netUp:   document.getElementById('st-net-up'),
  gpu:     document.getElementById('st-gpu')
};

const statCanvas = {
  cpu:  document.getElementById('sg-cpu'),
  mem:  document.getElementById('sg-mem'),
  disk: document.getElementById('sg-disk'),
  net:  document.getElementById('sg-net'),
  gpu:  document.getElementById('sg-gpu')
};

/* One array of numbers-or-null per graph, oldest first, capped at
   STAT_SAMPLES. The net series is down + up: the two rates are stated
   separately in the text, and the graph is the link's total traffic. */
const statSeries = { cpu: [], mem: [], disk: [], net: [], gpu: [] };

/** A finite number in [0,100], or null. */
function pctOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** A finite number >= 0, or null. */
function rateOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, value);
}

function pctText(value) {
  return value == null ? DASH : Math.round(value) + '%';
}

/** "8.9 / 15.8 GB", both halves in GiB so they agree with Task Manager. */
function memText(mem) {
  const used = mem ? rateOrNull(mem.usedBytes) : null;
  const total = mem ? rateOrNull(mem.totalBytes) : null;
  if (used == null || total == null || !total) return DASH;
  const gb = 1073741824;
  return (used / gb).toFixed(1) + ' / ' + (total / gb).toFixed(1) + ' GB';
}

/**
 * A byte rate as BITS per second — Kb/s, Mb/s, Gb/s — which is the unit a
 * link is quoted in and the one Task Manager's network graph uses. The
 * label under the readout says "(bits/s)" so the b is never ambiguous.
 */
function bitsText(bytesPerSec, word) {
  const bytes = rateOrNull(bytesPerSec);
  if (bytes == null) return DASH;

  const bits = bytes * 8;
  let n = bits / 1000;
  let unit = 'Kb/s';

  if (bits >= 1e9) { n = bits / 1e9; unit = 'Gb/s'; }
  else if (bits >= 1e6) { n = bits / 1e6; unit = 'Mb/s'; }

  const figure = (n >= 100) ? String(Math.round(n)) : n.toFixed(1);
  return figure + ' ' + unit + ' ' + word;
}

/** Append one reading, oldest off the front. */
function pushSample(series, value) {
  series.push(value);
  while (series.length > STAT_SAMPLES) series.shift();
}

/** The largest reading in a series, ignoring the nulls. 0 for none. */
function seriesPeak(series) {
  let peak = 0;
  for (const value of series) {
    if (value != null && value > peak) peak = value;
  }
  return peak;
}

/**
 * One history graph. Newest sample at the right edge, so the line grows
 * in from the right and then scrolls, the way every meter on this machine
 * draws one. Two strokes and no more: a hairline baseline in --edge, and
 * the series in --ion over a 10% fill of the same colour.
 *
 * The canvas backing store is sized in device pixels, and the baseline is
 * snapped to the device grid, so the hairline is one real pixel rather
 * than a two-pixel smear on a 1.5x display.
 */
function paintGraph(canvas, series, scaleMax, edge, ion) {
  if (!canvas || typeof canvas.getContext !== 'function') return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 120));
  const h = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 28));
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));

  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;

  const c = canvas.getContext('2d');
  if (!c) return;

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  // The baseline sits on the last device row, centred in it.
  const base = (ph - 0.5) / dpr;
  const top = 1;                            // the peak never touches the lid
  const span = Math.max(1, base - top);

  c.lineWidth = 1 / dpr;
  c.strokeStyle = edge;
  c.beginPath();
  c.moveTo(0, base);
  c.lineTo(w, base);
  c.stroke();

  const max = scaleMax > 0 ? scaleMax : 1;
  const step = (w - 2) / (STAT_SAMPLES - 1);
  const first = w - 1 - (series.length - 1) * step;

  // Every run of consecutive readings is its own shape: a machine that
  // stopped reporting for a while leaves a gap, not a straight line
  // across the missing minutes.
  const runs = [];
  let run = null;

  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (value == null) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push({
      x: first + i * step,
      y: base - Math.max(0, Math.min(1, value / max)) * span
    });
  }

  if (!runs.length) return;

  c.fillStyle = ion;
  c.globalAlpha = 0.10;

  for (const points of runs) {
    if (points.length < 2) continue;        // a single dot has no area
    c.beginPath();
    c.moveTo(points[0].x, base);
    for (const p of points) c.lineTo(p.x, p.y);
    c.lineTo(points[points.length - 1].x, base);
    c.closePath();
    c.fill();
  }

  c.globalAlpha = 1;
  c.strokeStyle = ion;
  c.lineWidth = 1;                          // 1 CSS px: the one accent here
  c.lineJoin = 'round';
  c.lineCap = 'round';

  for (const points of runs) {
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
    c.stroke();
  }
}

/** All five, once. The only caller that runs often is a landing sample. */
function paintStats() {
  const style = getComputedStyle(document.documentElement);
  const edge = style.getPropertyValue('--edge').trim() || 'rgba(255,255,255,.11)';
  const ion = style.getPropertyValue('--ion').trim() || '#72adca';

  paintGraph(statCanvas.cpu, statSeries.cpu, 100, edge, ion);
  paintGraph(statCanvas.mem, statSeries.mem, 100, edge, ion);
  paintGraph(statCanvas.disk, statSeries.disk, 100, edge, ion);
  paintGraph(statCanvas.net, statSeries.net,
    Math.max(NET_FLOOR_BPS, seriesPeak(statSeries.net)), edge, ion);
  paintGraph(statCanvas.gpu, statSeries.gpu, 100, edge, ion);
}

/**
 * The chrome pushes one sample here. Everything it does is append, write
 * six strings and repaint five small canvases — no layout changes, because
 * every box in the strip is sized by CSS.
 */
window.__applyStats = function (sample) {
  const s = sample || {};

  const cpu = s.cpu ? pctOrNull(s.cpu.percent) : null;
  const memPct = s.mem ? pctOrNull(s.mem.percent) : null;
  const disk = s.disk ? pctOrNull(s.disk.percent) : null;
  const gpu = s.gpu ? pctOrNull(s.gpu.percent) : null;
  const down = s.net ? rateOrNull(s.net.downBps) : null;
  const up = s.net ? rateOrNull(s.net.upBps) : null;

  pushSample(statSeries.cpu, cpu);
  pushSample(statSeries.mem, memPct);
  pushSample(statSeries.disk, disk);
  pushSample(statSeries.gpu, gpu);
  pushSample(statSeries.net, (down == null && up == null) ? null : (down || 0) + (up || 0));

  setText(statText.cpu, pctText(cpu));
  setText(statText.mem, memText(s.mem));
  setText(statText.disk, pctText(disk));
  setText(statText.netDown, bitsText(down, 'down'));
  setText(statText.netUp, bitsText(up, 'up'));
  setText(statText.gpu, pctText(gpu));

  paintStats();
  return window.__stats();
};

/** What the strip actually shows, for tests. */
window.__stats = function () {
  return {
    cpu: statText.cpu ? statText.cpu.textContent : null,
    mem: statText.mem ? statText.mem.textContent : null,
    disk: statText.disk ? statText.disk.textContent : null,
    netDown: statText.netDown ? statText.netDown.textContent : null,
    netUp: statText.netUp ? statText.netUp.textContent : null,
    gpu: statText.gpu ? statText.gpu.textContent : null,
    samples: statSeries.cpu.length
  };
};

/* The accent's base colour differs per theme, so re-derive the same hue
   whenever the chrome flips data-theme on <html>. */
function watchTheme() {
  if (typeof MutationObserver !== 'function') return;

  const observer = new MutationObserver(function () {
    if (typeof window.__applyAccent === 'function') {
      window.__applyAccent(window.__accentHue ? window.__accentHue() : null);
    }
    // The graphs hold a painted copy of --ion and --edge: a theme flip
    // between samples would otherwise leave them in the old colour for
    // up to two seconds.
    paintStats();
  });

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ------------------------------------------------------------------ */
/* Background                                                          */
/*                                                                     */
/* Three backgrounds, chosen in Settings and pushed in by the chrome:   */
/*                                                                     */
/*   board   the circuit board — this page's own default               */
/*   aurora  the aurora alone; newtab-bg.js then does nothing at all    */
/*   image   the user's picture, dimmed, with the board optional        */
/*                                                                     */
/* The picture never travels on the URL: the chrome keeps the blob in   */
/* IndexedDB and hands it over as a data: URL inside the push. ?bg= is  */
/* only a first-paint hint, so an image user never watches the board    */
/* draw itself and then disappear.                                      */
/* ------------------------------------------------------------------ */

const BG_KINDS = ['board', 'aurora', 'image'];
const BG_DIM_DEFAULT = 0.25;
const BG_DIM_MAX = 0.6;

function bgKind(value) {
  return BG_KINDS.indexOf(String(value)) >= 0 ? String(value) : 'board';
}

/** 0..0.6, with anything unreadable falling back to the default wash. */
function bgDim(value) {
  if (value === null || value === undefined || value === '') return BG_DIM_DEFAULT;
  const n = Number(value);
  if (!isFinite(n)) return BG_DIM_DEFAULT;
  return Math.min(BG_DIM_MAX, Math.max(0, n));
}

let bgState = { kind: 'board', boardOverImage: false, dim: 0, hasImage: false };

function applyBackground(bg) {
  const next = bg && typeof bg === 'object' ? bg : {};
  const kind = bgKind(next.kind);
  const over = kind === 'image' && next.boardOverImage === true;
  const dim = kind === 'image' ? bgDim(next.dim) : 0;
  /* Only a data: image URL is ever written into the stylesheet. */
  const url = kind === 'image' && typeof next.dataUrl === 'string' &&
    /^data:image\//i.test(next.dataUrl) ? next.dataUrl : '';

  const root = document.documentElement;
  root.setAttribute('data-bg', kind);
  if (over) root.setAttribute('data-bg-board', 'over');
  else root.removeAttribute('data-bg-board');
  /* Only ever inline for a picture: the token has its own default in the
     stylesheet, and <html>'s inline style is otherwise the accent's alone. */
  if (kind === 'image') root.style.setProperty('--bg-dim', String(dim));
  else root.style.removeProperty('--bg-dim');

  const layer = document.getElementById('bg-image');
  if (layer) {
    if (url) layer.style.setProperty('background-image', 'url("' + url + '")');
    else layer.style.removeProperty('background-image');
  }

  bgState = { kind: kind, boardOverImage: over, dim: dim, hasImage: !!url };
  return bgState;
}

/**
 * The chrome pushes the background in on dom-ready and on every settings
 * change: __applyBackground({ kind, boardOverImage, dim, dataUrl }).
 * Anything missing means this page's own default.
 */
window.__applyBackground = function (bg) {
  return applyBackground(bg);
};

/** The background actually on screen, for tests. */
window.__background = function () {
  return {
    kind: bgState.kind,
    boardOverImage: bgState.boardOverImage,
    dim: bgState.dim,
    hasImage: bgState.hasImage
  };
};

/** The chrome pushes settings here with executeJavaScript. */
window.__applySettings = function (settings) {
  const next = settings || {};
  // next.searchEngine is deliberately ignored: this page has no field.
  setChips(next.chips);
  // Palette first: it authors the accent the hue is then painted over, so
  // a push that clears the hue lands on the new preset's own colour.
  if (typeof window.__applyPalette === 'function') window.__applyPalette(next.palette);
  if (typeof window.__applyAccent === 'function') window.__applyAccent(next.accentHue);
};

/**
 * The chrome pushes browsing history here the same way, up to 8 entries,
 * most recent first: __applyRecent([{ url, title, last }]). Safe to call
 * before DOMContentLoaded (the nav is parsed above this script), and safe
 * to call repeatedly — an unchanged list does not rebuild anything.
 */
window.__applyRecent = function (list) {
  recentList = normalizeRecent(list);
  renderRecent();
};

/** The chips actually on screen, for tests. */
window.__chips = function () {
  return currentChips().map(function (item) {
    return { label: item.label, url: item.url };
  });
};

/** The recent tiles actually on screen, for tests. */
window.__recent = function () {
  return visibleRecent().map(function (item) {
    return { label: item.label, url: item.url, host: item.host };
  });
};

function readParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch (err) {
    return null;
  }
}

function init() {
  const params = readParams();
  setChips(params ? parseChipsParam(params.get('chips')) : null);
  /* Before newtab-bg.js draws anything: its first paint is in a rAF after
     this handler, so ?bg=aurora|image means the board is never drawn. */
  applyBackground({ kind: params ? params.get('bg') : null });
  watchTheme();

  /* The empty instrument: the baseline hairlines, drawn once so a page
     nobody has pushed a sample to still reads as an instrument rather
     than as five blank rectangles. The strip is already at its full
     height either way — the boxes are sized in CSS — so this changes
     no geometry and the board's measurement stands. */
  paintStats();

  /* The canvases are a percentage of the column, so their backing store
     is wrong after a resize. One repaint, no rAF: nothing here animates. */
  window.addEventListener('resize', paintStats);

  /* The clock, before the board measures the tile it sits in: newtab-bg.js
     seats the tiles in a rAF after this handler, and an empty face would be
     the wrong size. The three listeners are the same "back on screen"
     signals the board resumes on, for the same reason. */
  paintClock();
  scheduleClock();
  document.addEventListener('visibilitychange', refreshClock);
  window.addEventListener('pageshow', refreshClock);
  window.addEventListener('focus', refreshClock);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
