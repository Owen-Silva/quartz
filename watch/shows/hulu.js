'use strict';
/*
 * watch/shows/hulu.js -- a Hulu series or movie page for Lumen's show page (pure).
 *
 * How: one hidden reader view loads https://www.hulu.com/series/<uuid> (or /movie/<uuid>) on
 * Quartz's session, and the reader captures, over CDP, the JSON the page fetches for itself from
 * discover.hulu.com: the title's hub (/content/v5/hubs/series/<id>) and the season collections it
 * lazily loads (/content/v5/hubs/series/<id>/collections/<n>, the href hulu.js's header records).
 * The page's own embedded model (__NEXT_DATA__, camelCase) is read too: the public, logged-out
 * page carries the episodes there. Nothing here calls Hulu's API itself; read-only.
 *
 * Shape (hand-made fixture tests/watch-show-fixtures/hulu-series.json, from the fields hulu.js
 * already parses, NOT checked against a signed-in account): the hub's details.entity (name,
 * description, premiere_date, rating.code, genre_names, artwork), episodes as entity tiles
 * (_type episode, id, name, description, season, number, duration, personalization.bookmark /
 * progress_percentage / eab), the season list as collection tabs (series_grouping_metadata.
 * season_number or a "Season N" name), "You may also like" as a collection, and the title's
 * My Stuff state as personalization.is_in_my_stuff or the add/remove action it offers.
 */
var shape = require('../shape');
var play = require('../playurl');
var base = require('../adapters/hulu');
var X = base._search;

var SITE = 'https://www.hulu.com';
var BUDGET_MS = 18000;
var CONTENT_RE = /\/content\/v\d+\/(hubs|view_hubs|collections?|entity|entities)\b/i;
var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
var MORE_RE = /you may also like|more like this|similar|recommend|because you|related/i;
var NEXT_CAP = 1500000;

/* The page side: where it ended up, the log-in CTA, and the page's own model when it has one. */
var EXTRACT = '(function () {' +
  ' try {' +
  '  var q = function (s) { try { return document.querySelector(s); } catch (e) { return null; } };' +
  '  var cta = q(\'a[href*="/login"], a[href*="auth.hulu.com"], [data-automationid="login-button"], [data-testid="login-button"]\');' +
  '  var nd = q(\'script#__NEXT_DATA__\'); var t = nd ? String(nd.textContent || \'\') : \'\';' +
  '  return { url: String(location.href || \'\'), title: String(document.title || \'\').slice(0, 300), login: !!cta, next: t.length <= ' + NEXT_CAP + ' ? t : \'\' };' +
  ' } catch (e) {' +
  '  return { url: \'\', title: \'\', login: null, next: \'\', error: String((e && e.message) || e).slice(0, 200) };' +
  ' }' +
  '})()';

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return parseFloat(v); return null; }
function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i]; return null; }
function uuidOf(s) { var m = UUID_RE.exec(str(s)); return m ? m[1].toLowerCase() : ''; }
function capUrl(c) { return str(c && c.url); }
function okStatus(c) { var s = num(c && c.status); return s === null || s === 0 || (s >= 200 && s < 300); }
function typeOf(n) { return str(first(n._type, n.type, obj(n.entity_metadata) && n.entity_metadata.entity_type, obj(n.entityMetadata) && n.entityMetadata.entityType)).toLowerCase(); }
function yearOf(v) { var m = /^\s*(\d{4})/.exec(str(v)); var y = m ? +m[1] : (typeof v === 'number' ? v : null); return y && y >= 1880 && y <= 2100 ? y : null; }

function titleUrl(req) { return SITE + '/' + (req.type === 'movie' ? 'movie' : 'series') + '/' + req.id; }

/* Every JSON root the read gave: the captured hub answers, then the page's own model. */
function rootsOf(step) {
  var sv = X.stepView(step);
  var roots = sv.captures.filter(function (c) { return CONTENT_RE.test(capUrl(c)) && okStatus(c) && c.json; }).map(function (c) { return c.json; });
  var next = str(sv.ex.next);
  if (next) { try { roots.push(JSON.parse(next)); } catch (e) { /* not JSON: the captures are enough */ } }
  return { sv: sv, roots: roots };
}

function artOf(raw) {
  // hulu.js's own picker wants an item; an entity's artwork reads the same way
  var it = X.parseItem({ _type: 'movie', id: '00000000-0000-4000-8000-000000000000', name: 'art', visuals: raw.visuals, artwork: raw.artwork }, { name: '' }, { kind: 'rec' });
  return it ? it.image : '';
}

function textOf(v) { return shape.textOf ? shape.textOf(v) : str(v); }

function progressOf(raw, durationSec) {
  var p = obj(raw.personalization) || obj(raw.userState) || obj(raw.user_state);
  if (!p) return { p: null, known: false };
  var pct = first(num(p.progress_percentage), num(p.progressPercentage), num(p.percent_watched), num(p.percentWatched));
  if (pct !== null && pct >= 0 && pct <= 100) return { p: pct / 100, known: true };
  var dur = first(num(p.duration), durationSec);
  var mark = first(num(p.bookmark), num(p.bookmark_position), num(p.bookmarkPosition), num(p.resume_position), num(p.position));
  if (mark !== null && dur && dur > 0) return { p: Math.min(1, Math.max(0, mark / dur)), known: true };
  if (p.watched === true || p.is_watched === true || p.completed === true) return { p: 1, known: true };
  return { p: 0, known: true };   // a personalization block with no bookmark: not started
}

function watchedOf(raw) {
  var p = obj(raw.personalization) || {};
  if (p.watched === true || p.is_watched === true || p.completed === true || p.isWatched === true) return true;
  if (p.watched === false || p.is_watched === false) return false;
  return null;
}

function episodeOf(raw, counts) {
  var meta = obj(raw.entity_metadata) || obj(raw.entityMetadata) || {};
  var s = num(first(raw.season, raw.season_number, raw.seasonNumber, meta.season, meta.season_number));
  var e = num(first(raw.number, raw.episode_number, raw.episodeNumber, meta.episode_number, meta.number));
  var bundle = obj(raw.bundle) || {};
  var dur = first(num(raw.duration), num(bundle.duration), num(meta.duration));
  if (dur !== null && dur > 100000) dur = Math.round(dur / 1000);   // milliseconds
  var pr = progressOf(raw, dur);
  if (pr.known) counts.progress++;
  var id = uuidOf(raw.id) || uuidOf(obj(raw.metrics_info) && raw.metrics_info.target_id);
  var playId = play.huluPlayId(raw) || id;
  var v = obj(raw.visuals) || {};
  return {
    id: id, s: s, e: e,
    title: shape.cleanText(textOf(first(raw.name, meta.name, v.headline, raw.title)), 200),
    synopsis: shape.cleanText(textOf(first(raw.description, meta.description, v.body, raw.synopsis)), 400),
    runtimeSec: dur, image: artOf(raw), progress: pr.known ? pr.p : null, watched: watchedOf(raw),
    url: play.huluWatchUrl(playId)
  };
}

function seasonNumberOf(node) {
  var g = obj(node.series_grouping_metadata) || obj(node.seriesGroupingMetadata) || {};
  var n = num(first(g.season_number, g.seasonNumber, node.season_number, node.seasonNumber));
  if (n === null) { var m = /^\s*season\s+(\d{1,3})\s*$/i.exec(str(first(node.name, obj(node.visuals) && textOf(node.visuals.headline)))); n = m ? +m[1] : null; }
  return n !== null && n >= 0 && n <= 200 ? n : null;
}

function watchlistOf(entity, roots) {
  var found = null;
  function look(n) {
    var p = obj(n.personalization) || {};
    var flag = first(p.is_in_my_stuff, p.isInMyStuff, p.in_my_stuff, p.saved, n.is_in_my_stuff);
    if (flag === true || flag === false) return flag;
    var a = obj(n.actions) || {};
    if (obj(a.remove_from_my_stuff) || obj(a.removeFromMyStuff)) return true;
    if (obj(a.add_to_my_stuff) || obj(a.addToMyStuff)) return false;
    return null;
  }
  if (entity) found = look(entity);
  if (found === null) roots.forEach(function (r) { if (found === null && obj(r)) found = look(r); });
  return found;
}

function parseShow(read, req) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.title);
  if (!step) return { state: 'error', reason: 'the reader returned no hulu.com page', show: null };
  var got = rootsOf(step);
  var sv = got.sv;
  if (X.movedToDisney(sv.finalUrl)) return { state: 'error', reason: 'hulu.com sent Lumen to Disney+: Hulu plays inside Disney+ for this account', show: null };
  if (X.signedOutByUrl(sv.finalUrl)) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, show: null };
  if (X.profilePickerByUrl(sv.finalUrl)) return { state: 'error', reason: X.PICKER_REASON, show: null, picker: true };

  var counts = { progress: 0 };
  var entity = null;
  var episodes = [];
  var epSeen = {};
  var seasonNs = {};
  var more = [];
  var moreSeen = {};
  var resumeId = '';
  got.roots.forEach(function (root) {
    shape.walk(root, function (node) {
      if (!obj(node)) return;
      var t = typeOf(node);
      var id = uuidOf(node.id);
      if (!entity && (t === 'series' || t === 'movie') && id === req.id && first(node.name, node.description)) entity = node;
      if (t === 'episode') {
        var ep = episodeOf(node, counts);
        var k = ep.id || ('s' + ep.s + 'e' + ep.e);
        if ((ep.e !== null || ep.title) && !epSeen[k]) { epSeen[k] = true; episodes.push(ep); }
      }
      var sn = seasonNumberOf(node);
      if (sn !== null && (Array.isArray(node.items) || obj(node.model) || obj(node.series_grouping_metadata) || /^season/i.test(str(node.name)))) seasonNs[sn] = true;
      var rz = first(str(node.resume_entity_id), str(node.resumeEntityId), str(obj(node.resume) && node.resume.id), str(obj(node.up_next) && node.up_next.id));
      if (!resumeId && uuidOf(rz)) resumeId = uuidOf(rz);
      if (Array.isArray(node.items) && MORE_RE.test(str(first(node.name, obj(node.visuals) && textOf(node.visuals.headline))))) {
        node.items.forEach(function (raw) {
          var it = X.parseItem(raw, { name: '' }, { kind: 'rec' });
          if (!it || moreSeen[it.url] || it.url.indexOf(req.id) !== -1) return;
          moreSeen[it.url] = true;
          more.push({ title: it.title, image: it.image, url: it.url, service: 'hulu', year: it.year, type: it.type || (/\/movie\//.test(it.url) ? 'movie' : 'show') });
        });
      }
    });
  });

  if (!entity && !episodes.length) {
    var e = obj(step.error);
    if (e && e.code !== 'timeout') return { state: 'error', reason: X.errorReason(e, step, BUDGET_MS), show: null };
    if (e) return { state: 'error', reason: 'timed out after ' + Math.round(BUDGET_MS / 1000) + ' s', show: null };
    return { state: 'error', reason: "the hulu.com title page loaded but sent nothing Lumen could read (Hulu changed its layout?)", show: null };
  }
  var en = entity || {};
  var type = req.type === 'movie' || typeOf(en) === 'movie' ? 'movie' : 'show';
  var bySeason = {};
  episodes.forEach(function (ep) { var s = ep.s === null ? 1 : ep.s; ep.s = s; (bySeason[s] = bySeason[s] || []).push(ep); seasonNs[s] = true; });
  var seasons = Object.keys(seasonNs).map(Number).map(function (n) { return { n: n, episodes: bySeason[n] || [], loaded: !!bySeason[n] }; });
  var resume = null;
  if (resumeId) episodes.forEach(function (ep) { if (ep.id === resumeId) resume = { s: ep.s, e: ep.e }; });
  var rating = obj(en.rating) ? str(first(en.rating.code, en.rating.display)) : str(first(en.rating, en.content_rating));
  var signedOut = sv.ex.login === true && !counts.progress;
  var dur = first(num(en.duration), num(obj(en.bundle) && en.bundle.duration));
  var mp = type === 'movie' ? progressOf(en, dur) : { p: null, known: false };
  var notes = [];
  if (signedOut) notes.push('Signed out of hulu.com in Quartz, so Hulu showed no progress');
  else if (type === 'show' && episodes.length && !counts.progress) notes.push("Hulu didn't say which episodes you've watched");
  return {
    state: 'ok', reason: '', show: {
      service: 'hulu', type: type, id: req.id, url: titleUrl(req),
      title: shape.cleanText(textOf(first(en.name, obj(en.visuals) && textOf(en.visuals.headline), en.series_name, req.title)), 200) || req.title,
      year: yearOf(first(en.premiere_date, en.premiereDate, en.release_year)) || req.year || null,
      rating: rating, synopsis: shape.cleanText(textOf(first(en.description, en.synopsis, obj(en.visuals) && en.visuals.body)), 600),
      genres: (Array.isArray(first(en.genre_names, en.genreNames, en.genres)) ? first(en.genre_names, en.genreNames, en.genres) : []).map(function (g) { return typeof g === 'string' ? g : textOf(obj(g) && g.name); }),
      image: artOf(en), runtimeSec: type === 'movie' ? dur : null,
      seasons: seasons, resume: resume, progress: mp.known ? mp.p : null, watched: type === 'movie' ? watchedOf(en) : null,
      playUrl: type === 'movie' ? play.huluWatchUrl(play.huluPlayId(en) || req.id) : '',
      more: more, watchlist: watchlistOf(entity, got.roots), progressKnown: counts.progress > 0 || mp.known, source: 'service', notes: notes
    }
  };
}

function parse(read, req) {
  try { return parseShow(read, req); } catch (err) {
    return { state: 'error', reason: 'the Hulu show reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', show: null };
  }
}

function enough(captures) {
  try {
    return (Array.isArray(captures) ? captures : []).some(function (c) {
      if (!obj(c) || !CONTENT_RE.test(capUrl(c)) || !okStatus(c)) return false;
      var hit = false;
      shape.walk(c.json, function (n) { if (!hit && obj(n) && /^episode$/i.test(str(n._type))) hit = true; });
      return hit;
    });
  } catch (err) { return false; }
}

function steps(req) {
  return [{ name: 'title', type: 'view', url: titleUrl(req), extract: EXTRACT, ready: X.ready, capture: [CONTENT_RE], enough: req.type === 'movie' ? undefined : enough, settleMs: 2500, budgetMs: BUDGET_MS }];
}

module.exports = { id: 'hulu', steps: steps, parse: parse, titleUrl: titleUrl, _internal: { EXTRACT: EXTRACT, CONTENT_RE: CONTENT_RE, episodeOf: episodeOf } };
