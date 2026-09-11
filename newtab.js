/* ============================================================
   newtab.js — the search page's own behaviour.

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.

   The browser's settings reach it two ways:

     1. query params, for the first paint —
        ?theme=dark&palette=ocean&hue=300&engine=duckduckgo&chips=<JSON>&bg=image
        (every param optional; theme, palette and hue are handled
        earlier, in newtab-theme.js, so colour never flashes)

     2. window.__applySettings({ accentHue, palette, searchEngine, chips })
        pushed later with executeJavaScript. A null or missing
        field means "back to this page's own default".

     3. window.__applyBackground({ kind, boardOverImage, dim, dataUrl })
        pushed the same way, because the picture is a data: URL far too
        big to hang off the URL.
   ============================================================ */

'use strict';

/* Google's plain web-results mode (&udm=14). Flip to true to use it.
   Google-only: no other engine understands the parameter. */
const WEB_RESULTS_ONLY = false;

/* The shortcut row, used whenever the browser sends no chips of its own. */
const LINKS = [
  { label: 'Wiki',      url: 'https://www.wikipedia.org' },
  { label: 'GitHub',    url: 'https://github.com' },
  { label: 'YouTube',   url: 'https://www.youtube.com' },
  { label: 'Gmail',     url: 'https://mail.google.com' },
  { label: 'Claude',    url: 'https://claude.ai' },
];

/* The engines the capsule can submit through. Key = what the chrome sends. */
const ENGINES = {
  google:     { name: 'Google',     url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=' },
  brave:      { name: 'Brave',      url: 'https://search.brave.com/search?q=' },
  startpage:  { name: 'Startpage',  url: 'https://www.startpage.com/do/search?q=' },
};

const DEFAULT_ENGINE = 'google';

/* One shared favicon service; the chip falls back to its label if it 404s. */
const FAVICON_URL = 'https://www.google.com/s2/favicons?domain=';

/* Recent sites. The chrome may hand us more than we show: we keep up to
   RECENT_ACCEPT for the typed-match dropdown, but only draw RECENT_LIMIT
   tiles under the shortcuts. */
const RECENT_ACCEPT = 8;
const RECENT_LIMIT = 6;
const SUGGEST_LIMIT = 4;

/* How long a blur waits before closing the dropdown, so a mousedown on a
   row still lands. The row's own mousedown navigates first anyway; this is
   the belt to that braces. */
const SUGGEST_BLUR_MS = 120;

/* ------------------------------------------------------------------ */
/* URL handling — the same rules as the browser's address bar          */
/* ------------------------------------------------------------------ */

// Schemes this page is willing to navigate to directly.
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);

// example.com, sub.example.co.uk:8080/path?q=1 — no whitespace, real-looking TLD.
const BARE_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d{1,5})?([\/?#]\S*)?$/i;
// localhost, localhost:3000/foo
const LOCALHOST_RE = /^localhost(:\d{1,5})?([\/?#]\S*)?$/i;
// 127.0.0.1, 192.168.1.10:8080/x
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?([\/?#]\S*)?$/;

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

/* Current engine key, and the chip list the chrome sent (null = LINKS). */
let engineKey = DEFAULT_ENGINE;
let chipList = null;

/* Validated recents, most recent first, deduped by host. [] until the
   chrome pushes some in with __applyRecent(). */
let recentList = [];

/** One host, compared the way a person would: case- and www-blind. */
function hostKey(hostname) {
  return String(hostname == null ? '' : hostname).toLowerCase().replace(/^www\./, '');
}

/** The chosen engine's record, always a real one. */
function engine() {
  return ENGINES[engineKey] || ENGINES[DEFAULT_ENGINE];
}

/** The search URL for a query. udm=14 is Google's, so only Google gets it. */
function searchUrlFor(text) {
  const extra = (WEB_RESULTS_ONLY && engineKey === 'google') ? '&udm=14' : '';
  return engine().url + encodeURIComponent(text) + extra;
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

/**
 * Recents matching what is being typed — host or title, case-insensitive.
 * Drawn from the full accepted list, not the visible tiles: a shortcut's
 * host is hidden from the row but is still worth completing.
 */
function suggestionsFor(query) {
  const text = String(query == null ? '' : query).trim().toLowerCase();
  if (!text) return [];

  const out = [];

  for (const item of recentList) {
    const hit = item.host.toLowerCase().indexOf(text) >= 0
      || item.label.toLowerCase().indexOf(text) >= 0;
    if (!hit) continue;
    out.push(item);
    if (out.length >= SUGGEST_LIMIT) break;
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

function setEngine(key) {
  const name = String(key == null ? '' : key).toLowerCase();
  engineKey = Object.prototype.hasOwnProperty.call(ENGINES, name) ? name : DEFAULT_ENGINE;
  applyPlaceholder();
}

function setChips(list) {
  chipList = normalizeChips(list);
  renderLinks();
  renderRecent();          // a new chip host may hide (or free) a recent tile
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const form = document.getElementById('search');
const input = document.getElementById('q');
const linkRow = document.getElementById('links');
const recentRow = document.getElementById('recent');
const suggestBox = document.getElementById('q-suggest');

/* What the nav currently shows, so a settings push that changes nothing
   does not rebuild the row (and re-request every favicon). */
let renderedKey = null;

/* The same trick for the recent row and the dropdown: a repeated push, or
   a keystroke that does not change the matches, leaves the DOM (and its
   favicons) exactly where it was. */
let renderedRecentKey = null;
let renderedSuggestKey = null;

/* The rows currently in the dropdown, and which one is highlighted
   (-1 = none, so Enter falls through to the normal search/navigate). */
let suggestItems = [];
let activeIndex = -1;

/**
 * Turn whatever was typed into something navigable.
 * Returns null for empty input.
 */
function toNavigationUrl(rawInput) {
  const text = String(rawInput == null ? '' : rawInput).trim();
  if (!text) return null;

  // An explicit, recognised scheme wins. Note "localhost:3000" also parses as a
  // URL (scheme "localhost:"), which is why the protocol allow-list matters.
  const parsed = parseUrlOrNull(text);
  if (parsed && NAVIGABLE_PROTOCOLS.has(parsed.protocol)) return parsed.href;

  // Bare hosts get a scheme bolted on. Loopback/LAN dev servers are almost
  // always plain http, everything else defaults to https.
  if (LOCALHOST_RE.test(text) || IPV4_RE.test(text)) return 'http://' + text;
  if (BARE_DOMAIN_RE.test(text)) return 'https://' + text;

  // Anything else is a search.
  return searchUrlFor(text);
}

/**
 * Navigate this page (same tab).
 *
 * Query note: the chrome loads us as newtab.html?theme=…&hue=…&engine=…&chips=…
 * None of that must ride along to a destination, and it cannot: every URL
 * passed here is absolute — built from an ENGINES entry, from a chip, or from
 * what was typed — and nothing resolves a relative href. Keep it that way; if
 * a relative navigation is ever added, strip the query first.
 */
function go(url) {
  if (url) window.location.assign(url);
}

/** The engine's name belongs in the field's own prompt. */
function applyPlaceholder() {
  if (!input) return;
  const text = 'Search ' + engine().name + ' or type a URL';
  input.placeholder = text;
  input.setAttribute('aria-label', text);
}

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
/* Typed-match dropdown                                                */
/* ------------------------------------------------------------------ */

/** Paint the highlight. Class only — the rows themselves never move. */
function paintActive() {
  if (!suggestBox) return;
  const rows = suggestBox.children;
  for (let i = 0; i < rows.length; i++) {
    const on = (i === activeIndex);
    rows[i].className = on ? 'sug is-active' : 'sug';
    rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function suggestOpen() {
  return !!(suggestBox && !suggestBox.hidden && suggestItems.length);
}

function closeSuggest() {
  if (!suggestBox) return;
  suggestItems = [];
  activeIndex = -1;
  renderedSuggestKey = null;
  suggestBox.hidden = true;
  suggestBox.replaceChildren(document.createDocumentFragment());
  if (input) input.setAttribute('aria-expanded', 'false');
}

/** Recompute the dropdown from the field's current text. */
function refreshSuggest() {
  if (!suggestBox || !input) return;

  const list = suggestionsFor(input.value);
  if (!list.length) {
    closeSuggest();
    return;
  }

  suggestItems = list;
  activeIndex = -1;

  const key = list.map(function (item) { return item.url; }).join('\n');
  if (key !== renderedSuggestKey) {
    renderedSuggestKey = key;

    const frag = document.createDocumentFragment();

    for (const item of list) {
      const row = document.createElement('a');
      row.className = 'sug';
      row.href = item.url;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      row.appendChild(faviconImg(item.host, 'sug-icon'));

      const title = document.createElement('span');
      title.className = 'sug-title';
      title.appendChild(document.createTextNode(item.label));
      row.appendChild(title);

      const host = document.createElement('span');
      host.className = 'sug-host';
      host.appendChild(document.createTextNode(item.key));
      row.appendChild(host);

      // mousedown, not click: the default would blur the field first and the
      // blur timer would tear the row out from under the pointer.
      row.addEventListener('mousedown', function (event) {
        event.preventDefault();
        closeSuggest();
        go(item.url);
      });
      // the navigation already happened above; don't let the href repeat it.
      row.addEventListener('click', function (event) { event.preventDefault(); });

      frag.appendChild(row);
    }

    suggestBox.replaceChildren(frag);
  }

  suggestBox.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  paintActive();
}

/** Arrow keys, Enter-on-a-row, Escape and Tab — all of it field-local. */
function onFieldKeydown(event) {
  const open = suggestOpen();

  if (event.key === 'Escape') {
    // Only swallow Escape while the dropdown is up; otherwise the page-level
    // handler still clears the field.
    if (!open) return;
    event.preventDefault();
    event.stopPropagation();
    closeSuggest();
    return;
  }

  if (event.key === 'Tab') {
    if (open) closeSuggest();
    return;
  }

  if (!open) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex = (activeIndex + 1 >= suggestItems.length) ? -1 : activeIndex + 1;
    paintActive();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex = (activeIndex - 1 < -1) ? suggestItems.length - 1 : activeIndex - 1;
    paintActive();
    return;
  }

  if (event.key === 'Enter' && activeIndex >= 0) {
    // A highlighted row wins over the form's submit; nothing highlighted
    // falls through and searches (or navigates) exactly as before.
    event.preventDefault();
    const item = suggestItems[activeIndex];
    closeSuggest();
    go(item.url);
  }
}

function onFieldInput() {
  refreshSuggest();
}

function onFieldBlur() {
  // A click on a row lands on mousedown, before this fires; the delay is
  // only so the panel does not vanish mid-press.
  setTimeout(closeSuggest, SUGGEST_BLUR_MS);
}

/** Put the caret back in the field and select what is there. */
function focusField() {
  if (!input) return;
  input.focus();
  input.select();
}

function onSubmit(event) {
  event.preventDefault();
  closeSuggest();
  const url = toNavigationUrl(input ? input.value : '');
  if (!url) return;               // empty input does nothing
  go(url);
}

function onKeydown(event) {
  if (event.key !== 'Escape') return;
  if (!input) return;
  input.value = '';
  focusField();
}

/** A click on bare page — not a chip, not the field — returns focus. */
function onPageClick(event) {
  const target = event.target;
  if (target && target.closest && target.closest('a, button, input, textarea, select')) return;
  focusField();
}

/* The accent's base colour differs per theme, so re-derive the same hue
   whenever the chrome flips data-theme on <html>. */
function watchTheme() {
  if (typeof MutationObserver !== 'function') return;

  const observer = new MutationObserver(function () {
    if (typeof window.__applyAccent === 'function') {
      window.__applyAccent(window.__accentHue ? window.__accentHue() : null);
    }
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
  setEngine(next.searchEngine);
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
  // Only if the dropdown is already up: a push must never make one appear.
  if (suggestOpen()) refreshSuggest();
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

/** What a given query would offer, for tests. */
window.__suggestions = function (query) {
  return suggestionsFor(query).map(function (item) {
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
  setEngine(params ? params.get('engine') : null);
  setChips(params ? parseChipsParam(params.get('chips')) : null);
  /* Before newtab-bg.js draws anything: its first paint is in a rAF after
     this handler, so ?bg=aurora|image means the board is never drawn. */
  applyBackground({ kind: params ? params.get('bg') : null });
  watchTheme();

  if (form) form.addEventListener('submit', onSubmit);
  if (input) {
    input.addEventListener('input', onFieldInput);
    input.addEventListener('keydown', onFieldKeydown);
    input.addEventListener('blur', onFieldBlur);
  }
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onPageClick);

  /* The clock, before the board measures the tile it sits in: newtab-bg.js
     seats the tiles in a rAF after this handler, and an empty face would be
     the wrong size. The three listeners are the same "back on screen"
     signals the board resumes on, for the same reason. */
  paintClock();
  scheduleClock();
  document.addEventListener('visibilitychange', refreshClock);
  window.addEventListener('pageshow', refreshClock);
  window.addEventListener('focus', refreshClock);

  // autofocus covers the normal load; this covers a restored/backgrounded guest.
  focusField();
  window.addEventListener('focus', focusField);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
