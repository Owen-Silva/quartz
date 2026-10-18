'use strict';
/*
 * watch/shows/disney.js -- a Disney+ title page (series or film) for Lumen's show page (pure).
 *
 * How: one hidden reader view loads https://www.disneyplus.com/browse/entity-<id> (the title page
 * the rows already link) on Quartz's session, and the reader captures, over CDP, the JSON the page
 * fetches for itself: the explore page "entity-<id>", the season sets it loads, and the userState
 * call that carries progress (disney.js's header has the sources). Nothing here calls Disney's
 * API itself; read-only.
 *
 * Shape (hand-made fixture tests/watch-show-fixtures/disney-entity.json, from pydisney and
 * slyguy.disney.plus as disney.js reads them; NOT checked against a signed-in account):
 *   data.page { id: 'entity-<id>', visuals { title, description { brief|medium|full },
 *     metastringParts { releaseYearRange.startYear, ratingInfo.rating.text, genres.values,
 *     runtime.runtimeMs }, artwork }, actions [{ type: 'playback', visuals.displayText
 *     'Continue S1 E5' }, { type: 'modifySaves'|'watchlist', ... }],
 *     containers [{ type: 'episodes', seasons [{ id, visuals.name 'Season 1', items [episode] }] },
 *       { type: 'set', visuals.name 'Suggested' | 'More Like This', items [tiles] }] }
 *   episode: visuals { episodeTitle, seasonNumber, episodeNumber, durationMs, description, artwork },
 *     personalization.pid -> userState data.entityStates[pid].progress { progressPercentage }.
 *   A later season the page loads: /explore/v1.x/season/<seasonId> -> data.season.items.
 * Play: Disney+'s episode player address is not proven (watch/playurl.js), so every play opens
 * this title page in the layer; the big button still says which episode is next.
 */
var shape = require('../shape');
var base = require('../adapters/disney');
var X = base._search;

var SITE = 'https://www.disneyplus.com';
var BUDGET_MS = 18000;
var CAPTURE_RE = /\/explore\/v[\d.]+\/(page|set|season|userState|hydration)\b/i;
var MORE_RE = /suggested|more like this|you might also like|similar|recommend|because you/i;
var EXTRAS_RE = /extras|bonus|trailer/i;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return parseFloat(v); return null; }
function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i]; return null; }
function capUrl(c) { return str(c && c.url); }
function okStatus(c) { var s = num(c && c.status); return s === null || s === 0 || (s >= 200 && s < 300); }
function txt(v) { return shape.textOf ? shape.textOf(v) : str(v); }
function descOf(d) { return obj(d) ? str(first(d.full, d.medium, d.brief)) : str(d); }

function titleUrl(req) { return SITE + '/browse/entity-' + encodeURIComponent(req.id); }

function collectStates(caps) {
  var states = {};
  caps.forEach(function (c) {
    shape.walk(c.json, function (node, key) {
      if (key !== 'entityStates') return;
      if (Array.isArray(node)) node.forEach(function (s) { var pid = obj(s) && (str(s.pid) || str(s.id)); if (pid) states[pid] = s; });
      else if (obj(node)) Object.keys(node).forEach(function (k) { if (obj(node[k])) states[k] = node[k]; });
      return false;
    });
  });
  return states;
}

function stateOf(raw, states) {
  var pers = obj(raw.personalization) || {};
  var k = str(pers.pid) || str(raw.pid) || str(raw.id);
  return k && states[k] ? states[k] : null;
}

function episodeOf(raw, states, counts) {
  var v = obj(raw.visuals) || {};
  var s = num(v.seasonNumber), e = num(v.episodeNumber);
  var durMs = num(first(v.durationMs, obj(v.metastringParts) && obj(v.metastringParts.runtime) && v.metastringParts.runtime.runtimeMs));
  var it = X.parseItem(raw, { name: '' }, { kind: 'resume' }, states);
  var st = stateOf(raw, states);
  var p = it && typeof it.progress === 'number' ? it.progress : null;
  if (st) counts.progress++;
  if (st && p === null) p = 0;
  var pr = st && obj(st.progress);
  var watched = st && (st.watched === true || st.isWatched === true || (pr && pr.completed === true)) ? true : null;
  return {
    id: str(raw.id), s: s, e: e, title: shape.cleanText(txt(v.episodeTitle) || txt(v.title), 200),
    synopsis: shape.cleanText(descOf(v.description), 400), runtimeSec: durMs !== null ? Math.round(durMs / 1000) : null,
    image: it ? it.image : '', progress: p, watched: watched, url: ''
  };
}

function seasonNumberOf(season, items) {
  var v = obj(season.visuals) || {};
  var n = num(first(season.seasonNumber, v.seasonNumber));
  if (n === null) { var m = /season\s+(\d{1,3})/i.exec(txt(v.name) || str(season.name)); n = m ? +m[1] : null; }
  if (n === null && items.length) n = num(obj(items[0].visuals) && items[0].visuals.seasonNumber);
  return n;
}

function parseShow(read, req) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.title);
  if (!step) return { state: 'error', reason: 'the reader returned no Disney+ page', show: null };
  var ex = obj(step.extracted) || {};
  var finalUrl = str(step.finalUrl) || str(ex.url);
  if (X.signedOutByUrl(finalUrl)) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, show: null };
  if (X.profilePickerByUrl(finalUrl)) return { state: 'error', reason: X.PICKER_REASON, show: null, picker: true };
  var caps = (Array.isArray(step.captures) ? step.captures : []).filter(function (c) { return obj(c) && CAPTURE_RE.test(capUrl(c)) && okStatus(c) && c.json; });
  var states = collectStates(caps);
  var counts = { progress: 0 };
  var page = null;
  var seasons = {};
  var more = [];
  var moreSeen = {};
  var actions = [];
  caps.forEach(function (c) {
    shape.walk(c.json, function (node, key) {
      if (!obj(node)) return;
      if (!page && key === 'page' && str(node.id).replace(/^entity-/i, '') === req.id) page = node;
      if (Array.isArray(node.seasons)) {
        node.seasons.forEach(function (sz) {
          if (!obj(sz)) return;
          var items = (Array.isArray(sz.items) ? sz.items : []).filter(obj);
          var n = seasonNumberOf(sz, items);
          if (n === null) return;
          var slot = seasons[n] = seasons[n] || { n: n, label: txt(obj(sz.visuals) && sz.visuals.name), id: str(sz.id), episodes: [] };
          items.forEach(function (raw) { slot.episodes.push(episodeOf(raw, states, counts)); });
        });
      }
      if (key === 'season' && Array.isArray(node.items)) {
        var items2 = node.items.filter(obj);
        var n2 = seasonNumberOf(node, items2);
        if (n2 !== null) {
          var slot2 = seasons[n2] = seasons[n2] || { n: n2, label: txt(obj(node.visuals) && node.visuals.name), id: str(node.id), episodes: [] };
          items2.forEach(function (raw) { slot2.episodes.push(episodeOf(raw, states, counts)); });
        }
      }
      var name = txt(obj(node.visuals) && node.visuals.name) || str(node.name);
      if (Array.isArray(node.items) && !Array.isArray(node.seasons) && key !== 'season' && MORE_RE.test(name) && !EXTRAS_RE.test(name)) {
        node.items.forEach(function (raw) {
          var it = X.parseItem(raw, { name: name }, { kind: 'rec' }, states);
          if (!it || moreSeen[it.url] || it.url.indexOf(req.id) !== -1) return;
          moreSeen[it.url] = true;
          more.push({ title: it.title, image: it.image, url: it.url, service: 'disney', year: it.year, type: it.type });
        });
      }
    });
  });
  if (page && Array.isArray(page.actions)) actions = page.actions.filter(obj);
  var seasonList = Object.keys(seasons).map(function (k) { var s = seasons[k]; return { n: s.n, label: s.label, episodes: s.episodes, loaded: s.episodes.length > 0 }; });
  if (!page && !seasonList.length) {
    var e = obj(step.error);
    if (e) return { state: 'error', reason: X.errorReason(e, step), show: null };
    if (ex.login === true) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, show: null };
    return { state: 'error', reason: 'the Disney+ title page loaded but sent nothing Lumen could read (Disney+ changed its layout?)', show: null };
  }
  var v = obj(page && page.visuals) || {};
  var meta = obj(v.metastringParts) || {};
  var rng = obj(meta.releaseYearRange) || {};
  var rating = obj(meta.ratingInfo) && obj(meta.ratingInfo.rating) ? str(meta.ratingInfo.rating.text) : '';
  var genres = obj(meta.genres) && Array.isArray(meta.genres.values) ? meta.genres.values : [];
  var runMs = obj(meta.runtime) ? num(meta.runtime.runtimeMs) : null;
  var type = req.type === 'movie' || (!seasonList.length && runMs !== null) ? 'movie' : 'show';
  // "Continue S1 E5" / "Resume" on the page's own play button: where he is
  var resume = null;
  var movieProgress = null;
  var watchlist = null;
  actions.forEach(function (a) {
    var t = str(a.type).toLowerCase();
    var label = txt(obj(a.visuals) && first(a.visuals.displayText, a.visuals.title)) || str(a.displayText);
    if (t === 'playback' || t === 'play') {
      var m = /\bS(\d{1,3})\s*:?\s*E(\d{1,4})\b/i.exec(label);
      if (m && /continue|resume/i.test(label)) resume = { s: +m[1], e: +m[2] };
      if (type === 'movie' && /continue|resume/i.test(label)) resume = { s: null, e: null };
      var st = stateOf(a, states);
      if (type === 'movie' && st) { var pp = obj(st.progress) && num(st.progress.progressPercentage); if (pp !== null) movieProgress = pp / 100; }
    }
    if (/watchlist|modifysaves|saves/.test(t)) {
      var w = str(first(a.watchlistType, a.modifySavesType, a.mode, a.subtype)).toLowerCase();
      if (/remove|delete|saved|in/.test(w) || /remove/i.test(label)) watchlist = true;
      else if (/add/.test(w) || /add|\+/i.test(label)) watchlist = false;
    }
  });
  var notes = [];
  if (type === 'show' && seasonList.length && !counts.progress) notes.push("Disney+ didn't say which episodes you've watched");
  var heroIt = page ? X.parseItem(page, { name: '' }, { kind: 'watchlist' }, states) : null;
  return {
    state: 'ok', reason: '', show: {
      service: 'disney', type: type, id: req.id, url: titleUrl(req),
      title: shape.cleanText(txt(v.title) || req.title, 200) || req.title,
      year: num(rng.startYear) || req.year || null, rating: rating, synopsis: shape.cleanText(descOf(v.description), 600),
      genres: genres.filter(function (g) { return typeof g === 'string'; }), image: heroIt ? heroIt.image : '',
      runtimeSec: runMs !== null ? Math.round(runMs / 1000) : null,
      seasons: seasonList, resume: resume, progress: movieProgress, watched: null, playUrl: '',
      more: more, watchlist: watchlist, progressKnown: counts.progress > 0 || movieProgress !== null, source: 'service', notes: notes
    }
  };
}

function parse(read, req) {
  try { return parseShow(read, req); } catch (err) {
    return { state: 'error', reason: 'the Disney+ show reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', show: null };
  }
}

function enough(captures) {
  try {
    var page = false, states = false;
    (Array.isArray(captures) ? captures : []).forEach(function (c) {
      if (!obj(c) || !okStatus(c)) return;
      if (/\/explore\/v[\d.]+\/page\/entity-/i.test(capUrl(c))) page = true;
      if (/\/userState\b/i.test(capUrl(c))) states = true;
    });
    return page && states;
  } catch (err) { return false; }
}

function steps(req) {
  return [{ name: 'title', type: 'view', url: titleUrl(req), extract: X.EXTRACT, ready: X.ready, capture: [CAPTURE_RE], enough: enough, settleMs: 2500, budgetMs: BUDGET_MS }];
}

module.exports = { id: 'disney', steps: steps, parse: parse, titleUrl: titleUrl, _internal: { CAPTURE_RE: CAPTURE_RE, episodeOf: episodeOf } };
