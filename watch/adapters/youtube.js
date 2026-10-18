'use strict';
/*
 * watch/adapters/youtube.js -- the user's own YouTube rows, read out of the pages
 * he is already signed in to in Quartz.
 *
 * Three hidden-view reads (FEASIBILITY.md section 1):
 *   home       https://www.youtube.com/               -> kind 'rec'
 *   history    https://www.youtube.com/feed/history   -> kind 'resume' (partly watched, < 95 %)
 *   watchlater https://www.youtube.com/playlist?list=WL -> kind 'watchlist' (optional)
 * Each page server-renders its first screen into window.ytInitialData; the
 * extract expression copies that tree plus ytcfg's LOGGED_IN flag. No browse
 * calls, no player endpoints.
 *
 * The renderer layer churns (videoRenderer -> richItemRenderer ->
 * lockupViewModel), so the parser walks the whole tree for every known video
 * renderer instead of following fixed paths, skips ads / playlists / mixes /
 * channels / live chat, and reads progress, length and live badges from
 * whatever overlay shape the entry carries.
 *
 * parse() never throws: any input gives { state, reason, items }.
 */
var shape = require('../shape');

var ID = 'youtube';
var BUDGET_MS = 20000;
var ORIGIN = 'https://www.youtube.com';
var RESUME_DONE = 0.95;          // >= 95 % watched counts as finished
var CAPS = { rec: 80, resume: 40, watchlist: 80, search: 20 };

var STEP_KIND = { home: 'rec', history: 'resume', watchlater: 'watchlist' };
var STEP_LABEL = { home: 'Recommended', history: 'Continue watching', watchlater: 'Watch Later' };

/*
 * Runs inside the YouTube page (executeJavaScript). One IIFE expression that
 * can never throw and returns only JSON-clonable values.
 */
var EXTRACT = [
  '(function () {',
  '  var out = { data: null, loggedIn: null, url: "", title: "" };',
  '  try { out.url = String(location.href); } catch (e) {}',
  '  try { out.title = String(document.title || ""); } catch (e) {}',
  '  try {',
  '    var c = window.ytcfg;',
  '    if (c && typeof c.get === "function") {',
  '      var v = c.get("LOGGED_IN");',
  '      if (typeof v === "boolean") out.loggedIn = v;',
  '    } else if (c && c.data_ && typeof c.data_.LOGGED_IN === "boolean") {',
  '      out.loggedIn = c.data_.LOGGED_IN;',
  '    }',
  '  } catch (e) {}',
  '  try {',
  '    var d = window.ytInitialData;',
  '    if (d && typeof d === "object") out.data = JSON.parse(JSON.stringify(d));',
  '  } catch (e) { out.dataError = String((e && e.message) || e); }',
  '  return out;',
  '})()'
].join('\n');

/* Done once the tree is there, or the page told us who we are, or it left YouTube (login redirect). */
function ready(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.data != null || x.loggedIn === false) return true;
  var u = typeof x.url === 'string' ? x.url : '';
  return !!u && !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(u);
}

function steps(ctx) {
  void ctx;
  return [
    { name: 'home', type: 'view', url: ORIGIN + '/', extract: EXTRACT, ready: ready, budgetMs: BUDGET_MS },
    { name: 'history', type: 'view', url: ORIGIN + '/feed/history', extract: EXTRACT, ready: ready, budgetMs: BUDGET_MS },
    { name: 'watchlater', type: 'view', url: ORIGIN + '/playlist?list=WL', extract: EXTRACT, ready: ready,
      budgetMs: BUDGET_MS, optional: true }
  ];
}

/* ---------------------------------------------------------------- the tree walker */

var VIDEO_KEYS = {
  videoRenderer: 1, gridVideoRenderer: 1, compactVideoRenderer: 1, playlistVideoRenderer: 1,
  reelItemRenderer: 1, shortsLockupViewModel: 1, lockupViewModel: 1
};
/* Not videos, or not the user's: skipped whole, never descended into. */
var SKIP_KEYS = {
  liveChatRenderer: 1, liveChatItemListRenderer: 1, conversationBar: 1,
  channelRenderer: 1, gridChannelRenderer: 1, channelVideoPlayerRenderer: 1,
  playlistRenderer: 1, gridPlaylistRenderer: 1, compactPlaylistRenderer: 1,
  radioRenderer: 1, compactRadioRenderer: 1, gridRadioRenderer: 1, mixRenderer: 1,
  playlistSidebarRenderer: 1, topbar: 1, statementBannerRenderer: 1, bannerPromoRenderer: 1,
  brandVideoShelfRenderer: 1, brandVideoSingletonRenderer: 1, searchPyvRenderer: 1,
  promotedSparklesWebRenderer: 1, promotedSparklesTextSearchRenderer: 1, promotedVideoRenderer: 1,
  compactPromotedVideoRenderer: 1, displayAdRenderer: 1, inFeedAdLayoutRenderer: 1, adSlotRenderer: 1
};
var AD_KEY = /^ads?[A-Z]|AdRenderer$|AdSlotRenderer$|AdLayoutRenderer$|^promoted[A-Z]|Pyv/;
var SHELF_KEYS = { richShelfRenderer: 1, shelfRenderer: 1, reelShelfRenderer: 1, itemSectionRenderer: 1 };
/* A page that is legitimately empty (history off, nothing saved), not a layout change. */
var EMPTY_KEYS = { feedNudgeRenderer: 1, messageRenderer: 1, backgroundPromoRenderer: 1 };

function isVideoId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*%?\s*$/.test(v)) return parseFloat(v);
  return null;
}
function get(o, path) {
  var cur = o;
  for (var i = 0; i < path.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[path[i]];
  }
  return cur;
}

function shelfTitle(key, node) {
  if (key === 'itemSectionRenderer') return shape.cleanText(shape.textOf(get(node, ['header', 'itemSectionHeaderRenderer', 'title'])), 120);
  return shape.cleanText(shape.textOf(node.title) || shape.textOf(get(node, ['header', 'title'])), 120);
}

/*
 * Progress, length and live state from any overlay shape inside one entry:
 * thumbnailOverlayResumePlaybackRenderer.percentDurationWatched (old),
 * thumbnailOverlayProgressBarViewModel.startPercent (lockup), time-status
 * overlays and badge view models for the length / LIVE badge.
 */
function scanEntry(node) {
  var info = { pct: null, live: false, upcoming: false, lengthText: '', shortsUrl: false };
  shape.walk(node, function (v, key) {
    if (!v || typeof v !== 'object') {
      if (key === 'url' && typeof v === 'string' && v.indexOf('/shorts/') === 0) info.shortsUrl = true;
      return true;
    }
    if (key === 'menu' || key === 'menuRenderer' || key === 'contextMenu') return false;
    if (key === 'thumbnailOverlayResumePlaybackRenderer') {
      var p = num(v.percentDurationWatched);
      if (p !== null) info.pct = p;
      return false;
    }
    if (key === 'thumbnailOverlayProgressBarViewModel') {
      var s = num(v.startPercent);
      if (s !== null && info.pct === null) info.pct = s;
      return false;
    }
    if (key === 'thumbnailOverlayTimeStatusRenderer') {
      var style = str(v.style);
      var t = shape.textOf(v.text);
      if (style === 'LIVE' || /^live$/i.test(t.trim())) info.live = true;
      else if (style === 'UPCOMING') info.upcoming = true;
      else if (!info.lengthText && shape.clockToSec(t) !== null) info.lengthText = t.trim();
      return false;
    }
    if (key === 'thumbnailBadgeViewModel') {
      var bt = shape.textOf(v.text);
      var bs = str(v.badgeStyle);
      if (/LIVE/.test(bs) || /^live$/i.test(bt.trim())) info.live = true;
      else if (/UPCOMING/.test(bs)) info.upcoming = true;
      else if (!info.lengthText && shape.clockToSec(bt) !== null) info.lengthText = bt.trim();
      return false;
    }
    if (key === 'metadataBadgeRenderer') {
      if (/LIVE_NOW/.test(str(v.style)) || /^live$/i.test(str(v.label).trim())) info.live = true;
      return false;
    }
    if (key === 'upcomingEventData') { info.upcoming = true; return false; }
    return true;
  });
  return info;
}

/* The best https i.ytimg.com thumbnail (closest to 480 wide), or YouTube's stable hqdefault. */
function pickThumb(lists, id) {
  var best = '';
  var bestScore = Infinity;
  var lastNoWidth = '';
  for (var l = 0; l < lists.length; l++) {
    var list = arr(lists[l]);
    for (var i = 0; i < list.length; i++) {
      var t = obj(list[i]);
      if (!t) continue;
      var u = shape.cleanHttps(str(t.url));
      if (!u) continue;
      var host = '';
      try { host = new URL(u).hostname; } catch (err) { host = ''; }
      if (!/(^|\.)ytimg\.com$/.test(host)) continue;
      var w = num(t.width);
      if (w === null) { lastNoWidth = u; continue; }
      var score = Math.abs(w - 480);
      if (score < bestScore) { best = u; bestScore = score; }
    }
  }
  return best || lastNoWidth || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg');
}

function joinDot(parts) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = shape.cleanText(typeof parts[i] === 'string' ? parts[i].replace(/\s*•\s*/g, ' · ') : '', 120);
    if (p && out.indexOf(p) === -1) out.push(p);
  }
  return out.join(' · ');
}

/* One renderer -> a raw ITEM (kind filled in later), or null when it is not a playable video. */
function videoFrom(key, node, group) {
  var id = '';
  var title = '';
  var channel = '';
  var tail = [];
  var thumbs = [];
  var lengthSec = null;
  var isShort = false;

  if (key === 'lockupViewModel') {
    var ct = str(node.contentType);
    if (ct && ct !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    id = str(node.contentId);
    var meta = obj(get(node, ['metadata', 'lockupMetadataViewModel'])) || {};
    title = shape.textOf(meta.title);
    var rows = arr(get(meta, ['metadata', 'contentMetadataViewModel', 'metadataRows']));
    for (var r = 0; r < rows.length; r++) {
      var parts = arr(obj(rows[r]) && rows[r].metadataParts).map(function (p) { return shape.textOf(p && p.text); });
      if (r === 0 && !channel) channel = parts[0] || '';
      else tail = tail.concat(parts);
    }
    thumbs.push(get(node, ['contentImage', 'thumbnailViewModel', 'image', 'sources']));
    thumbs.push(get(node, ['contentImage', 'collectionThumbnailViewModel', 'primaryThumbnail', 'thumbnailViewModel', 'image', 'sources']));
  } else if (key === 'shortsLockupViewModel') {
    id = str(get(node, ['onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId'])) ||
      str(node.entityId).replace(/^shorts-shelf-item-/, '');
    title = shape.textOf(get(node, ['overlayMetadata', 'primaryText'])) || str(node.accessibilityText).split(',')[0];
    tail.push(shape.textOf(get(node, ['overlayMetadata', 'secondaryText'])));
    thumbs.push(get(node, ['thumbnail', 'sources']));
    isShort = true;
  } else if (key === 'reelItemRenderer') {
    id = str(node.videoId);
    title = shape.textOf(node.headline) || shape.textOf(node.title);
    tail.push(shape.textOf(node.viewCountText));
    thumbs.push(get(node, ['thumbnail', 'thumbnails']));
    isShort = true;
  } else {
    // videoRenderer, gridVideoRenderer, compactVideoRenderer, playlistVideoRenderer
    id = str(node.videoId);
    if (node.isPlayable === false) return null;
    title = shape.textOf(node.title) || shape.textOf(node.headline);
    channel = shape.textOf(node.ownerText) || shape.textOf(node.longBylineText) || shape.textOf(node.shortBylineText);
    if (node.videoInfo) tail.push(shape.textOf(node.videoInfo));
    else tail.push(shape.textOf(node.shortViewCountText) || shape.textOf(node.viewCountText), shape.textOf(node.publishedTimeText));
    thumbs.push(get(node, ['thumbnail', 'thumbnails']));
    var ls = num(node.lengthSeconds);
    if (ls !== null) lengthSec = ls;
    var lt = shape.clockToSec(shape.textOf(node.lengthText));
    if (lengthSec === null && lt !== null) lengthSec = lt;
  }

  if (!isVideoId(id)) return null;
  title = shape.cleanText(title, 200);
  if (!title || /^\[(deleted|private) video\]$/i.test(title)) return null;

  var info = scanEntry(node);
  if (info.shortsUrl && key !== 'playlistVideoRenderer') isShort = true;
  if (lengthSec === null && info.lengthText) lengthSec = shape.clockToSec(info.lengthText);
  var progress = null;
  if (info.pct !== null) progress = Math.max(0, Math.min(1, info.pct / 100));

  var url = isShort ? ORIGIN + '/shorts/' + id : ORIGIN + '/watch?v=' + id;
  if (!isShort && progress !== null && progress > 0 && progress < RESUME_DONE && lengthSec) {
    var at = Math.floor(lengthSec * progress);
    if (at >= 1) url += '&t=' + at + 's';
  }

  // Sharpest first (maxres webp/jpg, sd, hq, then the still the page gave); the page steps down on a miss.
  var images = shape.ytThumbs(pickThumb(thumbs, id), id, isShort);

  return {
    id: ID + ':' + id,
    service: ID,
    kind: 'rec',
    title: title,
    subtitle: joinDot([channel].concat(tail)),
    image: images[0] || '',
    images: images,
    progress: progress,
    url: url,
    startsAt: null,
    durationSec: lengthSec,
    badge: info.live ? 'Live' : (info.upcoming ? 'Upcoming' : ''),
    group: group || '',
    _short: isShort
  };
}

/*
 * Walk a ytInitialData tree. out gets raw items in page order; stats counts
 * video entries seen (before filtering), ads skipped, empty-state and sign-in
 * markers.
 */
function collect(root, group, out, stats) {
  shape.walk(root, function (node, key) {
    if (typeof key === 'string' && key === 'signInEndpoint') stats.signInPrompt = true;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
    if (typeof key !== 'string' || !key) return true;
    if (SKIP_KEYS[key] || AD_KEY.test(key)) {
      if (AD_KEY.test(key)) stats.ads++;
      if (key === 'topbar') {
        // The signed-out topbar carries a Sign in button; keep that hint, skip the rest.
        shape.walk(node, function (v, k) { if (k === 'signInEndpoint') stats.topbarSignIn = true; return true; });
      }
      return false;
    }
    if (VIDEO_KEYS[key]) {
      if (key !== 'lockupViewModel' || !node.contentType || node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') stats.found++;
      var it = videoFrom(key, node, group);
      if (it) out.push(it);
      return false;
    }
    if (SHELF_KEYS[key]) {
      var t = shelfTitle(key, node);
      if (t) { collect(node, t, out, stats); return false; }
    }
    if (EMPTY_KEYS[key]) stats.empty = true;
    return true;
  });
}

function scanTree(data) {
  var out = [];
  var stats = { found: 0, ads: 0, empty: false, signInPrompt: false, topbarSignIn: false };
  collect(data, '', out, stats);
  return { items: out, stats: stats };
}

/* ---------------------------------------------------------------- reasons */

function secondsText(ms) { return Math.round(ms / 1000) + ' s'; }

function reasonForError(err, status) {
  var e = obj(err) || {};
  var code = str(e.code);
  var detail = shape.cleanText(str(e.detail), 120);
  if (code === 'timeout') return 'timed out after ' + secondsText(BUDGET_MS);
  if (code === 'offline') return "you're offline";
  if (code === 'http') return 'YouTube answered with an error' + (typeof status === 'number' && status ? ' (HTTP ' + status + ')' : (detail ? ' (' + detail + ')' : ''));
  if (code === 'load-failed') return "the page didn't load" + (detail ? ' (' + detail + ')' : '');
  if (code === 'bad-json') return "YouTube sent data the reader couldn't parse";
  if (code === 'crashed') return 'the hidden reader page crashed';
  return detail || 'the read failed';
}

function hostPath(u) {
  if (typeof u !== 'string' || !u) return null;
  try { var x = new URL(u); return { host: x.hostname.toLowerCase(), path: x.pathname }; } catch (err) { return null; }
}

/* ---------------------------------------------------------------- one step */

function readStep(step) {
  if (!step || typeof step !== 'object') return { status: 'missing', reason: '', items: [], stats: null };
  var ex = obj(step.extracted);
  var landed = [str(step.finalUrl), ex ? str(ex.url) : ''];
  for (var i = 0; i < landed.length; i++) {
    var hp = hostPath(landed[i]);
    if (!hp) continue;
    if (hp.host === 'accounts.google.com' || hp.path.indexOf('/ServiceLogin') === 0) return { status: 'signed-out', reason: '', items: [], stats: null };
    if (/^\/sorry\b/.test(hp.path) && (/(^|\.)google\.com$/.test(hp.host) || /(^|\.)youtube\.com$/.test(hp.host))) {
      return { status: 'captcha', reason: 'blocked by a captcha', items: [], stats: null };
    }
  }
  if (ex && ex.loggedIn === false) return { status: 'signed-out', reason: '', items: [], stats: null };
  if (step.error) return { status: 'error', reason: reasonForError(step.error, step.status), items: [], stats: null };
  if (!ex) {
    return { status: 'error', reason: step.ok === false ? "the page didn't load" : 'the page loaded but the reader got nothing back', items: [], stats: null };
  }
  var data = obj(ex.data) || obj(ex.ytInitialData);
  if (!data) {
    return { status: 'nodata', reason: 'the page loaded but had no ytInitialData (YouTube changed its layout?)', items: [], stats: null };
  }
  var scan = scanTree(data);
  if (ex.loggedIn !== true && (scan.stats.signInPrompt || scan.stats.topbarSignIn) && scan.items.length === 0) {
    return { status: 'signed-out', reason: '', items: [], stats: scan.stats };
  }
  if (ex.loggedIn !== true && scan.stats.topbarSignIn) return { status: 'signed-out', reason: '', items: [], stats: scan.stats };
  return { status: 'ok', reason: '', items: scan.items, stats: scan.stats };
}

function kindItems(raw, kind) {
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i];
    if (kind === 'resume') {
      if (it._short) continue;
      if (it.progress === null || !(it.progress > 0) || it.progress >= RESUME_DONE) continue;
    }
    var copy = {};
    for (var k in it) if (k !== '_short') copy[k] = it[k];
    copy.kind = kind;
    list.push(copy);
  }
  return shape.cleanItems(list, CAPS[kind]);
}

/* ---------------------------------------------------------------- parse */

function fail(reason) {
  return { state: 'error', reason: reason, items: [], profile: '' };
}

var SIGNED_OUT = { state: 'signed-out', reason: 'sign in to YouTube in Quartz to see your rows', items: [], profile: '' };

function parseInner(read) {
  if (!read || typeof read !== 'object' || !read.steps || typeof read.steps !== 'object' || Array.isArray(read.steps)) {
    return fail('the reader returned nothing it could use');
  }
  var st = {};
  var names = ['home', 'history', 'watchlater'];
  for (var i = 0; i < names.length; i++) st[names[i]] = readStep(read.steps[names[i]]);

  for (var s = 0; s < names.length; s++) {
    if (st[names[s]].status === 'signed-out') return { state: SIGNED_OUT.state, reason: SIGNED_OUT.reason, items: [], profile: '' };
  }
  if (st.home.status === 'captcha' || st.history.status === 'captcha') return fail('blocked by a captcha');

  var okNames = names.filter(function (n) { return st[n].status === 'ok'; });
  if (st.home.status !== 'ok' && st.history.status !== 'ok') {
    if (st.home.status === 'missing' && st.history.status === 'missing') return fail("the reader didn't open any YouTube page");
    if (st.home.reason && st.home.reason === st.history.reason) return fail(st.home.reason);
    return fail(st.home.reason || st.history.reason || "the reader didn't open the YouTube home page");
  }

  var found = 0;
  var empty = false;
  okNames.forEach(function (n) { found += st[n].stats.found; if (st[n].stats.empty) empty = true; });
  if (found === 0 && !empty) return fail('the page loaded but no videos matched (YouTube changed its layout?)');

  var warnings = [];
  var counts = { resume: 0, rec: 0, watchlist: 0, found: {}, adsSkipped: 0 };
  var items = [];
  ['history', 'home', 'watchlater'].forEach(function (n) {
    var r = st[n];
    if (r.status === 'ok') {
      var got = kindItems(r.items, STEP_KIND[n]);
      counts[STEP_KIND[n]] = got.length;
      counts.found[n] = r.stats.found;
      counts.adsSkipped += r.stats.ads;
      items = items.concat(got);
      if (r.stats.found === 0 && !r.stats.empty) {
        warnings.push(STEP_LABEL[n] + ': the page loaded but no ' + STEP_LABEL[n] + ' data matched (YouTube changed its layout?)');
      }
    } else if (r.status === 'missing') {
      if (n !== 'watchlater') warnings.push(STEP_LABEL[n] + ': not read');
    } else {
      warnings.push(STEP_LABEL[n] + ': ' + (r.reason || 'the read failed'));
    }
  });
  if (items.length === 0 && empty) warnings.push('YouTube shows no videos here (watch history may be off)');
  return { state: 'ok', reason: '', items: items, profile: '', counts: counts, warnings: warnings };
}

function parse(read, ctx) {
  void ctx;
  try {
    return parseInner(read);
  } catch (err) {
    return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')');
  }
}

/* ---------------------------------------------------------------- search */

function searchUrl(q) {
  var text = shape.cleanText(typeof q === 'string' ? q : (q == null ? '' : String(q)), 200);
  return ORIGIN + '/results?search_query=' + encodeURIComponent(text).replace(/%20/g, '+');
}

/* From an opening '{' at i, the index just past its matching '}' (strings and escapes respected), or -1. */
function matchBraces(s, i) {
  var depth = 0;
  var inStr = '';
  for (var j = i; j < s.length; j++) {
    var c = s.charCodeAt(j);
    if (inStr) {
      if (c === 92) { j++; continue; }               // backslash: skip the next char
      if (s[j] === inStr) inStr = '';
      continue;
    }
    if (c === 34) inStr = '"';
    else if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

/* var ytInitialData = '\x7b\x22...'  (the hex-escaped string form some YouTube pages use) */
function readJsString(s, i) {
  var q = s[i];
  var out = '';
  for (var j = i + 1; j < s.length; j++) {
    var c = s[j];
    if (c === q) return out;
    if (c !== '\\') { out += c; continue; }
    var n = s[++j];
    if (n === 'x') { out += String.fromCharCode(parseInt(s.substr(j + 1, 2), 16)); j += 2; }
    else if (n === 'u') { out += String.fromCharCode(parseInt(s.substr(j + 1, 4), 16)); j += 4; }
    else if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else out += n;
  }
  return null;
}

function findInitialData(html) {
  if (typeof html !== 'string' || !html) return null;
  if (html.length > 20 * 1024 * 1024) html = html.slice(0, 20 * 1024 * 1024);
  var re = /(?:var\s+ytInitialData|window\s*\[\s*["']ytInitialData["']\s*\]|window\.ytInitialData)\s*=\s*/g;
  var m;
  var tries = 0;
  while ((m = re.exec(html)) && tries++ < 20) {
    var at = m.index + m[0].length;
    var ch = html[at];
    try {
      if (ch === '{') {
        var end = matchBraces(html, at);
        if (end > at) {
          var v = JSON.parse(html.slice(at, end));
          if (v && typeof v === 'object') return v;
        }
        var stop = html.indexOf(';</script>', at);
        if (stop > at) {
          var v2 = JSON.parse(html.slice(at, stop));
          if (v2 && typeof v2 === 'object') return v2;
        }
      } else if (ch === "'" || ch === '"') {
        var text = readJsString(html, at);
        if (text) {
          var v3 = JSON.parse(text);
          if (v3 && typeof v3 === 'object') return v3;
        }
      }
    } catch (err) { /* a decoy; try the next match */ }
  }
  return null;
}

function parseSearch(html) {
  try {
    var data = findInitialData(html);
    if (!data) return [];
    var scan = scanTree(data);
    return kindItems(scan.items, 'search').slice(0, CAPS.search);
  } catch (err) {
    return [];
  }
}

module.exports = {
  id: ID,
  steps: steps,
  parse: parse,
  searchUrl: searchUrl,
  parseSearch: parseSearch,
  // for the tests and the lead's mock server
  _internals: { EXTRACT: EXTRACT, ready: ready, findInitialData: findInitialData, scanTree: scanTree, reasonForError: reasonForError }
};
