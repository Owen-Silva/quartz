'use strict';
/*
 * watch/adapters/prime.js -- Prime Video rows for Watch.
 *
 * One hidden reader view loads https://www.primevideo.com/ on Quartz's default
 * session (The user's own sign-in) and reads the page state Prime Video embeds in
 * the HTML. No extra request is made: the page makes the same calls it always
 * does, and the reader only looks at what the page already shipped.
 *
 * What the page carries (seen on the public, logged-out home, 2026-10-16):
 *   <script id="dv-web-page-hydration-data" type="application/json">
 *     { init: { path: '/storefront', preparations: { body: { containers: [
 *         { containerType: 'StandardHero' | 'StandardCarousel' | 'BeardSupportedCarousel',
 *           title: 'Mystery and thriller movies', text, isContinueWatching: false,
 *           entitlementCues: { entitledCarousel: 'Entitled'|'Mixed'|'NotEntitled', offerType },
 *           entities: [ { titleID: 'B0C4XHFFDH', title, displayTitle, entityType: 'Movie'|'TV Show',
 *             widgetType: 'TitleCard'|'HeroTitle'|'LinearStationCard',
 *             link: { url: '/detail/0JP3YPUKPPI2J2DUBNLKW6Z9KH?ref_=..' },
 *             images: { cover: { url: 'https://m.media-amazon.com/..._UR1920,1080_..' } | hero | titleLogo },
 *             entitlementCues: { entitlementType: 'Entitled'|'Unentitled',
 *               focusMessage: { message: 'Available to rent or buy' | 'Free trial of Apple TV' | .. } },
 *             releaseYear: '2009', runtime: '1 h 42 min',
 *             watchlistAction: { endpoint: { partialURL: '/auth-redirect', query: { signin: '1' } } } } ] } ] } } } }
 *   <script id="dv-web-global-store-data" type="application/json">
 *     { RequestContext: { customerID: null, identityContext: '68|<base64 ..PVICS_UNAUTHENTICATED..>' },
 *       Profile: { ageGroup: 'ADULT', isChild: false } }
 *   and a nav link a[data-testid="pv-nav-sign-in"] -> /auth-redirect?signin=1.
 * The signed-in rows (Continue watching, Watchlist) and their progress fields
 * are NOT verified (no account was used): the parser walks the tree, matches
 * rows by the isContinueWatching flag or by title text, and looks for progress
 * under several plausible names. A row it cannot place is a 'rec' row.
 *
 * The hydration blob is big (4.4 MB logged out, mostly live-TV schedules and
 * debug data), so the page-side extract parses it in the page and drops the
 * heavy keys this parser never reads before handing it over IPC.
 */

var shape = require('../shape');

var ORIGIN = 'https://www.primevideo.com';
var BUDGET_MS = 20000;
var SETTLE_MS = 1500;
var REC_PER_ROW = 25;
var REC_TOTAL = 300;

var REASON_SIGNED_OUT = 'sign in to Prime Video in Quartz to see your rows';
var REASON_ROBOT = 'Amazon showed a robot check; open Prime Video once in Quartz to clear it';
var REASON_CHANGED = 'the page loaded but no Continue Watching data matched (Prime Video changed its layout?)';
var REASON_NO_DATA = 'the page loaded but its page data was missing (Prime Video changed its layout?)';
var REASON_NOT_JSON = 'the page data could not be read (it was not valid JSON)';
var REASON_TOO_BIG = 'the page data was too big to read';
var REASON_NOTHING = 'the reader returned nothing';

/* ------------------------------------------------------------- page side */

/*
 * Runs INSIDE the hidden reader page (serialised with toString, so it must not
 * touch anything outside itself). Returns a small JSON-clonable object and
 * never throws.
 */
function pageExtract() {
  var CAP = 3000000;
  var STORE_CAP = 500000;
  var LONG_STRING = 4000;
  var DROP = {
    modelDebug: 1, station: 1, schedule: 1, impressionData: 1, itemAnalytics: 1, refMarker: 1,
    strings: 1, journeyIngressContext: 1, paginationServiceToken: 1, paginationTargetId: 1,
    serviceToken: 1, token: 1, queryParameters: 1, playbackEnvelope: 1, playbackExperienceMetadata: 1,
    featureSwitches: 1, degradations: 1, maturityRatingBadge: 1, customerReviews: 1, hoverInfo: 1,
    overflowMenu: 1, inlineContainerUpdateActions: 1, stationDetailLink: 1, synopsis: 1
  };
  function prune(v, depth) {
    if (depth > 90) return null;
    if (typeof v === 'string') return v.length > LONG_STRING ? '' : v;
    if (!v || typeof v !== 'object') return v;
    var i;
    if (Array.isArray(v)) {
      var arr = [];
      for (i = 0; i < v.length; i++) arr.push(prune(v[i], depth + 1));
      return arr;
    }
    var o = {};
    var keys = Object.keys(v);
    for (i = 0; i < keys.length; i++) {
      if (DROP[keys[i]] === 1) continue;
      o[keys[i]] = prune(v[keys[i]], depth + 1);
    }
    return o;
  }
  var out = {
    hydration: null, store: null, url: '', title: '', robot: false, signedIn: null,
    signInPage: false, complete: false, hydrationBytes: 0, trimmed: false, tooBig: false
  };
  try {
    var loc = (typeof location !== 'undefined' && location) ? location : {};
    var doc = (typeof document !== 'undefined' && document) ? document : null;
    out.url = String(loc.href || '');
    var path = String(loc.pathname || '');
    if (!doc) return out;
    out.title = String(doc.title || '');
    out.complete = doc.readyState === 'complete';
    var q = function (sel) { try { return doc.querySelector(sel); } catch (e) { return null; } };
    var hEl = doc.getElementById ? doc.getElementById('dv-web-page-hydration-data') : null;
    var sEl = doc.getElementById ? doc.getElementById('dv-web-global-store-data') : null;
    var hText = hEl ? String(hEl.textContent || '') : '';
    var sText = sEl ? String(sEl.textContent || '') : '';
    if (hText) {
      out.hydrationBytes = hText.length;
      var parsed;
      var slim = null;
      try { parsed = JSON.parse(hText); slim = JSON.stringify(prune(parsed, 0)); } catch (e) { slim = null; }
      if (slim !== null) {
        out.trimmed = true;
        if (slim.length > CAP) out.tooBig = true; else out.hydration = slim;
      } else {
        out.hydration = hText.slice(0, 65536);
      }
    }
    if (sText) {
      if (sText.length > STORE_CAP) out.store = null; else out.store = sText;
      try {
        var st = JSON.parse(sText);
        var rc = st && st.RequestContext;
        if (rc && typeof rc.customerID === 'string' && rc.customerID) out.signedIn = true;
        else if (rc && rc.customerID === null) out.signedIn = false;
      } catch (e) { /* the parser reports it */ }
    }
    if (out.signedIn === null && q('[data-testid="pv-nav-sign-in"]')) out.signedIn = false;
    out.signInPage = /\/ap\/(signin|mfa|cvf)|\/auth-redirect/i.test(path) || !!q('form[name="signIn"]') || !!q('#ap_email');
    var robot = /validateCaptcha/i.test(path) || /robot check/i.test(out.title) ||
      !!q('form[action*="validateCaptcha"]') || !!q('#captchacharacters') || !!q('#aws-waf-token') ||
      !!q('.amzn-captcha-modal');
    if (!robot && !hEl) {
      var body = '';
      try { body = String((doc.body && doc.body.textContent) || '').slice(0, 20000); } catch (e) { body = ''; }
      robot = out.title === 'Amazon.com' ||
        /enter the characters you see below|type the characters you see in this image|make sure you're not a robot|confirm (that )?you are human/i.test(body);
    }
    out.robot = !!robot;
  } catch (err) {
    out.error = String((err && err.message) || err).slice(0, 200);
  }
  return out;
}

var EXTRACT = '(' + pageExtract.toString() + ')()';

function ready(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  return !!(x.hydration || x.tooBig || x.robot || x.signInPage || x.complete);
}

function steps(ctx) {
  return [
    { name: 'home', type: 'view', url: ORIGIN + '/', extract: EXTRACT, ready: ready,
      settleMs: SETTLE_MS, budgetMs: BUDGET_MS }
  ];
}

/* ----------------------------------------------------------------- helpers */

function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }

/* textOf plus Prime's own { attrs, string } text shape. */
function textOf(v) {
  if (v && typeof v === 'object' && typeof v.string === 'string') return v.string;
  if (v && typeof v === 'object' && typeof v.message === 'string') return v.message;
  try { return shape.textOf(v); } catch (err) { return ''; }
}

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*%?\s*$/.test(v)) return parseFloat(v);
  return null;
}

function urlParts(u) {
  if (typeof u !== 'string' || !u) return null;
  try { var x = new URL(u, ORIGIN); return { host: x.hostname.toLowerCase(), path: x.pathname }; } catch (err) { return null; }
}

/* "1 h 42 min" / "42 min" / "1h 5m" -> seconds, or null. */
function runtimeToSec(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) return v > 100000 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v !== 'string') return null;
  var h = v.match(/(\d+)\s*h/i);
  var m = v.match(/(\d+)\s*m/i);
  if (!h && !m) return shape.clockToSec(v);
  return (h ? (+h[1]) * 3600 : 0) + (m ? (+m[1]) * 60 : 0) || null;
}

function parseJsonish(v) {
  if (v && typeof v === 'object') return { ok: true, value: v };
  if (typeof v !== 'string' || !v.trim()) return { ok: false, empty: true };
  try { return { ok: true, value: JSON.parse(v) }; } catch (err) { return { ok: false, empty: false }; }
}

/* base64 -> latin1 text, or '' (main has Buffer; a browser has atob). */
function b64(s) {
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('latin1');
    if (typeof atob === 'function') return atob(s);
  } catch (err) { /* fall through */ }
  return '';
}

/*
 * Is the store signed in? true / false / null (cannot tell).
 * RequestContext.customerID is null on the public page (seen); a signed-in
 * page is expected to carry the customer id there (inferred). identityContext
 * decodes to a protobuf naming PVICS_UNAUTHENTICATED on the public page (seen).
 */
function storeAuth(store) {
  var s = obj(store);
  if (!s) return null;
  var rc = obj(s.RequestContext) || obj(s.requestContext);
  if (!rc) return null;
  if (typeof rc.customerID === 'string' && rc.customerID.trim()) return true;
  var ic = str(rc.identityContext);
  if (ic) {
    var payload = ic.indexOf('|') !== -1 ? ic.slice(ic.indexOf('|') + 1) : ic;
    var decoded = b64(payload) + ' ' + ic;
    if (/UNAUTHENTICATED/i.test(decoded)) return false;
    if (/AUTHENTICATED/i.test(decoded)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(rc, 'customerID') && rc.customerID === null) return false;
  return null;
}

/* The active profile's name, only when the store names it outright (field names inferred). */
function profileName(store) {
  var s = obj(store);
  if (!s) return '';
  var cands = [obj(s.Profile), obj(s.profile), obj(s.ActiveProfile), obj(s.activeProfile), obj(s.CurrentProfile)];
  for (var i = 0; i < cands.length; i++) {
    var p = cands[i];
    if (!p) continue;
    var n = str(p.name) || str(p.profileName) || str(p.displayName) || textOf(p.name);
    if (n && n.trim()) return n.trim();
  }
  return '';
}

/* ------------------------------------------------------------- containers */

var DECOY_CONTAINER = /hero|banner|billboard|promo|masthead|spotlight|sponsor|advert|brand|interstitial|tentpole/i;
var DECOY_WIDGET = /hero|banner|billboard|promo|sponsor|advert|station|linear/i;
var PLACEHOLDER_TITLES = { 'carousel title': 1 };

function containerTitle(c) {
  var t = textOf(c.title);
  if (!t || PLACEHOLDER_TITLES[t.trim().toLowerCase()]) t = textOf(c.text);
  if (!t || PLACEHOLDER_TITLES[t.trim().toLowerCase()]) t = textOf(c.headerText) || textOf(c.displayTitle);
  if (t && PLACEHOLDER_TITLES[t.trim().toLowerCase()]) t = '';
  return shape.cleanText(t, 120);
}

function containerKind(c, title) {
  if (c.isContinueWatching === true) return 'resume';
  if (/^\s*(continue|keep|resume) watching\b/i.test(title)) return 'resume';
  if (/watchlist|^\s*my stuff\b/i.test(title) || /watchlist/i.test(str(c.containerType))) return 'watchlist';
  return 'rec';
}

/* Every { containerType, entities[] } in a tree, in page order. */
function findContainers(root) {
  var found = [];
  try {
    shape.walk(root, function (node) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
      if (typeof node.containerType === 'string' && Array.isArray(node.entities)) {
        found.push(node);
        return false;
      }
      return true;
    });
  } catch (err) { /* a tolerant parser keeps what it found */ }
  return found;
}

/* Any sign-in call-to-action in the hydration (watchlist buttons point at /auth-redirect?signin=1 when signed out). */
function hasSignInCta(root) {
  var hit = false;
  try {
    shape.walk(root, function (node, key) {
      if (hit) return false;
      if (typeof node === 'string') {
        if (node.indexOf('/auth-redirect') === 0 && /[?&]signin=1/.test(node)) hit = true;
        return true;
      }
      if (node && typeof node === 'object' && !Array.isArray(node) && node.partialURL === '/auth-redirect') {
        var qq = obj(node.query);
        if (!qq || String(qq.signin) === '1') hit = true;
      }
      return true;
    });
  } catch (err) { /* keep what we have */ }
  return hit;
}

/* --------------------------------------------------------------- entities */

/* Bounded search of an entity for keys matching a test; skips the heavy, irrelevant subtrees. */
var SKIP_KEYS = { itemAnalytics: 1, impressionData: 1, refMarker: 1, modelDebug: 1, station: 1, schedule: 1,
  overflowMenu: 1, watchlistAction: 1, images: 1, link: 1, customerReviews: 1, maturityRatingBadge: 1, strings: 1 };

function collect(entity, test, maxDepth) {
  var out = [];
  (function rec(v, depth, parentKey) {
    if (out.length > 40 || depth > maxDepth || !v || typeof v !== 'object') return;
    var keys = Array.isArray(v) ? null : Object.keys(v);
    if (!keys) {
      for (var i = 0; i < v.length && i < 20; i++) rec(v[i], depth + 1, parentKey);
      return;
    }
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (SKIP_KEYS[key] === 1) continue;
      var val = v[key];
      if (test(key, val, parentKey)) out.push({ key: key, value: val, parent: v, parentKey: parentKey });
      if (val && typeof val === 'object') rec(val, depth + 1, key);
    }
  })(entity, 0, '');
  return out;
}

var PCT_STRICT = /^(percentComplete|percentWatched|progressPercent|progressPercentage|watchedPercentage|completionPercentage|completionPercent|percentageWatched)$/i;
var PCT_GENERIC = /^(percentage|percent|value)$/i;
var PCT_PARENT = /progress|watch|playback|resume|complet|bookmark/i;
/* A percent field: a progress-specific name anywhere, or a generic one inside a progress-ish object. */
var PCT_KEY = { test: function (key, parentKey) {
  return PCT_STRICT.test(key) || (PCT_GENERIC.test(key) && PCT_PARENT.test(parentKey || ''));
} };
var FRAC_KEY = /^(progress|watchProgress|playbackProgress|progressFraction|completionRatio|fractionWatched|watchedFraction|progressRatio)$/i;
var POS_KEY = /^(timecode|timecodeSeconds|timecodeSec|timecodeMs|timecodeMillis|positionSeconds|positionMs|resumePosition|resumePositionSeconds|resumePositionMs|playbackPosition|playbackPositionMs|watchedSeconds|watchedMs|offsetSeconds|bookmarkSeconds|bookmarkPosition|bookmark)$/i;
var LEN_KEY = /^(runtimeSeconds|runtimeSec|runtimeMs|runtimeMillis|durationSeconds|durationSec|durationMs|durationMillis|duration|lengthSeconds|totalSeconds|runtime)$/i;
var REM_KEY = /^(remainingSeconds|remainingTimeInSeconds|timeRemainingSeconds|secondsRemaining|remainingTimeSeconds)$/i;

function seconds(key, value) {
  var n = num(value);
  if (n === null) return typeof value === 'string' ? runtimeToSec(value) : null;
  if (/ms$|millis$/i.test(key)) return n / 1000;
  return n;
}

/* 0..1, or null. Tolerant: the field name for watch progress on Prime's signed-in home is not verified. */
function progressOf(entity) {
  var hits = collect(entity, function (key, val, parentKey) {
    return PCT_KEY.test(key, parentKey) || FRAC_KEY.test(key) || POS_KEY.test(key) || LEN_KEY.test(key) || REM_KEY.test(key);
  }, 4);
  var i, h, n;
  for (i = 0; i < hits.length; i++) {
    h = hits[i];
    if (PCT_KEY.test(h.key, h.parentKey)) {
      n = num(h.value);
      if (n !== null && n >= 0 && n <= 100) return n / 100;
    }
  }
  for (i = 0; i < hits.length; i++) {
    h = hits[i];
    if (!FRAC_KEY.test(h.key)) continue;
    if (h.value && typeof h.value === 'object') continue;   // { progress: { percentage } } handled above
    n = num(h.value);
    if (n === null || n < 0) continue;
    if (typeof h.value === 'string' && /%/.test(h.value)) return Math.min(1, n / 100);
    if (n <= 1) return n;
    if (n <= 100) return n / 100;
  }
  var pos = null, len = null, rem = null;
  for (i = 0; i < hits.length; i++) {
    h = hits[i];
    if (pos === null && POS_KEY.test(h.key)) pos = seconds(h.key, h.value);
    else if (rem === null && REM_KEY.test(h.key)) rem = seconds(h.key, h.value);
    else if (len === null && LEN_KEY.test(h.key)) len = seconds(h.key, h.value);
  }
  if (len && len > 0) {
    if (pos !== null && pos >= 0) return Math.max(0, Math.min(1, pos / len));
    if (rem !== null && rem >= 0) return Math.max(0, Math.min(1, 1 - rem / len));
  }
  return null;
}

function durationOf(entity) {
  var direct = ['runtimeSeconds', 'durationSeconds', 'runtimeMs', 'durationMs'];
  for (var i = 0; i < direct.length; i++) {
    var n = num(entity[direct[i]]);
    if (n !== null && n > 0) return /Ms$/.test(direct[i]) ? Math.round(n / 1000) : Math.round(n);
  }
  return runtimeToSec(entity.runtime);
}

var IMAGE_ORDER = ['cover', 'heroImage', 'background', 'backgroundImage', 'hero', 'landscape', 'boxart', 'packshot',
  'poster2x3', 'poster', 'thumbnail'];

function amazonImage(u) {
  var clean = shape.cleanHttps(u);
  if (!clean) return '';
  var host = urlParts(clean);
  if (!host) return '';
  return /(^|\.)media-amazon\.com$|(^|\.)ssl-images-amazon\.com$/.test(host.host) ? clean : '';
}

function imageOf(entity) {
  var imgs = obj(entity.images);
  if (imgs) {
    for (var i = 0; i < IMAGE_ORDER.length; i++) {
      var im = imgs[IMAGE_ORDER[i]];
      var u = amazonImage(typeof im === 'string' ? im : (obj(im) ? str(im.url) : ''));
      if (u) return u;
    }
    var keys = Object.keys(imgs);
    for (var k = 0; k < keys.length; k++) {
      if (/logo|icon|badge/i.test(keys[k])) continue;
      var v = imgs[keys[k]];
      var u2 = amazonImage(typeof v === 'string' ? v : (obj(v) ? str(v.url) : ''));
      if (u2) return u2;
    }
  }
  return amazonImage(str(entity.image)) || amazonImage(str(entity.imageUrl));
}

/* The id the title page answers to: the link's own /detail/<id>, else titleID, else a gti. */
function detailIdOf(entity) {
  var link = obj(entity.link);
  var href = link ? str(link.url) : str(entity.link);
  var p = urlParts(href);
  if (p && /(^|\.)primevideo\.com$|(^|\.)amazon\.[a-z.]+$/.test(p.host)) {
    var m = p.path.match(/\/detail\/(?:[^/]+\/)?([A-Za-z0-9.\-]{8,80})\/?/);
    if (m && !/^ref=/.test(m[1])) return m[1];
  }
  var tid = str(entity.titleID) || str(entity.titleId) || str(entity.asin);
  if (/^[A-Za-z0-9.\-]{8,80}$/.test(tid)) return tid;
  var gti = str(entity.gti) || str(entity.catalogId);
  if (/^amzn1\.dv\.gti\.[0-9a-f-]{36}$/i.test(gti)) return gti;
  return '';
}

function idOf(entity, detailId) {
  var gti = str(entity.gti);
  if (/^amzn1\.dv\.gti\./i.test(gti)) return gti;
  return str(entity.titleID) || str(entity.titleId) || str(entity.asin) || detailId;
}

/* "S2 E4", "Season 2", or "Drama · 2019". */
function subtitleOf(entity, rawTitle) {
  var sHits = collect(entity, function (key) { return /^(seasonNumber|episodeNumber|episodeTitle|seriesTitle)$/i.test(key); }, 3);
  var season = null, episode = null, epTitle = '';
  for (var i = 0; i < sHits.length; i++) {
    var k = sHits[i].key.toLowerCase();
    if (k === 'seasonnumber' && season === null) season = num(sHits[i].value);
    else if (k === 'episodenumber' && episode === null) episode = num(sHits[i].value);
    else if (k === 'episodetitle' && !epTitle) epTitle = textOf(sHits[i].value);
  }
  if (season !== null && episode !== null) return 'S' + season + ' E' + episode + (epTitle ? ' · ' + epTitle : '');
  var m = rawTitle.match(/\s[-–:]\s*Season\s+(\d+)\s*$/i);
  if (m) return 'Season ' + m[1];
  if (season !== null) return 'Season ' + season;
  var parts = [];
  var genre = textOf(entity.primaryGenre) || (obj(entity.primaryGenre) ? str(entity.primaryGenre.name) : '');
  if (!genre && Array.isArray(entity.genres) && entity.genres.length) genre = textOf(entity.genres[0]);
  if (genre) parts.push(genre);
  var year = str(entity.releaseYear) || (typeof entity.releaseYear === 'number' ? String(entity.releaseYear) : '');
  if (year) parts.push(year);
  return parts.join(' · ');
}

/*
 * Entitlement: { entitled: true|false|null, offer: 'rent'|'channel'|'' }.
 * Seen on the public page: entitlementCues.entitlementType 'Entitled' / 'Unentitled' and
 * focus/glance messages like 'Available to rent or buy', 'Free trial of Apple TV'.
 */
function entitlementOf(entity, container) {
  var cues = obj(entity.entitlementCues) || {};
  var t = str(cues.entitlementType) || str(entity.entitlementType);
  var entitled = null;
  if (/^entitled$/i.test(t)) entitled = true;
  else if (/^(unentitled|notentitled|not_entitled)$/i.test(t)) entitled = false;
  else {
    var cc = container && obj(container.entitlementCues);
    if (cc && /^entitled$/i.test(str(cc.entitledCarousel))) entitled = true;
    else if (cc && /^notentitled$/i.test(str(cc.entitledCarousel))) entitled = false;
  }
  var msgs = [];
  var mk = ['focusMessage', 'glanceMessage', 'compactFocusMessage', 'buyboxMessage', 'productSummaryMessage',
    'productPromotionMessage', 'informationalMessage'];
  for (var i = 0; i < mk.length; i++) msgs.push(textOf(cues[mk[i]]));
  if (Array.isArray(entity.buyBoxActions)) {
    for (var b = 0; b < entity.buyBoxActions.length && b < 6; b++) {
      var act = obj(entity.buyBoxActions[b]);
      if (act) msgs.push(textOf(act.text) || textOf(act.label) || str(act.offerType));
    }
  }
  msgs.push(str(entity.offerType), str(cues.offerType), textOf(entity.badge), textOf(entity.offerText));
  var text = msgs.join(' | ');
  var offer = '';
  if (/\b(rent|buy|purchase)\b|\btvod\b|\best\b/i.test(text)) offer = 'rent';
  else if (/free trial of (?!prime\b)|free trials available|\bsubscribe\b|\bchannel\b|\badd-?on\b|\bsubscription\b(?! included)/i.test(text)) offer = 'channel';
  return { entitled: entitled, offer: offer };
}

function itemFrom(entity, container, kind, group, counts) {
  var e = obj(entity);
  if (!e) return null;
  var widget = str(e.widgetType);
  if (widget && DECOY_WIDGET.test(widget)) { counts.skipped.decoy++; return null; }
  var detailId = detailIdOf(e);
  if (!detailId) { counts.skipped.noLink++; return null; }
  var rawTitle = shape.cleanText(textOf(e.displayTitle) || textOf(e.title) || textOf(e.name), 200);
  if (!rawTitle) { counts.skipped.noTitle++; return null; }
  var fullTitle = shape.cleanText(textOf(e.title), 200) || rawTitle;
  var title = rawTitle.replace(/\s[-–:]\s*Season\s+\d+\s*$/i, '') || rawTitle;
  var ent = entitlementOf(e, container);
  if (kind === 'rec' && ent.entitled === false && ent.offer) {
    counts.skipped[ent.offer === 'rent' ? 'rent' : 'channel']++;
    return null;
  }
  var badge = '';
  if (ent.entitled !== true && ent.offer) badge = ent.offer === 'rent' ? 'Rent' : 'Channel';
  var item = {
    id: 'prime:' + idOf(e, detailId),
    service: 'prime',
    kind: kind,
    title: title,
    subtitle: subtitleOf(e, fullTitle),
    image: imageOf(e),
    progress: kind === 'resume' ? progressOf(e) : null,
    url: ORIGIN + '/detail/' + encodeURIComponent(detailId) + '/',
    startsAt: null,
    durationSec: durationOf(e),
    badge: badge,
    group: kind === 'rec' ? group : ''
  };
  return item;
}

/* ------------------------------------------------------------------ parse */

function reasonForError(err, status, budgetMs) {
  var e = obj(err) || {};
  var code = str(e.code);
  var detail = shape.cleanText(str(e.detail), 120);
  var budget = (typeof budgetMs === 'number' && isFinite(budgetMs) && budgetMs > 0) ? budgetMs : BUDGET_MS;
  if (code === 'timeout') return 'timed out after ' + Math.round(budget / 1000) + ' s';
  if (code === 'offline') return "you're offline";
  if (code === 'crashed') return 'the reader page crashed';
  if (code === 'http') return "Prime Video didn't load" + (typeof status === 'number' && status ? ' (HTTP ' + status + ')' : (detail ? ' (' + detail + ')' : ''));
  if (code === 'load-failed') return "Prime Video didn't load" + (detail ? ' (' + detail + ')' : '');
  if (code === 'bad-json') return "Prime Video sent data the reader couldn't read";
  return detail ? 'the read failed (' + detail + ')' : 'the read failed';
}

function fail(reason, counts) { var r = { state: 'error', reason: reason, items: [], profile: '' }; if (counts) r.counts = counts; return r; }
function signedOut(why) { return { state: 'signed-out', reason: REASON_SIGNED_OUT, items: [], profile: '', counts: { signal: why } }; }

function isSignInPath(path) { return /^\/(ap\/(signin|mfa|cvf)|auth-redirect)\b/i.test(path || ''); }
function isCaptchaPath(path) { return /validateCaptcha/i.test(path || ''); }

function parseSafe(read, ctx) {
  var r = obj(read);
  var stepsObj = r && obj(r.steps);
  var step = stepsObj && obj(stepsObj.home);
  if (!step) return fail(REASON_NOTHING);

  var x = step.extracted;
  if (typeof x === 'string') x = { hydration: x };     // a reader that hands back the raw text
  x = obj(x) || {};
  var finalUrl = str(step.finalUrl) || str(x.url) || str(step.url);
  var fp = urlParts(finalUrl);
  var path = fp ? fp.path : '';
  var title = str(step.title) || str(x.title);

  if (isSignInPath(path) || x.signInPage === true) return signedOut('sign-in page');
  if (x.robot === true || isCaptchaPath(path) || /robot check/i.test(title)) return fail(REASON_ROBOT);

  var hyd = parseJsonish(x.hydration);
  var storeP = parseJsonish(x.store);
  var store = storeP.ok ? obj(storeP.value) : null;
  var auth = storeAuth(store);
  if (auth === null && x.signedIn === false) auth = false;
  if (auth === null && x.signedIn === true) auth = true;

  if (step.error && !hyd.ok) {
    if (auth === false) return signedOut('store says signed out');
    return fail(reasonForError(step.error, step.status, step.budgetMs));
  }
  if (x.tooBig === true && !hyd.ok) return fail(REASON_TOO_BIG + (x.hydrationBytes ? ' (' + Math.round(x.hydrationBytes / 1e6) + ' MB)' : ''));
  if (!hyd.ok) {
    if (auth === false) return signedOut('store says signed out');
    if (hyd.empty) {
      if (typeof step.status === 'number' && step.status >= 400) return fail(reasonForError({ code: 'http' }, step.status));
      if (title.trim() === 'Amazon.com') return fail(REASON_ROBOT);   // Amazon's bare captcha / interstitial page
      return fail(REASON_NO_DATA);
    }
    return fail(REASON_NOT_JSON);
  }

  var root = hyd.value;
  var containers = findContainers(root);
  var caps = Array.isArray(step.captures) ? step.captures : [];
  for (var ci = 0; ci < caps.length && ci < 20; ci++) {
    var cj = obj(caps[ci]) ? caps[ci].json : null;
    if (cj && typeof cj === 'object') containers = containers.concat(findContainers(cj));
  }

  var counts = { carousels: 0, items: 0, resume: 0, watchlist: 0, rec: 0,
    skipped: { hero: 0, decoy: 0, rent: 0, channel: 0, noLink: 0, noTitle: 0, dupe: 0 } };
  var items = [];
  var seen = {};
  var recTotal = 0;
  var sawPersonal = false;
  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    var ctype = str(c.containerType);
    if (DECOY_CONTAINER.test(ctype)) { counts.skipped.hero++; continue; }
    var group = containerTitle(c);
    var kind = containerKind(c, group);
    if (kind !== 'rec') sawPersonal = true;
    var made = 0;
    for (var j = 0; j < c.entities.length; j++) {
      if (kind === 'rec' && (made >= REC_PER_ROW || recTotal >= REC_TOTAL)) break;
      var it = itemFrom(c.entities[j], c, kind, group, counts);
      if (!it) continue;
      if (seen[kind + '|' + it.id]) { counts.skipped.dupe++; continue; }
      seen[kind + '|' + it.id] = true;
      items.push(it);
      made++;
      counts[kind]++;
      if (kind === 'rec') recTotal++;
    }
    if (made) counts.carousels++;
  }
  counts.items = items.length;

  /*
   * Signed out wins over "changed layout". A Continue watching or Watchlist row
   * only exists for a signed-in account, so finding one overrules the store
   * flags (whose signed-in values are inferred, not seen).
   */
  if (!sawPersonal) {
    if (auth === false) return signedOut('store says signed out');
    if (auth !== true && hasSignInCta(root)) return signedOut('sign-in buttons on the page');
  }
  if (!items.length) return fail(REASON_CHANGED, counts);
  return { state: 'ok', reason: '', items: items, profile: profileName(store), counts: counts };
}

function parse(read, ctx) {
  try {
    return parseSafe(read, ctx);
  } catch (err) {
    return fail('the reader hit an unexpected page shape (' + shape.cleanText(String((err && err.message) || err), 80) + ')');
  }
}

module.exports = {
  id: 'prime',
  steps: steps,
  parse: parse,
  _internals: { EXTRACT: EXTRACT, pageExtract: pageExtract, ready: ready, storeAuth: storeAuth,
    progressOf: progressOf, entitlementOf: entitlementOf, findContainers: findContainers, reasonForError: reasonForError }
};

/* For watch/search/prime.js (Lumen's one search box): the same hydration read and tolerant parsers. */
module.exports._search = {
  EXTRACT: EXTRACT, ready: ready, findContainers: findContainers, itemFrom: itemFrom, entitlementOf: entitlementOf,
  parseJsonish: parseJsonish, storeAuth: storeAuth, urlParts: urlParts, isSignInPath: isSignInPath, isCaptchaPath: isCaptchaPath,
  hasSignInCta: hasSignInCta, reasonForError: reasonForError, DECOY_CONTAINER: DECOY_CONTAINER, containerTitle: containerTitle,
  REASON_ROBOT: REASON_ROBOT
};
