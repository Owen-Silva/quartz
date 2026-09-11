/* ============================================================
   newtab.js — the search page's own behaviour.

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.

   The browser's settings reach it two ways:

     1. query params, for the first paint —
        ?theme=dark&hue=300&engine=duckduckgo&chips=<JSON>
        (every param optional; theme and hue are handled earlier,
        in newtab-theme.js, so colour never flashes)

     2. window.__applySettings({ accentHue, searchEngine, chips })
        pushed later with executeJavaScript. A null or missing
        field means "back to this page's own default".
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
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const form = document.getElementById('search');
const input = document.getElementById('q');
const linkRow = document.getElementById('links');

/* What the nav currently shows, so a settings push that changes nothing
   does not rebuild the row (and re-request every favicon). */
let renderedKey = null;

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

    if (item.host) {
      const icon = document.createElement('img');
      icon.className = 'chip-icon';
      icon.src = faviconUrl(item.host);
      icon.width = 16;
      icon.height = 16;
      icon.alt = '';
      icon.loading = 'lazy';
      icon.setAttribute('aria-hidden', 'true');
      // A blocked or missing favicon must not leave a hole: drop the image,
      // keep the label, chip unchanged otherwise.
      icon.onerror = function () {
        if (icon.parentNode) icon.parentNode.removeChild(icon);
      };
      chip.appendChild(icon);
    }

    chip.appendChild(document.createTextNode(item.label));
    frag.appendChild(chip);
  }

  linkRow.replaceChildren(frag);
}

/** Put the caret back in the field and select what is there. */
function focusField() {
  if (!input) return;
  input.focus();
  input.select();
}

function onSubmit(event) {
  event.preventDefault();
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

/** The chrome pushes settings here with executeJavaScript. */
window.__applySettings = function (settings) {
  const next = settings || {};
  setEngine(next.searchEngine);
  setChips(next.chips);
  if (typeof window.__applyAccent === 'function') window.__applyAccent(next.accentHue);
};

/** The chips actually on screen, for tests. */
window.__chips = function () {
  return currentChips().map(function (item) {
    return { label: item.label, url: item.url };
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
  watchTheme();

  if (form) form.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onPageClick);

  // autofocus covers the normal load; this covers a restored/backgrounded guest.
  focusField();
  window.addEventListener('focus', focusField);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
