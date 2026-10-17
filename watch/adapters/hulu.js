'use strict';
/*
 * watch/adapters/hulu.js -- the user's own hulu.com rows for Watch: Keep Watching (with
 * progress), My Stuff and the home page's picks.
 *
 * Why a reader of its own: in Oct 2026 hulu.com is still a separate signed-in web app
 * (FEASIBILITY.md "Hulu (10-17)"). Hulu inside Disney+ is read by disney.js; this one reads
 * the hulu.com account, which is the only place his Hulu rows live when his Hulu profile is
 * not linked into Disney+.
 *
 * How: like disney.js. One hidden reader view loads https://www.hulu.com/hub/home on
 * Quartz's default session and the reader captures, over CDP, the JSON the page fetches for
 * itself from discover.hulu.com (the home hub and its lazily loaded collections); a second,
 * optional view loads /my-stuff the same way. Nothing here mints a token or calls Hulu's API
 * itself, and nothing touches video.
 *
 * Shape sources, all PUBLIC and none checked against a live signed-in account:
 *   - hulu.com logged-out behaviour, probed 2026-10-17 with no cookies: / and /hub/home ->
 *     /welcome; /my-stuff and /profiles -> auth.hulu.com/web/login?next=...; /login ->
 *     auth.hulu.com/web/login; /series/<uuid> and /movie/<uuid> answer 200 (the uuid alone is
 *     a title page; /series/<slug>-<uuid> is the canonical form); artwork is
 *     img*.hulu.com/user/v3/artwork/<id>?base_image_bucket_name=image_manager&base_image=<id>
 *     and needs &size=WxH&format=jpeg (400 without it); the public series page's model:
 *     type episode|series|movie, name, seriesName, season, number, duration (s), premiereDate,
 *     genres, artwork.horizontalHero.path, href /series/<slug>-<uuid>, and its collection href
 *     https://discover.hulu.com/content/v5/hubs/series/<id>/collections/<n>.
 *   - crosswalknyc/behavioralgraph scripts/trends_scrapers/hulu.py (2026-08..09): signed-in
 *     /hub/home lazy-fetches discover.hulu.com/content/v5/view_hubs; tiles link
 *     /series/<uuid>, /movie/<uuid>, /watch/<uuid>.
 *   - MALSync src/pages/Hulu/main.ts: discover.hulu.com/content/v3/entity items[] with
 *     series_name, season, number, name, genre_names.
 *   - hh-macro/videoResourceThree hulu/duration_gain.py: /content/v5/hubs/<type>/<id> ->
 *     components[].items[], bundle.duration, premiere_date, genre_names.
 * Hub items are read tolerantly in both spellings (snake_case API, camelCase page model):
 * entity_metadata, personalization (bookmark), visuals (headline, artwork), actions.browse
 * (target_type, target_id, href), metrics_info. Rows are matched by their visible name,
 * never a fixed collection id.
 */
var shape = require('../shape');

var ID = 'hulu';
var SITE = 'https://www.hulu.com';
var HOME = SITE + '/hub/home';
var MY_STUFF = SITE + '/my-stuff';
var BUDGET_MS = 20000;
var MY_STUFF_BUDGET_MS = 12000;
var PER_ROW = 50;
var IMG_SIZE = 'size=640x360&format=jpeg';

/* PATH patterns (no hosts), so a local mock server matches as well as discover.hulu.com. */
var CONTENT_RE = /\/content\/v\d+\/(hubs|view_hubs|collections?|entity|entities|me)\b/i;
var PROFILE_RE = /\/users\/[^\/?#]+\/profiles?\b|\/profiles?\/(current|active|self|me)\b/i;
var CAPTURE = [CONTENT_RE, PROFILE_RE];

var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

var SIGNED_OUT_REASON = 'sign in to hulu.com in Quartz to see your Hulu rows (or, if you watch Hulu inside Disney+, turn Hulu off in Settings > Watch)';
var PICKER_REASON = "Hulu is asking who's watching; open hulu.com in Quartz and pick a profile";
var MOVED_REASON = 'hulu.com sent Quartz to Disney+: Hulu now plays inside Disney+ for this account, and Watch reads it there (turn Hulu off in Settings > Watch)';

var DECOY_RE = /hero|marquee|masthead|billboard|brand|promo|upsell|spotlight|network|channel|live[\s_-]*tv|ad[\s_-]*slot/i;
var RESUME_RE = /keep[\s_-]*watching|continue[\s_-]*watching|\bresume\b|pick up where/i;
var WATCHLIST_RE = /my[\s_-]*stuff|watch[\s_-]*list|my[\s_-]*list|saved for later/i;
var REC_RE = /for[\s_-]*you|recommend|because[\s_-]*you|top[\s_-]*picks?|picked for|you might|you may|trending|popular|top[\s_-]*10|personali[sz]ed|hulu[\s_-]*originals?|new (on|to) hulu|just added|what to watch/i;

/* The page reads: where the view ended up, its title, and a cheap log-in CTA check. */
var EXTRACT = '(function () {' +
  ' try {' +
  '  var q = function (s) { try { return document.querySelector(s); } catch (e) { return null; } };' +
  '  var cta = q(\'a[href*="/login"], a[href*="auth.hulu.com"], a[href*="signup.hulu.com"], [data-automationid="login-button"], [data-testid="login-button"]\');' +
  '  return { url: String(location.href || \'\'), title: String(document.title || \'\').slice(0, 300), login: !!cta };' +
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
function first() {
  for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
  return null;
}
function capUrl(c) { return str(c && c.url); }
function isContent(c) { return CONTENT_RE.test(capUrl(c)); }
function isProfile(c) { return PROFILE_RE.test(capUrl(c)); }
function okStatus(c) {
  var s = num(c && c.status);
  return s === null || s === 0 || (s >= 200 && s < 300);
}
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (err) { return ''; }
}
function hostIs(host, suffix) {
  return host === suffix || (host.length > suffix.length && host.slice(-(suffix.length + 1)) === '.' + suffix);
}
function pathOf(url) {
  try { return new URL(url).pathname.toLowerCase().replace(/\/+$/, ''); } catch (err) { return null; }
}
function uuidOf(s) {
  var m = UUID_RE.exec(str(s).replace(/[\/?#].*$/, '').trim());
  return m ? m[1].toLowerCase() : '';
}
function yearOf(v) {
  if (typeof v === 'number' && v >= 1880 && v <= 2100) return Math.round(v);
  var m = /^\s*(\d{4})(?:-|$)/.exec(str(v));
  var y = m ? +m[1] : null;
  return y !== null && y >= 1880 && y <= 2100 ? y : null;
}

/* ---------- where the view ended up ---------- */

function movedToDisney(url) {
  var h = hostOf(url);
  return !!h && hostIs(h, 'disneyplus.com');
}
function signedOutByUrl(url) {
  var h = hostOf(url);
  var p = pathOf(url);
  if (p === null) return false;
  if (h && (hostIs(h, 'auth.hulu.com') || hostIs(h, 'signup.hulu.com'))) return true;
  if (p === '') return true;   // the bare marketing landing page
  return /^\/(welcome|login|log-in|signup|sign-up|start|account\/login)(\/|$)/.test(p);
}
function profilePickerByUrl(url) {
  var p = pathOf(url);
  return p !== null && /^\/(profiles?(\/select)?|profile-picker|whos-watching|who-is-watching)(\/|$)/.test(p);
}

/* ---------- collections ---------- */

function nameOf(node) {
  var v = obj(node && node.visuals) || {};
  return shape.cleanText(shape.textOf(node && node.name) || shape.textOf(v.headline) || shape.textOf(node && node.title) ||
    shape.textOf(node && node.headline), 120);
}

/**
 * Every collection-like node across the captures (a node with an items[] array that is not an
 * item), merged by id (a lazily fetched view_hubs collection fills the one the hub listed), in
 * page order: hub responses first.
 */
function collectRows(captures) {
  var order = [];
  var byId = {};
  var list = Array.isArray(captures) ? captures.filter(function (c) { return obj(c) && okStatus(c) && (!c.url || isContent(c)); }) : [];
  var hubs = list.filter(function (c) { return !/\/view_hubs\//i.test(capUrl(c)); });
  var lazy = list.filter(function (c) { return hubs.indexOf(c) === -1; });
  var synthetic = 0;

  function entryFor(id) {
    if (id && byId[id]) return byId[id];
    var e = { id: id, name: '', hint: '', items: [], keys: {} };
    if (id) byId[id] = e;
    order.push(e);
    return e;
  }

  hubs.concat(lazy).forEach(function (c) {
    var m = /\/collections?\/([^\/?#]+)/i.exec(capUrl(c));
    var urlId = m ? decodeURIComponent(m[1]) : '';
    shape.walk(c.json, function (node, key, parent, depth) {
      if (!obj(node) || !Array.isArray(node.items)) return;
      var t = str(node._type) || str(node.type);
      if (/^(view|episode|series|movie)$/i.test(t)) return;   // an item that happens to carry items
      var id = str(node.id) || (typeof node.id === 'number' ? String(node.id) : '') || (depth === 0 ? urlId : '');
      var e = entryFor(id);
      if (!e.name) e.name = nameOf(node);
      e.hint += ' ' + [t, str(node.theme), str(node.layout), str(node.style), str(node.collection_type)].join(' ');
      for (var i = 0; i < node.items.length; i++) {
        var it = node.items[i];
        if (!obj(it)) continue;
        if (Array.isArray(it.items) && !obj(it.entity_metadata) && !obj(it.visuals)) continue;   // a nested row: the walk reaches it
        var k = itemKey(it) || 'n:' + (synthetic++);
        if (e.keys[k]) continue;
        e.keys[k] = true;
        e.items.push(it);
      }
    });
  });
  return order;
}

function itemKey(it) {
  var a = browseOf(it);
  return str(a.target_id) || str(a.targetId) || str(it.id) || '';
}

/** { kind, page } for a row on the home hub (page 'home') or the My Stuff page (page 'mystuff'), or null. */
function classify(row, page) {
  if (!row) return null;
  var hint = row.hint || '';
  if (DECOY_RE.test(hint)) return null;
  var text = (row.name || '') + ' ' + hint;
  if (DECOY_RE.test(row.name || '') && !RESUME_RE.test(text) && !WATCHLIST_RE.test(text)) return null;
  if (page === 'mystuff') {
    if (RESUME_RE.test(text) || REC_RE.test(text)) return null;   // the home hub has those
    return { kind: 'watchlist' };
  }
  if (RESUME_RE.test(text)) return { kind: 'resume' };
  if (WATCHLIST_RE.test(text)) return { kind: 'watchlist' };
  if (REC_RE.test(text)) return { kind: 'rec' };
  return null;
}

/* ---------- items ---------- */

function browseOf(raw) {
  var actions = obj(raw.actions) || {};
  return obj(actions.browse) || obj(raw.browse) || {};
}

function typeWord(v) {
  var t = str(v).toLowerCase();
  if (!t) return '';
  if (/movie|film/.test(t)) return 'movie';
  if (/episode/.test(t)) return 'episode';
  if (/series|show|season|program/.test(t)) return 'series';
  return 'other:' + t;
}

function kindOf(raw, meta) {
  var b = browseOf(raw);
  var mi = obj(raw.metrics_info) || obj(raw.metricsInfo) || {};
  var t = typeWord(first(str(meta.entity_type), str(meta.entityType), str(raw.entity_type), str(raw.entityType),
    /^view$/i.test(str(raw._type)) ? '' : str(raw._type), str(raw.type)));
  if (!t) t = typeWord(first(str(b.target_type), str(b.targetType), str(mi.target_type), str(mi.targetType)));
  return t;
}

/** The title page for an item: { type: 'series'|'movie', id } from its own fields, or null. */
function pageOf(raw, meta, kind) {
  var b = browseOf(raw);
  var mi = obj(raw.metrics_info) || obj(raw.metricsInfo) || {};
  var bt = typeWord(first(str(b.target_type), str(b.targetType)));
  var href = first(str(b.href), str(raw.href), str(b.url));
  var hm = /\/(series|movie)\/([^\/?#]+)/i.exec(href || '');
  if (hm && uuidOf(hm[2])) return { type: hm[1].toLowerCase(), id: uuidOf(hm[2]) };
  var series = uuidOf(first(str(meta.series_id), str(meta.seriesId), str(raw.series_id), str(raw.seriesId)));
  if (kind === 'episode' && series) return { type: 'series', id: series };
  if (bt === 'series' || bt === 'movie') {
    var bid = uuidOf(first(str(b.target_id), str(b.targetId)));
    if (bid) return { type: bt, id: bid };
  }
  if (kind === 'episode') return null;   // an episode with no show to open: nothing honest to link
  if (kind === 'series' || kind === 'movie') {
    var id = uuidOf(first(str(b.target_id), str(b.targetId), str(mi.target_id), str(mi.targetId), str(raw.id)));
    if (id) return { type: kind, id: id };
  }
  return null;
}

function genresOf(raw, meta) {
  var g = first(meta.genre_names, meta.genreNames, raw.genre_names, raw.genreNames, raw.genres, meta.genres);
  if (!Array.isArray(g)) return [];
  return g.map(function (x) { return typeof x === 'string' ? x : shape.textOf(obj(x) && x.name); }).filter(Boolean);
}

function pickImage(raw) {
  var v = obj(raw.visuals) || {};
  var roots = [obj(v.artwork), obj(raw.artwork), obj(v.art)].filter(Boolean);
  var SKIP = /logo|title|brand|network|vertical|poster|portrait|2x3|icon/i;
  var WIDE = /horizontal|16x9|tile|hero|landscape|thumb/i;
  var best = '';
  var bestRank = 9;
  function pathIn(a) { return a ? (str(a.path) || str(a.url) || str(obj(a.image) && a.image.path)) : ''; }
  function offer(p, trail) {
    if (!p) return;
    var rank = WIDE.test(trail) ? 1 : 5;
    if (rank < bestRank) { bestRank = rank; best = p; }
  }
  // artwork.<kind>.path, artwork.<kind>.image.path, or one level deeper (artwork.program.tile.path).
  roots.forEach(function (root) {
    Object.keys(root).forEach(function (k) {
      if (SKIP.test(k)) return;
      var a = obj(root[k]);
      if (!a) return;
      offer(pathIn(a), k);
      Object.keys(a).forEach(function (k2) {
        if (SKIP.test(k2) || k2 === 'image') return;
        offer(pathIn(obj(a[k2])), k + '.' + k2);
      });
    });
  });
  var url = shape.cleanHttps(best);
  if (!url) return '';
  if (/(^|\.)hulu\.com$/i.test(hostOf(url)) && /\/artwork\//i.test(url) && !/[?&]size=/i.test(url)) {
    url += (url.indexOf('?') === -1 ? '?' : '&') + IMG_SIZE;
  }
  return url;
}

/** 0..1 watched from Hulu's personalization block, or null. bookmark and duration are seconds. */
function progressOf(raw, meta, durationSec) {
  var p = obj(raw.personalization) || obj(raw.userState) || obj(raw.user_state) || {};
  var pct = first(num(p.progress_percentage), num(p.progressPercentage), num(p.percent_watched), num(p.percentWatched),
    num(p.percent_complete), num(p.percentComplete));
  if (pct !== null && pct >= 0 && pct <= 100) return pct / 100;
  var dur = first(num(p.duration), durationSec);
  var mark = first(num(p.bookmark), num(p.bookmark_position), num(p.bookmarkPosition), num(p.resume_position), num(p.resumePosition),
    num(p.position), num(p.playhead));
  if (mark !== null && dur !== null && dur > 0 && mark >= 0) return Math.min(1, mark / dur);
  var plain = num(p.progress);
  if (plain !== null && plain >= 0) return plain > 1 ? (plain <= 100 ? plain / 100 : null) : plain;
  return null;
}

function locked(raw) {
  var a = obj(raw.actions) || {};
  var p = obj(raw.personalization) || {};
  return !!(obj(a.upsell) || a.upsell === true || p.locked === true || p.is_locked === true || raw.locked === true || raw.is_locked === true);
}

function parseItem(raw, row, cls) {
  if (!obj(raw)) return null;
  var v = obj(raw.visuals) || {};
  var meta = obj(raw.entity_metadata) || obj(raw.entityMetadata) || {};
  var kind = kindOf(raw, meta);
  if (/^other:/.test(kind)) return null;   // a network, hub, genre or live-channel tile: not a title
  var seriesName = shape.textOf(first(meta.series_name, meta.seriesName, raw.series_name, raw.seriesName));
  var season = num(first(meta.season, meta.season_number, meta.seasonNumber, raw.season, raw.seasonNumber));
  var number = num(first(meta.episode_number, meta.episodeNumber, meta.number, raw.number, raw.episode_number));
  // A Keep Watching tile often browses to the SHOW while it carries the episode he is on.
  if (kind !== 'movie' && seriesName && number !== null) kind = 'episode';
  var page = pageOf(raw, meta, kind);
  if (!page) return null;
  if (!kind) kind = page.type;
  if (cls.kind === 'rec' && locked(raw)) return null;   // not in his plan: no use as a recommendation

  var ownName = shape.textOf(first(meta.name, raw.name, (obj(raw.metrics_info) || {}).target_name));
  var headline = shape.textOf(v.headline);
  var isEpisode = kind === 'episode';
  var title = shape.cleanText(isEpisode ? (seriesName || headline) : (headline || ownName));
  if (!title) return null;

  var sub = '';
  var premiere = yearOf(first(meta.premiere_date, meta.premiereDate, raw.premiere_date, raw.premiereDate, raw.release_year, meta.release_year));
  var year = null;
  if (isEpisode) {
    if (season !== null && number !== null) sub = 'S' + season + ' E' + number;
    else if (number !== null) sub = 'E' + number;
    var epName = shape.cleanText(ownName && ownName !== title ? ownName : '');
    if (epName) sub = sub ? sub + ' · ' + epName : epName;
    year = yearOf(first(meta.series_premiere_date, meta.seriesPremiereDate, raw.series_premiere_date, raw.seriesPremiereDate));
  } else {
    year = premiere;
    var g = genresOf(raw, meta);
    sub = [g.slice(0, 2).join(', '), year !== null ? String(year) : ''].filter(Boolean).join(' · ');
  }

  var bundle = obj(raw.bundle) || obj(meta.bundle) || {};
  var durationSec = first(num(bundle.duration), num(raw.duration), num(meta.duration));

  return {
    id: ID + ':' + page.id,
    service: ID,
    kind: cls.kind,
    title: title,
    subtitle: sub,
    image: pickImage(raw),
    progress: cls.kind === 'resume' ? progressOf(raw, meta, durationSec) : null,
    url: SITE + '/' + page.type + '/' + page.id,
    startsAt: null,
    durationSec: durationSec !== null && durationSec > 0 ? Math.round(durationSec) : null,
    badge: '',
    group: row.name || '',
    year: year,
    type: page.type === 'movie' ? 'movie' : 'show'
  };
}

/* ---------- profile ---------- */

function profileOf(captures) {
  var name = '';
  (Array.isArray(captures) ? captures : []).forEach(function (c) {
    if (name || !obj(c) || !okStatus(c) || (c.url && !isProfile(c) && !isContent(c))) return;
    shape.walk(c.json, function (node, key) {
      if (name) return false;
      if ((key === 'current_profile' || key === 'currentProfile' || key === 'active_profile' || key === 'activeProfile') && obj(node) && str(node.name)) {
        name = node.name;
        return false;
      }
      if (obj(node) && str(node.name) && (node.is_current === true || node.isCurrent === true || node.current === true || node.selected === true) &&
          isProfile(c)) {
        name = node.name;
        return false;
      }
    });
  });
  return shape.cleanText(name, 60);
}

/* ---------- the read ---------- */

function errorReason(e, step, budget) {
  var detail = shape.cleanText(typeof e.detail === 'string' ? e.detail : (e.detail != null ? String(e.detail) : ''), 80);
  switch (e.code) {
    case 'timeout': return 'timed out after ' + Math.round(budget / 1000) + ' s';
    case 'offline': return "you're offline, so Quartz couldn't reach hulu.com";
    case 'load-failed': return "the hulu.com page didn't load" + (detail ? ' (' + detail + ')' : '');
    case 'http': {
      var status = num(step.status);
      return 'hulu.com answered HTTP ' + (status !== null ? status : (detail || 'error'));
    }
    case 'bad-json': return "hulu.com sent page data that wasn't valid JSON";
    case 'crashed': return 'the hidden reader page crashed';
    default: return 'the reader failed (' + (shape.cleanText(String(e.code || 'unknown'), 30) || 'unknown') + ')';
  }
}

function fail(reason, extra) {
  var out = { state: 'error', reason: reason, items: [], profile: '' };
  if (extra) out.counts = extra;
  return out;
}

function stepView(step) {
  var ex = obj(step.extracted) || {};
  var captures = Array.isArray(step.captures) ? step.captures.filter(function (c) { return obj(c); }) : [];
  return { ex: ex, finalUrl: str(step.finalUrl) || str(ex.url) || '', captures: captures, content: captures.filter(isContent) };
}

/** Items from one page's rows. */
function rowsToItems(captures, page, counts) {
  var items = [];
  var matched = 0;
  var matchedRaw = 0;
  collectRows(captures).forEach(function (row) {
    var cls = classify(row, page);
    if (!cls) return;
    matched++;
    matchedRaw += row.items.length;
    var n = 0;
    // My Stuff's own tabs ("TV", "Movies") are one list to Watch: its name is the page's.
    var named = page === 'mystuff' ? { name: 'My Stuff' } : row;
    for (var i = 0; i < row.items.length && n < PER_ROW; i++) {
      var it = parseItem(row.items[i], named, cls);
      if (it) { items.push(it); n++; }
    }
  });
  if (counts) { counts.rows += matched; counts.items += items.length; }
  return { items: items, matched: matched, matchedRaw: matchedRaw };
}

/** The optional My Stuff page: its items, or a warning saying why it is missing. */
function readMyStuff(step) {
  if (!step) return { items: [], warning: '' };
  var sv = stepView(step);
  if (signedOutByUrl(sv.finalUrl)) return { items: [], warning: 'My Stuff asked Quartz to sign in again' };
  var e = obj(step.error);
  var got = rowsToItems(sv.captures, 'mystuff', null);
  if (got.items.length || (got.matched > 0 && got.matchedRaw === 0)) return { items: got.items, warning: '' };
  if (e) return { items: [], warning: "My Stuff didn't load (" + errorReason(e, step, MY_STUFF_BUDGET_MS) + ')' };
  if (!sv.content.length) return { items: [], warning: 'My Stuff loaded but sent no rows' };
  return { items: [], warning: 'My Stuff loaded but none of its rows matched (Hulu changed its layout?)' };
}

function parseRead(read) {
  var r = obj(read);
  var steps = r && obj(r.steps);
  var step = steps && obj(steps.home);
  if (!step) return fail('the reader returned no hulu.com page');

  var sv = stepView(step);
  var counts = { responses: sv.captures.length, content: sv.content.length, rows: 0, items: 0 };

  // 1. Where the view ended up beats everything.
  var urls = [sv.finalUrl, str(sv.ex.url)].filter(Boolean);
  if (urls.some(movedToDisney)) return fail(MOVED_REASON, counts);
  if (urls.some(signedOutByUrl)) return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [], profile: '', counts: counts };
  if (urls.some(profilePickerByUrl)) return fail(PICKER_REASON, counts);

  // 2. The reader itself failed (a timeout may still have captured rows; read them).
  var e = obj(step.error);
  if (e && e.code !== 'timeout') return fail(errorReason(e, step, BUDGET_MS), counts);

  // 3. The rows: the home hub, then My Stuff.
  var home = rowsToItems(sv.captures, 'home', counts);
  var hasWatchlist = home.items.some(function (it) { return it.kind === 'watchlist'; });
  var mine = readMyStuff(obj(steps.mystuff));
  var items = home.items.concat(mine.items);
  counts.items = items.length;
  var profile = profileOf(sv.captures);
  var warnings = [];
  if (mine.warning && !hasWatchlist) warnings.push(mine.warning);

  if (home.items.length) return { state: 'ok', reason: '', items: items, profile: profile, counts: counts, warnings: warnings };

  // 4. Signed out, told by the data rather than the URL.
  var unauthorized = sv.content.length > 0 && sv.content.every(function (c) { var s = num(c.status); return s === 401 || s === 403; });
  if (unauthorized || (sv.content.length === 0 && sv.ex.login === true)) {
    return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [], profile: '', counts: counts };
  }
  if (e) return fail(errorReason(e, step, BUDGET_MS), counts);

  // 5. Hulu sent his rows and they are simply empty (a new profile): not a failure.
  if (home.matched > 0 && home.matchedRaw === 0) return { state: 'ok', reason: '', items: items, profile: profile, counts: counts, warnings: warnings };

  // 6. Data came back and none of it matched.
  var n = sv.captures.length;
  return fail('the page loaded but no Keep Watching data matched (Hulu changed its layout?) (' +
    n + (n === 1 ? ' response' : ' responses') + ' read)', counts);
}

function parse(read, ctx) {
  try {
    return parseRead(read, ctx);
  } catch (err) {
    return fail('the Hulu reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')');
  }
}

/* Stop waiting once Keep Watching and a row of picks have both arrived with items. */
function enoughHome(captures) {
  try {
    var resume = false;
    var rec = false;
    collectRows(captures).forEach(function (row) {
      var cls = classify(row, 'home');
      if (!cls || !row.items.length) return;
      if (cls.kind === 'resume') resume = true;
      if (cls.kind === 'rec') rec = true;
    });
    return resume && rec;
  } catch (err) {
    return false;
  }
}

function enoughMyStuff(captures) {
  try {
    return collectRows(captures).some(function (row) { var c = classify(row, 'mystuff'); return !!c && row.items.length > 0; });
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
    enough: enoughHome,
    settleMs: 4000,
    scroll: 3,
    budgetMs: BUDGET_MS
  }, {
    name: 'mystuff',
    type: 'view',
    url: MY_STUFF,
    extract: EXTRACT,
    ready: ready,
    capture: [CONTENT_RE],
    enough: enoughMyStuff,
    settleMs: 2500,
    scroll: 1,
    budgetMs: MY_STUFF_BUDGET_MS,
    optional: true
  }];
}

module.exports = {
  id: ID,
  steps: steps,
  parse: parse,
  // For the tests.
  _internal: {
    EXTRACT: EXTRACT, CONTENT_RE: CONTENT_RE, PROFILE_RE: PROFILE_RE, classify: classify, collectRows: collectRows,
    signedOutByUrl: signedOutByUrl, profilePickerByUrl: profilePickerByUrl, movedToDisney: movedToDisney,
    SIGNED_OUT_REASON: SIGNED_OUT_REASON, MOVED_REASON: MOVED_REASON
  }
};
