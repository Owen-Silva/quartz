'use strict';
/*
 * watch/adapters/disney.js -- the user's own Disney+ rows (and, through Disney+,
 * Hulu once his profile is linked, plus the ESPN hub) for Watch.
 *
 * How: one hidden reader view loads https://www.disneyplus.com/home on
 * Quartz's default session, and the reader captures the JSON the page fetches
 * for itself over CDP: the explore page and its lazily loaded sets, the
 * userState call that carries resume progress, and the graph calls that name
 * the active profile. Nothing here mints a token or calls Disney's API itself.
 *
 * Shape sources (FEASIBILITY.md section 2), all PUBLIC and none checked
 * against a live signed-in account:
 *   - pydisney (github.com/pam-param-pam/Disney-Plus-api-wrapper): explore
 *     v1.7 page = data.page.containers[], set = data.set.items[]; an item has
 *     id, visuals.title / description / metastringParts (genres.values,
 *     releaseYearRange.startYear, runtime) / artwork; the title page is
 *     explore page "entity-<id>"; the active profile is
 *     data.me.account.activeProfile { id, name } from /v1/public/graphql.
 *   - slyguy.disney.plus (github.com/Paco8/slyguy.disney.plus, explore
 *     v1.10): containers are { id, type:'set', style:{name}, visuals:{name},
 *     items }; hero/brand styles are promo rows; items carry actions[]
 *     (browse pageId, playback, upsell = locked), personalization.pid,
 *     visuals.episodeTitle/seasonNumber/episodeNumber/durationMs,
 *     visuals.networkAttribution (the network/brand on a tile),
 *     visuals.metastringParts.sportsLeague (ESPN content),
 *     visuals.badging.airingEventState.timeline.startTime (live events),
 *     artwork.standard.<tile|thumbnail|background>.<ratio>.imageId and the
 *     ripcut image URL; progress comes from the explore userState call as
 *     data.entityStates[pid].progress { progressPercentage, secondsRemaining }.
 *   - the public BAM SDK config (client-sdk-configs.bamgrid.com ... prod.json):
 *     explore endpoints /explore/{version}/page/{pageId}, /set/{setId},
 *     /userState (POST), /hydration (POST).
 * Matching rows by their visible name or style, never by a fixed set id, is
 * the design: ids and the explore version both churn.
 *
 * Hulu inside Disney+ (FEASIBILITY.md "Hulu (10-17)"): a second, optional view
 * loads Disney+'s own Hulu hub (/browse/hulu, which Disney+ answers with
 * /browse/page-<id>, "Hulu Movies and Shows | Disney+", public logged-out probe
 * 2026-10-17). Everything that hub lists is Hulu content, so (1) its rows come in
 * as picks badged Hulu, and (2) any home-row title the hub also lists is badged
 * Hulu: a confident tag from Disney+'s own grouping, not a guess from a name.
 * When Hulu is locked, missing or not linked, a warning says so and how to fix it.
 */
var shape = require('../shape');

var ID = 'disney';
var SITE = 'https://www.disneyplus.com';
var HOME = SITE + '/home';
var IMG = 'https://disney.images.edge.bamgrid.com/ripcut-delivery/v2/variant/disney/';
var IMG_TAIL = '/scale?width=640&aspectRatio=1.78';
var BUDGET_MS = 20000;
var PER_SET = 50;
var HULU_HUB = SITE + '/browse/hulu';
var HUB_BUDGET_MS = 15000;
var HUB_ROWS = 4;        // the Hulu hub's own rows Watch takes, in page order
var HUB_PER_ROW = 20;

/* PATH patterns (no hosts), so a local mock server matches as well as bamgrid. */
var EXPLORE_RE = /\/explore\/v[\d.]+\/(page|set|userState|hydration)\b/i;
var GRAPH_RES = [/\/graph\/v1\/device\/graphql/i, /\/v1\/public\/graphql/i];
var CAPTURE = [EXPLORE_RE].concat(GRAPH_RES);

var ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/;
var IMAGE_ID_RE = /^[A-Za-z0-9_-]{6,200}$/;

var SIGNED_OUT_REASON = 'sign in to Disney+ in Quartz to see your rows';
var PICKER_REASON = "Disney+ is asking who's watching; open Disney+ in Quartz and pick a profile";

/* Rows. A style that says hero/brand is a promo strip (slyguy skips the same). */
var DECOY_STYLE_RE = /hero|brand|billboard|marquee|promo|upsell/i;
var RESUME_RE = /continue[\s_-]*watching|continuewatching|keep[\s_-]*watching|\bresume\b|pick up where/i;
var WATCHLIST_RE = /watch[\s_-]*list|my[\s_-]*stuff|my[\s_-]*list|saved for later/i;
var REC_RE = /for[\s_-]*you|recommend|because[\s_-]*you|becauseyou|top[\s_-]*picks?|trending|picked for|you might|you may|popular|top[\s_-]*10|personali[sz]ed/i;
var HULU_RE = /\bhulu\b/i;
var ESPN_RE = /\bespn\b/i;

/* What Watch says about Hulu inside Disney+ when it shows nothing (each reads after "Note: "). */
var LINK_HOW = 'Disney+ → Profile → Link Hulu';
var HULU_NOT_LINKED = "Hulu isn't linked in Disney+, so your Hulu Keep Watching and My Stuff stay on hulu.com (" + LINK_HOW + ')';
var HULU_LOCKED = 'Hulu titles are locked in this Disney+ plan (add Hulu to it, or link your Hulu profile: ' + LINK_HOW + ')';
var HULU_NO_HUB = "Disney+ shows no Hulu hub for this profile: Hulu isn't linked or isn't in the plan (" + LINK_HOW + ')';
var HULU_HUB_EMPTY = 'the Hulu hub in Disney+ loaded but none of its rows matched (Disney+ changed its layout?)';

/* The page reads: where the view ended up, its title, and a cheap sign-in CTA check. */
var EXTRACT = '(function () {' +
  ' try {' +
  '  var q = function (s) { try { return document.querySelector(s); } catch (e) { return null; } };' +
  '  var cta = q(\'a[href*="/login"], a[href*="/sign-up"], a[href*="/signup"], [data-testid="login-button"], [data-testid="signup-button"]\');' +
  '  return { url: String(location.href || \'\'), title: String(document.title || \'\').slice(0, 300), login: !!cta };' +
  ' } catch (e) {' +
  '  return { url: \'\', title: \'\', login: null, error: String((e && e.message) || e).slice(0, 200) };' +
  ' }' +
  '})()';

/* The Hulu hub page: the same, plus whether Disney+ is offering to link a Hulu profile there. */
var EXTRACT_HUB = '(function () {' +
  ' try {' +
  '  var q = function (s) { try { return document.querySelector(s); } catch (e) { return null; } };' +
  '  var cta = q(\'a[href*="/login"], a[href*="/sign-up"], a[href*="/signup"], [data-testid="login-button"], [data-testid="signup-button"]\');' +
  '  var text = String((document.body && document.body.innerText) || \'\').slice(0, 20000);' +
  '  return { url: String(location.href || \'\'), title: String(document.title || \'\').slice(0, 300), login: !!cta,' +
  '    linkPrompt: /\\blink (your )?hulu\\b|\\bconnect (your )?hulu\\b/i.test(text) };' +
  ' } catch (e) {' +
  '  return { url: \'\', title: \'\', login: null, error: String((e && e.message) || e).slice(0, 200) };' +
  ' }' +
  '})()';

/* ---------- small tolerant helpers ---------- */

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return parseFloat(v);
  return null;
}
function pathOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url).pathname; } catch (err) { return null; }
}
function capUrl(c) { return str(c && c.url); }
function isExplore(c) { return EXPLORE_RE.test(capUrl(c)); }
function isGraph(c) {
  var u = capUrl(c);
  for (var i = 0; i < GRAPH_RES.length; i++) if (GRAPH_RES[i].test(u)) return true;
  return false;
}
function okStatus(c) {
  var s = num(c && c.status);
  return s === null || s === 0 || (s >= 200 && s < 300);
}
function nameOf(node) {
  var v = obj(node && node.visuals) || {};
  return shape.cleanText(shape.textOf(v.name) || shape.textOf(v.title) || str(node && node.name) ||
    shape.textOf(node && node.title), 120);
}
function styleOf(node) {
  if (!node) return '';
  if (typeof node.style === 'string') return node.style;
  var s = obj(node.style);
  return s ? (str(s.name) || str(s.layout) || str(s.fallback)) : '';
}

/* ---------- sign-in state from where the view ended up ---------- */

/** Path with a locale prefix (/en-us, /fr) and trailing slash taken off, lower case; null if no URL. */
function corePath(url) {
  var p = pathOf(url);
  if (p === null) return null;
  p = p.toLowerCase().replace(/^\/[a-z]{2}(-[a-z]{2,4})?(?=\/|$)/, '').replace(/\/+$/, '');
  return p;
}
function signedOutByUrl(url) {
  var p = corePath(url);
  if (p === null) return false;
  if (p === '') return true;   // the bare marketing landing page
  return /^\/(login|welcome|sign-?up|identity|enter-email|enter-password|register)(\/|$)/.test(p);
}
function profilePickerByUrl(url) {
  var p = corePath(url);
  return p !== null && /^\/(select-profile|profiles?|who-?s-?watching)(\/|$)/.test(p);
}

/* ---------- sets ---------- */

/**
 * Every set-like node across the captures, merged by set id (a lazily fetched
 * set fills the empty container the page listed), in page order.
 */
function collectSets(captures) {
  var order = [];
  var byId = {};
  var list = Array.isArray(captures) ? captures.filter(function (c) { return obj(c) && okStatus(c); }) : [];
  // Page responses first, so the page's container order wins over fetch order.
  var pages = list.filter(function (c) { return /\/page\//i.test(capUrl(c)); });
  var rest = list.filter(function (c) { return pages.indexOf(c) === -1; });
  var ordered = pages.concat(rest);
  var synthetic = 0;

  function entryFor(id) {
    if (id && byId[id]) return byId[id];
    var e = { id: id, name: '', style: '', hint: '', items: [], itemKeys: {} };
    if (id) byId[id] = e;
    order.push(e);
    return e;
  }

  function addItems(e, items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!obj(it)) continue;
      var key = str(it.id) ? 'id:' + it.id : 'n:' + (synthetic++);
      if (e.itemKeys[key]) continue;
      e.itemKeys[key] = true;
      e.items.push(it);
    }
  }

  ordered.forEach(function (c) {
    if (!isExplore(c) && c.url) return;
    var urlSetId = '';
    var m = /\/set\/([^\/?#]+)/i.exec(capUrl(c));
    if (m) { try { urlSetId = decodeURIComponent(m[1]); } catch (err) { urlSetId = m[1]; } }
    shape.walk(c.json, function (node, key, parent) {
      if (!obj(node)) return;
      var hasItems = Array.isArray(node.items);
      var typeSet = node.type === 'set' || /set$/i.test(str(node.type)) || /set$/i.test(str(node.refType));
      // With items: anything that looks like a row. Without: only a declared set
      // (a lazy container the page lists before fetching it), so a page that
      // happens to carry a style is never mistaken for a row.
      var setish = hasItems ? (typeSet || key === 'set' || !!styleOf(node) || !!obj(node.visuals)) : (typeSet || key === 'set');
      if (!setish) return;
      var p = key === 'set' ? obj(parent) : null;
      var id = str(node.id) || str(node.setId) || str(node.refId) || (p && (str(p.id) || str(p.setId))) ||
        (key === 'set' ? urlSetId : '');
      if (!hasItems && !id) return;
      var e = entryFor(id);
      if (!e.name) e.name = nameOf(node) || (p ? nameOf(p) : '');
      if (!e.style) e.style = styleOf(node) || (p ? styleOf(p) : '');
      e.hint += ' ' + [str(node.type), str(node.refType), str(node.setType), str(node.contentClass)].join(' ');
      if (hasItems) addItems(e, node.items);
      // Keep walking: a container can wrap its set, and an odd page can nest rows.
    });
  });
  return order;
}

/** { kind, badge } for a row, or null when it is a promo strip or not a personal row. */
function classify(set) {
  if (!set) return null;
  var style = set.style || '';
  if (DECOY_STYLE_RE.test(style)) return null;
  var text = (set.name || '') + ' ' + style + ' ' + (set.hint || '');
  if (RESUME_RE.test(text)) return { kind: 'resume', badge: '' };
  if (WATCHLIST_RE.test(text)) return { kind: 'watchlist', badge: '' };
  var hulu = HULU_RE.test(set.name || '');
  var espn = ESPN_RE.test(set.name || '');
  if (REC_RE.test(text) || hulu || espn) return { kind: 'rec', badge: hulu ? 'Hulu' : (espn ? 'ESPN' : '') };
  return null;
}

/** A row on Disney+'s Hulu hub: everything on it is Hulu, so any named non-promo row is a Hulu pick. */
function classifyHub(set) {
  if (!set || DECOY_STYLE_RE.test(set.style || '')) return null;
  var name = set.name || '';
  var text = name + ' ' + (set.style || '') + ' ' + (set.hint || '');
  var group = !name ? '' : (HULU_RE.test(name) ? name : 'Hulu: ' + name);
  if (RESUME_RE.test(text)) return { kind: 'resume', badge: 'Hulu', group: name };
  if (WATCHLIST_RE.test(text)) return { kind: 'watchlist', badge: 'Hulu', group: name };
  if (!name) return null;
  return { kind: 'rec', badge: 'Hulu', group: group };
}

/* ---------- progress ---------- */

/** userState: data.entityStates, keyed by pid (or a list of { pid, ... }). */
function collectStates(captures) {
  var states = {};
  (Array.isArray(captures) ? captures : []).forEach(function (c) {
    if (!obj(c) || !okStatus(c) || (c.url && !isExplore(c))) return;
    shape.walk(c.json, function (node, key) {
      if (key !== 'entityStates') return;
      if (Array.isArray(node)) {
        node.forEach(function (s) {
          var pid = obj(s) && (str(s.pid) || str(s.id));
          if (pid) states[pid] = s;
        });
      } else if (obj(node)) {
        Object.keys(node).forEach(function (k) { if (obj(node[k])) states[k] = node[k]; });
      }
      return false;
    });
  });
  return states;
}

function ratio(part, whole) {
  return (part !== null && whole !== null && whole > 0 && part >= 0) ? Math.min(1, part / whole) : null;
}

/** 0..1 from one progress-like object, or null. */
function progressFrom(p, durationMs) {
  if (!obj(p)) return null;
  var pct = num(p.progressPercentage);
  if (pct === null) pct = num(p.percentComplete);
  if (pct === null) pct = num(p.percentWatched);
  if (pct === null) pct = num(p.percentageWatched);
  if (pct === null) pct = num(p.progressPercent);
  if (pct !== null && pct >= 0 && pct <= 100) return pct / 100;
  var dur = num(p.runtimeMs);
  if (dur === null) dur = num(p.durationMs);
  if (dur === null) dur = durationMs;
  var rem = num(p.secondsRemaining);
  if (rem !== null && dur !== null && dur > 0) return Math.max(0, 1 - (rem * 1000) / dur);
  var head = num(p.playheadMs);
  if (head === null) head = num(p.positionMs);
  if (head === null) head = num(p.offsetMs);
  if (head === null) head = num(p.bookmarkMs);
  var r = ratio(head, dur);
  if (r !== null) return r;
  var plain = num(p.progress);
  if (plain !== null && plain >= 0) return plain > 1 ? (plain <= 100 ? plain / 100 : null) : plain;
  return null;
}

function progressOf(raw, durationMs, states) {
  var pers = obj(raw.personalization) || {};
  var keys = [str(pers.pid), str(raw.pid), str(raw.id)];
  for (var i = 0; i < keys.length; i++) {
    var st = keys[i] && states[keys[i]];
    if (!st) continue;
    var fromState = progressFrom(obj(st.progress) || st, durationMs);
    if (fromState !== null) return fromState;
  }
  // Item-level bookmark/progress fields, wherever this version keeps them.
  var found = null;
  shape.walk(raw, function (node, key, parent, depth) {
    if (found !== null || depth > 5) return false;
    if (key === 'artwork' || key === 'actions' || key === 'networkAttribution') return false;
    if (key === 'progress' && typeof node === 'number' && obj(parent)) {
      found = progressFrom({ progress: node }, durationMs);
      return false;
    }
    if (obj(node) && depth > 0) {
      var p = progressFrom(node, durationMs);
      if (p !== null && (key === 'progress' || key === 'bookmark' || key === 'userState' || key === 'playhead' ||
          node.progressPercentage !== undefined || node.percentComplete !== undefined ||
          node.percentWatched !== undefined || node.secondsRemaining !== undefined ||
          node.playheadMs !== undefined || node.positionMs !== undefined)) {
        found = p;
        return false;
      }
    }
  });
  return found;
}

/* ---------- items ---------- */

function pickImage(visuals, isEpisode) {
  var art = obj(visuals.artwork);
  if (!art) return '';
  var std = obj(art.standard) || art;
  var kinds = isEpisode ? ['thumbnail', 'tile', 'background'] : ['tile', 'thumbnail', 'background'];
  var ratios = ['1.78', '1.77', '1.33'];
  function idAt(k, r) {
    var a = obj(std[k]);
    var b = a && obj(a[r]);
    var id = b && str(b.imageId);
    return id && IMAGE_ID_RE.test(id) ? id : '';
  }
  var id = '';
  for (var r = 0; r < ratios.length && !id; r++) {
    for (var k = 0; k < kinds.length && !id; k++) id = idAt(kinds[k], ratios[r]);
    if (!id) {
      var others = Object.keys(std);
      for (var o = 0; o < others.length && !id; o++) if (kinds.indexOf(others[o]) === -1 && !/logo|title/i.test(others[o])) id = idAt(others[o], ratios[r]);
    }
  }
  if (!id) {
    // Any still at all (a 0.71 poster beats nothing); never a logo or title treatment.
    shape.walk(std, function (node, key) {
      if (id) return false;
      if (typeof key === 'string' && /logo|title/i.test(key)) return false;
      if (key === 'imageId' && typeof node === 'string' && IMAGE_ID_RE.test(node)) id = node;
    });
  }
  return id ? IMG + id + IMG_TAIL : '';
}

/** Words from the brand/network/badge parts of an item, for the Hulu / ESPN badge. */
function attributionText(raw, visuals) {
  var bits = [];
  function grab(root) {
    shape.walk(root, function (node, key, parent, depth) {
      if (depth > 5 || bits.length > 40) return false;
      if (key === 'imageId') return false;
      if (typeof node === 'string') bits.push(node);
    });
  }
  Object.keys(visuals).forEach(function (k) {
    if (/attribution|brand|network|badg|provider|partner|service/i.test(k)) grab(visuals[k]);
  });
  Object.keys(raw).forEach(function (k) {
    if (/^(brand|network|provider|partner|service)/i.test(k)) grab(raw[k]);
  });
  return bits.join(' ');
}

function entityOf(raw) {
  var actions = Array.isArray(raw.actions) ? raw.actions : [];
  for (var i = 0; i < actions.length; i++) {
    var a = obj(actions[i]);
    if (!a || a.type !== 'browse') continue;
    var pageId = str(a.pageId);
    var m = /^entity-(.+)$/i.exec(pageId);
    if (m && ENTITY_ID_RE.test(m[1])) return m[1];
    if (/^page-/i.test(pageId)) return null;   // a collection or brand tile, not a title
  }
  var id = str(raw.id).replace(/^entity-/i, '');
  return ENTITY_ID_RE.test(id) ? id : '';
}

function hasUpsell(raw) {
  var actions = Array.isArray(raw.actions) ? raw.actions : [];
  for (var i = 0; i < actions.length; i++) if (obj(actions[i]) && actions[i].type === 'upsell') return true;
  return false;
}

function parseItem(raw, set, cls, states) {
  if (!obj(raw)) return null;
  var v = obj(raw.visuals) || {};
  var title = shape.cleanText(shape.textOf(v.title) || shape.textOf(v.name) || shape.textOf(raw.title) || str(raw.name));
  if (!title) return null;
  var entity = entityOf(raw);
  if (!entity) return null;
  if (cls.kind === 'rec' && hasUpsell(raw)) return null;   // not in his plan: no use as a recommendation

  var meta = obj(v.metastringParts) || {};
  var sn = num(v.seasonNumber);
  var en = num(v.episodeNumber);
  var episodeTitle = shape.cleanText(shape.textOf(v.episodeTitle));
  var isEpisode = !!episodeTitle || en !== null;
  var sub = '';
  if (sn !== null && en !== null) sub = 'S' + sn + ' E' + en;
  else if (en !== null) sub = 'E' + en;
  if (episodeTitle && episodeTitle !== title) sub = sub ? sub + ' · ' + episodeTitle : episodeTitle;
  if (!sub) {
    var genres = obj(meta.genres) && Array.isArray(meta.genres.values) ? meta.genres.values.filter(function (g) { return typeof g === 'string' && g; }) : [];
    var year = obj(meta.releaseYearRange) ? num(meta.releaseYearRange.startYear) : null;
    var league = obj(meta.sportsLeague) ? shape.textOf(meta.sportsLeague.name) : '';
    sub = [genres.slice(0, 2).join(', '), year !== null ? String(year) : '', league].filter(Boolean).join(' · ');
  }

  var durationMs = num(v.durationMs);
  if (durationMs === null && obj(meta.runtime)) durationMs = num(meta.runtime.runtimeMs);
  if (durationMs === null) durationMs = num(raw.durationMs);

  var attr = attributionText(raw, v);
  var badge = HULU_RE.test(attr) ? 'Hulu' : ((ESPN_RE.test(attr) || obj(meta.sportsLeague)) ? 'ESPN' : '');
  if (!badge) badge = cls.badge;

  // year + type, from Disney's own fields only (for telling the same title on hulu.com apart).
  var yearRange = obj(meta.releaseYearRange);
  var year = yearRange ? num(yearRange.startYear) : null;
  var typeHint = [str(raw.programType), str(raw.contentType), str(raw.entityType), str(v.programType), typeof raw.type === 'string' ? raw.type : ''].join(' ');
  var type = '';
  if (/movie|film/i.test(typeHint)) type = 'movie';
  else if (/series|episode|show/i.test(typeHint) || isEpisode || sn !== null || obj(meta.seasonsAvailable) || obj(meta.seasons)) type = 'show';
  else if (obj(meta.runtime)) type = 'movie';

  var startsAt = null;
  var badging = obj(v.badging);
  var airing = badging && obj(badging.airingEventState);
  var timeline = airing && obj(airing.timeline);
  if (timeline && typeof timeline.startTime === 'string') {
    var t = Date.parse(timeline.startTime);
    if (isFinite(t)) startsAt = t;
  }

  return {
    id: ID + ':' + entity,
    service: ID,
    kind: cls.kind,
    title: title,
    subtitle: sub,
    image: pickImage(v, isEpisode),
    progress: cls.kind === 'resume' ? progressOf(raw, durationMs, states) : null,
    url: SITE + '/browse/entity-' + encodeURIComponent(entity),
    startsAt: startsAt,
    durationSec: durationMs !== null && durationMs > 0 ? Math.round(durationMs / 1000) : null,
    badge: badge,
    group: cls.group !== undefined ? cls.group : (set.name || ''),
    year: year !== null && year >= 1880 ? year : null,
    type: type
  };
}

/* ---------- profile ---------- */

function profileOf(captures) {
  var name = '';
  var activeId = '';
  var names = {};
  (Array.isArray(captures) ? captures : []).forEach(function (c) {
    if (!obj(c) || !okStatus(c) || (c.url && !isGraph(c))) return;
    shape.walk(c.json, function (node, key) {
      if (key === 'activeProfile' && obj(node)) {
        if (!name && str(node.name)) name = node.name;
        if (!activeId && str(node.id)) activeId = node.id;
      }
      if (key === 'profiles' && Array.isArray(node)) {
        node.forEach(function (p) { if (obj(p) && str(p.id) && str(p.name)) names[p.id] = p.name; });
      }
    });
  });
  if (!name && activeId && names[activeId]) name = names[activeId];
  return shape.cleanText(name, 60);
}

/* ---------- the read ---------- */

function errorReason(e, step) {
  var detail = shape.cleanText(typeof e.detail === 'string' ? e.detail : (e.detail != null ? String(e.detail) : ''), 80);
  switch (e.code) {
    case 'timeout': return 'timed out after ' + Math.round(BUDGET_MS / 1000) + ' s';
    case 'offline': return "you're offline, so Quartz couldn't reach Disney+";
    case 'load-failed': return "the Disney+ page didn't load" + (detail ? ' (' + detail + ')' : '');
    case 'http': {
      var status = num(step.status);
      return 'Disney+ answered HTTP ' + (status !== null ? status : (detail || 'error'));
    }
    case 'bad-json': return "Disney+ sent page data that wasn't valid JSON";
    case 'crashed': return 'the hidden reader page crashed';
    default: return 'the reader failed (' + (shape.cleanText(String(e.code || 'unknown'), 30) || 'unknown') + ')';
  }
}

function fail(reason, extra) {
  var out = { state: 'error', reason: reason, items: [], profile: '' };
  if (extra) out.counts = extra;
  return out;
}

/**
 * Disney+'s Hulu hub (the optional 'hulu' step): its rows as Hulu picks, every entity it lists
 * (to badge the same titles in the home rows), and a warning when Hulu shows nothing, saying why.
 * No step at all (an older read) is no Hulu part and no warning.
 */
function readHuluHub(step, states) {
  var out = { items: [], entities: {}, warning: '' };
  if (!step) return out;
  var ex = obj(step.extracted) || {};
  var finalUrl = str(step.finalUrl) || str(ex.url) || '';
  var e = obj(step.error);
  var captures = Array.isArray(step.captures) ? step.captures.filter(function (c) { return obj(c); }) : [];
  if (signedOutByUrl(finalUrl)) { out.warning = 'the Hulu hub in Disney+ asked Quartz to sign in again'; return out; }
  var p = corePath(finalUrl);
  // Disney+ answers /browse/hulu with the hub's /browse/page-<id>; landing anywhere else is no hub.
  if (!e && p !== null && !/^\/browse\//.test(p)) { out.warning = HULU_NO_HUB; return out; }

  var rows = 0;
  var raw = 0;
  var locked = 0;
  collectSets(captures).forEach(function (set) {
    set.items.forEach(function (it) {
      var ent = obj(it) && entityOf(it);
      if (ent) out.entities[ent] = true;
    });
    var cls = classifyHub(set);
    if (!cls) return;
    if (cls.kind === 'rec' && rows >= HUB_ROWS) return;
    if (cls.kind === 'rec') rows++;
    var n = 0;
    for (var i = 0; i < set.items.length && n < HUB_PER_ROW; i++) {
      raw++;
      if (cls.kind === 'rec' && obj(set.items[i]) && hasUpsell(set.items[i])) locked++;
      var item = parseItem(set.items[i], set, cls, states);
      if (item) { out.items.push(item); n++; }
    }
  });
  if (ex.linkPrompt === true) out.warning = HULU_NOT_LINKED;
  else if (!out.items.length && locked > 0 && locked === raw) out.warning = HULU_LOCKED;
  else if (!out.items.length && e) out.warning = "the Hulu hub in Disney+ didn't load (" + errorReason(e, step).replace(/after \d+ s/, 'after ' + Math.round(HUB_BUDGET_MS / 1000) + ' s') + ')';
  else if (!out.items.length && !captures.some(isExplore)) out.warning = HULU_NO_HUB;
  else if (!out.items.length) out.warning = HULU_HUB_EMPTY;
  return out;
}

function parseRead(read) {
  var r = obj(read);
  var steps = r && obj(r.steps);
  var step = steps && obj(steps.home);
  if (!step) return fail('the reader returned no Disney+ page');

  var ex = obj(step.extracted) || {};
  var finalUrl = str(step.finalUrl) || str(ex.url) || '';
  var captures = Array.isArray(step.captures) ? step.captures.filter(function (c) { return obj(c); }) : [];
  var explore = captures.filter(function (c) { return isExplore(c); });
  var counts = { responses: captures.length, explore: explore.length, sets: 0, items: 0 };

  // 1. Where the view ended up beats everything: a login redirect is signed out.
  if (signedOutByUrl(finalUrl) || (str(ex.url) && signedOutByUrl(ex.url))) {
    return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [], profile: '', counts: counts };
  }
  if (profilePickerByUrl(finalUrl) || (str(ex.url) && profilePickerByUrl(ex.url))) return fail(PICKER_REASON, counts);

  // 2. The reader itself failed (a timeout may still have captured rows; read them).
  var e = obj(step.error);
  if (e && e.code !== 'timeout') return fail(errorReason(e, step), counts);

  // 3. The rows.
  var sets = collectSets(captures);
  var states = collectStates(captures);
  var items = [];
  var matched = 0;
  var matchedRaw = 0;
  sets.forEach(function (set) {
    var cls = classify(set);
    if (!cls) return;
    matched++;
    matchedRaw += set.items.length;
    var n = 0;
    for (var i = 0; i < set.items.length && n < PER_SET; i++) {
      var it = parseItem(set.items[i], set, cls, states);
      if (it) { items.push(it); n++; }
    }
  });
  // 3b. Hulu inside Disney+: the hub's rows, and a Hulu badge on every home title the hub lists.
  var hub = readHuluHub(obj(steps.hulu), states);
  var homeCount = items.length;
  items.forEach(function (it) {
    if (!it.badge && hub.entities[it.id.slice(ID.length + 1)]) it.badge = 'Hulu';
  });
  items = items.concat(hub.items);
  counts.sets = matched;
  counts.items = items.length;
  counts.hulu = hub.items.length + items.slice(0, homeCount).filter(function (it) { return it.badge === 'Hulu'; }).length;
  var profile = profileOf(captures);
  var warnings = hub.warning ? [hub.warning] : [];

  if (items.length) return { state: 'ok', reason: '', items: items, profile: profile, counts: counts, warnings: warnings };

  // 4. Signed out, told by the data rather than the URL (before a timeout: a
  //    marketing page that never fetches rows would otherwise read as slow).
  var unauthorized = explore.length > 0 && explore.every(function (c) { var s = num(c.status); return s === 401 || s === 403; });
  if (unauthorized || (explore.length === 0 && ex.login === true)) {
    return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [], profile: '', counts: counts };
  }
  if (e) return fail(errorReason(e, step), counts);

  // 5. Disney+ sent his rows and they are simply empty (a new profile): not a failure.
  if (matched > 0 && matchedRaw === 0) return { state: 'ok', reason: '', items: [], profile: profile, counts: counts, warnings: warnings };

  // 6. Data came back and none of it matched.
  var n = captures.length;
  return fail('the page loaded but no Continue Watching data matched (Disney+ changed its layout?) (' +
    n + (n === 1 ? ' response' : ' responses') + ' read)', counts);
}

function parse(read, ctx) {
  try {
    return parseRead(read, ctx);
  } catch (err) {
    return fail('the Disney+ reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')');
  }
}

/* Stop waiting once Continue Watching and the Watchlist have both arrived with items. */
function enough(captures) {
  try {
    var resume = false;
    var watchlist = false;
    collectSets(captures).forEach(function (set) {
      var cls = classify(set);
      if (!cls || !set.items.length) return;
      if (cls.kind === 'resume') resume = true;
      if (cls.kind === 'watchlist') watchlist = true;
    });
    return resume && watchlist;
  } catch (err) {
    return false;
  }
}

function ready(extracted) {
  return !!extracted && typeof extracted === 'object';
}

function steps(ctx) {
  return [{
    name: 'home',
    type: 'view',
    url: HOME,
    extract: EXTRACT,
    ready: ready,
    capture: CAPTURE.slice(),
    enough: enough,
    settleMs: 4000,
    scroll: 3,
    budgetMs: BUDGET_MS
  }, {
    // Hulu inside Disney+: Disney+'s own Hulu hub. Optional: the home rows stand without it.
    name: 'hulu',
    type: 'view',
    url: HULU_HUB,
    extract: EXTRACT_HUB,
    ready: ready,
    capture: [EXPLORE_RE],
    enough: enoughHub,
    settleMs: 3000,
    scroll: 2,
    budgetMs: HUB_BUDGET_MS,
    optional: true
  }];
}

/* The hub has said enough once two of its named rows have items. */
function enoughHub(captures) {
  try {
    return collectSets(captures).filter(function (set) { var c = classifyHub(set); return !!c && set.items.length > 0; }).length >= 2;
  } catch (err) {
    return false;
  }
}

module.exports = {
  id: ID,
  steps: steps,
  parse: parse,
  // For the tests.
  _internal: {
    EXTRACT: EXTRACT, EXTRACT_HUB: EXTRACT_HUB, EXPLORE_RE: EXPLORE_RE, classify: classify, classifyHub: classifyHub,
    collectSets: collectSets, signedOutByUrl: signedOutByUrl,
    HULU_NOT_LINKED: HULU_NOT_LINKED, HULU_LOCKED: HULU_LOCKED, HULU_NO_HUB: HULU_NO_HUB, HULU_HUB_EMPTY: HULU_HUB_EMPTY
  }
};
