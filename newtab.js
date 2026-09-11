/* ============================================================
   newtab.js — the search page's own behaviour.

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.
   ============================================================ */

'use strict';

/* Google's plain web-results mode (&udm=14). Flip to true to use it. */
const WEB_RESULTS_ONLY = false;

/* The shortcut row. Editing this array is the only step to change it. */
const LINKS = [
  { label: 'Wiki',      url: 'https://www.wikipedia.org' },
  { label: 'GitHub',    url: 'https://github.com' },
  { label: 'YouTube',   url: 'https://www.youtube.com' },
  { label: 'Gmail',     url: 'https://mail.google.com' },
  { label: 'Claude',    url: 'https://claude.ai' },
];

const SEARCH_URL = 'https://www.google.com/search?q=';

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

/** The Google URL for a query, honouring WEB_RESULTS_ONLY. */
function searchUrlFor(text) {
  return SEARCH_URL + encodeURIComponent(text) + (WEB_RESULTS_ONLY ? '&udm=14' : '');
}

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

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const form = document.getElementById('search');
const input = document.getElementById('q');
const linkRow = document.getElementById('links');

/**
 * Navigate this page (same tab).
 *
 * Theme note: the chrome may load us as newtab.html?theme=light. That query
 * must never ride along to a destination, and it cannot: every URL passed
 * here is absolute — built from SEARCH_URL, from a LINKS entry, or from what
 * was typed — and nothing on this page reads location.search or resolves a
 * relative href. Keep it that way; if a relative navigation is ever added,
 * strip the query first.
 */
function go(url) {
  if (url) window.location.assign(url);
}

/** Build the shortcut chips from LINKS. */
function renderLinks() {
  if (!linkRow) return;
  const frag = document.createDocumentFragment();

  for (const item of LINKS) {
    if (!item || !item.url) continue;
    const chip = document.createElement('a');
    chip.className = 'chip';
    chip.href = item.url;
    chip.textContent = item.label || item.url;
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

function init() {
  renderLinks();

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
