'use strict';
// faviconstore.js — the tab strip's per-origin favicon cache, in main.
//
// Why it exists (requested 2026-10-14: "logos need to always be there and be more
// reliable half the time they arent even there"). A chip used to point its
// <img> at whatever URL the page last reported, and that URL was forgotten the
// moment the page went away: a tab restored after a restart, or born asleep in
// a background workspace, has no guest and so never reported anything — the
// chip came up with no logo at all. This module remembers ONE small icon per
// origin (https://discord.com), on disk, so a chip can show its logo the
// instant it is built, before any page has loaded or even exists.
//
// Shape of the store:
//   - keyed by origin ("scheme://host[:port]"), http and https only;
//   - each entry { src, data, at, used }: the icon URL it came from, the
//     normalised image as a data: URL (a 32px PNG, or the site's own small SVG),
//     when it was fetched and when a chip last asked for it;
//   - bounded twice: at most `maxEntries` origins and `maxBytes` of data in all,
//     least recently USED dropped first; one entry may be at most
//     `maxEntryBytes`, so one site cannot crowd out the rest;
//   - persisted as one JSON file in userData, written atomically (tmp + rename)
//     on a debounce after a put, and synchronously on quit. A read never writes:
//     the LRU order rides along with the next put or the quit flush.
//
// It also fetches icon bytes for the chrome (fetchIcon): main can read any
// origin without CORS and through the session the pages themselves use, so a
// favicon behind the site's own cookies still arrives. Only http(s) URLs, a
// timeout, a byte cap, at most `maxConcurrent` fetches at once, and the answer
// is sniffed rather than trusted: an HTML "soft 404" is a failure with a reason,
// never an image. No third-party favicon service is ever asked (privacy).
//
// Pure node: everything Electron-specific is passed in, so the harness drives
// it with a fake fetch and a temp directory.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'favicon-cache.json';
const VERSION = 1;

const DEFAULTS = {
  maxEntries: 400,
  maxBytes: 1536 * 1024,      // 1.5 MB of data: URLs in all
  maxEntryBytes: 48 * 1024,   // one site's icon, as a data: URL
  maxFetchBytes: 512 * 1024,  // the raw download, before normalising
  fetchTimeoutMs: 8000,
  maxConcurrent: 4,
  saveDelayMs: 1500
};

const ORIGIN_RE = /^https?:\/\/[^/?#\s]+$/i;

/** "https://www.x.com/home?a" -> "https://www.x.com"; null for anything not http(s). */
function originOf(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin.toLowerCase();
}

/** A data: URL the chip may wear: an image, base64 or (svg) utf8, and not huge. */
function isImageDataUrl(s, cap) {
  return typeof s === 'string' && s.length <= cap && /^data:image\/(png|svg\+xml|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/i.test(s);
}

/**
 * What the bytes really are. Content-Type is a hint at best: plenty of sites
 * serve favicon.ico as text/plain or application/octet-stream, and a missing
 * favicon is often a 200 HTML page.
 * @returns {string|null} an image mime, or null when it is not an image
 */
function sniffMime(buf, contentType) {
  if (!buf || !buf.length) return null;
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('ascii', 0, 6).indexOf('GIF8') === 0) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  // Text: SVG or not an image at all. Look at the head only.
  const head = b.toString('utf8', 0, Math.min(b.length, 1024)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!--') || head.startsWith('<!doctype svg')) && head.indexOf('<svg') !== -1)) {
    return 'image/svg+xml';
  }
  const ct = String(contentType || '').toLowerCase();
  if (ct.indexOf('svg') !== -1 && head.indexOf('<svg') !== -1) return 'image/svg+xml';
  return null;
}

function create(options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const dir = opts.dir;
  const file = dir ? path.join(dir, FILE_NAME) : null;
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /** origin -> entry. Map order IS the LRU order: oldest use first. */
  const entries = new Map();
  let bytes = 0;
  let dirty = false;      // content changed: a debounced write is owed
  let orderDirty = false; // only the LRU order moved: written with the next write or on quit
  let saveTimer = null;
  let loadError = null;
  let lastSaveError = null;

  let active = 0;
  const queue = [];
  const stats = { fetches: 0, fetchFailures: 0, puts: 0, evictions: 0, saves: 0 };

  function sizeOf(e) { return (e.data ? e.data.length : 0) + (e.src ? e.src.length : 0) + 64; }

  function drop(origin) {
    const e = entries.get(origin);
    if (!e) return;
    bytes -= sizeOf(e);
    entries.delete(origin);
  }

  function evict() {
    while (entries.size > opts.maxEntries || bytes > opts.maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
      stats.evictions++;
    }
  }

  function validEntry(origin, e) {
    return ORIGIN_RE.test(origin) && e && typeof e === 'object'
      && isImageDataUrl(e.data, opts.maxEntryBytes)
      && (typeof e.src === 'string' && e.src.length <= 2048);
  }

  function load() {
    if (!file) return;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && err.code !== 'ENOENT') loadError = 'could not read the favicon cache: ' + err.message;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      loadError = 'the favicon cache was not valid JSON, starting empty';
      return;
    }
    const list = parsed && parsed.v === VERSION && Array.isArray(parsed.entries) ? parsed.entries : [];
    // Stored oldest-used first, so inserting in file order rebuilds the LRU.
    for (const row of list) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const origin = String(row[0]).toLowerCase();
      const e = row[1];
      if (!validEntry(origin, e)) continue;
      drop(origin);
      const clean = { src: e.src, data: e.data, at: Number(e.at) || 0, used: Number(e.used) || 0 };
      entries.set(origin, clean);
      bytes += sizeOf(clean);
    }
    evict();
  }

  function serialise() {
    const out = [];
    for (const [origin, e] of entries) out.push([origin, { src: e.src, data: e.data, at: e.at, used: e.used }]);
    return JSON.stringify({ v: VERSION, entries: out });
  }

  function writeNow() {
    if (!file || (!dirty && !orderDirty)) return;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, serialise());
      fs.renameSync(tmp, file);
      dirty = false;
      orderDirty = false;
      lastSaveError = null;
      stats.saves++;
    } catch (err) {
      lastSaveError = 'could not save the favicon cache: ' + (err && err.message);
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
    }
  }

  function scheduleSave() {
    dirty = true;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, opts.saveDelayMs);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /**
   * The cached icons for a batch of origins (or page urls: each is reduced to
   * its origin). Every origin asked about gets a key; null = nothing cached.
   * A hit moves to the young end of the LRU.
   */
  function get(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    const t = now();
    for (const item of list.slice(0, 256)) {
      const origin = ORIGIN_RE.test(String(item)) ? String(item).toLowerCase() : originOf(item);
      if (!origin) continue;
      const e = entries.get(origin);
      if (!e) { out[origin] = null; continue; }
      entries.delete(origin);
      e.used = t;
      entries.set(origin, e);
      orderDirty = true;
      out[origin] = { src: e.src, data: e.data, at: e.at };
    }
    return out;
  }

  /** Remember one origin's icon. Returns false (with the reason) when refused. */
  function put(originOrUrl, entry) {
    const origin = ORIGIN_RE.test(String(originOrUrl)) ? String(originOrUrl).toLowerCase() : originOf(originOrUrl);
    if (!origin) return { ok: false, reason: 'not an http(s) origin' };
    const e = entry && typeof entry === 'object' ? entry : {};
    const clean = { src: typeof e.src === 'string' ? e.src.slice(0, 2048) : '', data: e.data, at: now(), used: now() };
    if (!isImageDataUrl(clean.data, opts.maxEntryBytes)) {
      return { ok: false, reason: 'not an image data: URL, or larger than ' + opts.maxEntryBytes + ' bytes' };
    }
    const prev = entries.get(origin);
    // The same picture again is only a touch: no write for a page that keeps
    // reporting the icon it already has.
    if (prev && prev.data === clean.data && prev.src === clean.src) {
      entries.delete(origin);
      prev.used = clean.used;
      prev.at = clean.at;
      entries.set(origin, prev);
      return { ok: true, unchanged: true };
    }
    drop(origin);
    entries.set(origin, clean);
    bytes += sizeOf(clean);
    stats.puts++;
    evict();
    scheduleSave();
    return { ok: true };
  }

  function pump() {
    while (active < opts.maxConcurrent && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.run).then(job.resolve, (err) => job.resolve({ ok: false, reason: String(err && err.message || err) }))
        .then(() => { active--; pump(); });
    }
  }

  async function doFetch(url) {
    stats.fetches++;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, opts.fetchTimeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller ? controller.signal : undefined, redirect: 'follow' });
      if (!res || !res.ok) return { ok: false, reason: 'HTTP ' + (res ? res.status : 'no response') };
      const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
      if (len && len > opts.maxFetchBytes) return { ok: false, reason: 'icon too large (' + len + ' bytes)' };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, reason: 'empty response' };
      if (buf.length > opts.maxFetchBytes) return { ok: false, reason: 'icon too large (' + buf.length + ' bytes)' };
      const ct = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
      const mime = sniffMime(buf, ct);
      if (!mime) return { ok: false, reason: 'not an image (' + (ct || 'no content-type') + ')' };
      return { ok: true, mime, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
      return { ok: false, reason: aborted ? 'timed out after ' + opts.fetchTimeoutMs + ' ms' : String(err && err.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The raw bytes of one icon URL, as a data: URL of its sniffed type.
   * @returns {Promise<{ok:true, mime, dataUrl}|{ok:false, reason}>}
   */
  function fetchIcon(url) {
    if (!fetchImpl) return Promise.resolve({ ok: false, reason: 'no fetch available' });
    let parsed;
    try { parsed = new URL(String(url)); } catch { return Promise.resolve({ ok: false, reason: 'not a URL' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Promise.resolve({ ok: false, reason: 'only http(s) icons are fetched' });
    }
    return new Promise((resolve) => {
      queue.push({ run: () => doFetch(parsed.href), resolve: (r) => { if (!r || !r.ok) stats.fetchFailures++; resolve(r); } });
      pump();
    });
  }

  function flushSync() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeNow();
  }

  function describe() {
    return {
      entries: entries.size, bytes, maxEntries: opts.maxEntries, maxBytes: opts.maxBytes,
      file, loadError, lastSaveError, active, queued: queue.length, stats: Object.assign({}, stats)
    };
  }

  load();
  return { get, put, fetchIcon, flushSync, describe };
}

module.exports = { create, originOf, sniffMime, isImageDataUrl, FILE_NAME, DEFAULTS };
