'use strict';
/*
 * watch/shows/prime.js -- a Prime Video detail page (a season of a show, or a film) for Lumen's
 * show page (pure).
 *
 * How: one hidden reader view loads https://www.primevideo.com/detail/<id>/ on Quartz's session
 * and reads the state the page embeds in its HTML, as prime.js does for the home page: the
 * hydration JSON (<script id="dv-web-page-hydration-data">) and any <script type="text/template">
 * JSON the detail page renders from. No extra request is made; read-only. Each season is its own
 * detail page on Prime (REPLACEMENT-PLAN.md section 1), so the season tabs it does not carry
 * episodes for open that season's own page.
 *
 * Shape (hand-made fixture tests/watch-show-fixtures/prime-detail.json, from the field names
 * prime.js reads and public detail-page scrapers; NOT checked against a signed-in account): a
 * header detail { titleID, title, synopsis, releaseYear, ratingBadge.displayText, genres[],
 * entityType, images.covershot|heroshot, isInWatchlist | watchlistAction }, seasons
 * [{ seasonNumber, displayName, seasonLink | link.url }], episodes [{ titleID, title,
 * episodeNumber, seasonNumber, synopsis, runtimeSeconds | runtime, images.packshot,
 * progress / completionPercentage / timecodeSeconds, isWatched }], and "Customers also watched"
 * containers of entities. Progress names are matched by prime.js's own tolerant progressOf.
 */
var shape = require('../shape');
var play = require('../playurl');
var base = require('../adapters/prime');
var X = base._search;
var I = base._internals;

var ORIGIN = 'https://www.primevideo.com';
var BUDGET_MS = 18000;
var MORE_RE = /customers also watched|more like this|you may also like|related|people also watched|similar/i;

function pageExtract() {
  var CAP = 2500000;
  var DROP = { modelDebug: 1, station: 1, schedule: 1, impressionData: 1, itemAnalytics: 1, refMarker: 1, strings: 1,
    journeyIngressContext: 1, serviceToken: 1, token: 1, playbackEnvelope: 1, featureSwitches: 1, customerReviews: 1, overflowMenu: 1 };
  function prune(v, depth) {
    if (depth > 90) return null;
    if (typeof v === 'string') return v.length > 4000 ? '' : v;
    if (!v || typeof v !== 'object') return v;
    var i;
    if (Array.isArray(v)) { var a = []; for (i = 0; i < v.length; i++) a.push(prune(v[i], depth + 1)); return a; }
    var o = {}, ks = Object.keys(v);
    for (i = 0; i < ks.length; i++) if (DROP[ks[i]] !== 1) o[ks[i]] = prune(v[ks[i]], depth + 1);
    return o;
  }
  function slim(text) {
    try { var s = JSON.stringify(prune(JSON.parse(text), 0)); return s.length > CAP ? '' : s; } catch (e) { return ''; }
  }
  var out = { url: '', title: '', blobs: [], signedIn: null, signInPage: false, robot: false, complete: false };
  try {
    var doc = document;
    out.url = String(location.href || '');
    out.title = String(doc.title || '');
    out.complete = doc.readyState === 'complete';
    var h = doc.getElementById('dv-web-page-hydration-data');
    if (h) { var s1 = slim(String(h.textContent || '')); if (s1) out.blobs.push(s1); }
    var tpl = doc.querySelectorAll('script[type="text/template"]');
    for (var i = 0; i < tpl.length && out.blobs.length < 8; i++) {
      var t = String(tpl[i].textContent || '');
      if (t.length < 200 || !/"(synopsis|episodeNumber|seasonNumber)"/.test(t)) continue;
      var s2 = slim(t);
      if (s2) out.blobs.push(s2);
    }
    var st = doc.getElementById('dv-web-global-store-data');
    if (st) {
      try { var rc = JSON.parse(String(st.textContent || '')).RequestContext; if (rc && typeof rc.customerID === 'string' && rc.customerID) out.signedIn = true; else if (rc && rc.customerID === null) out.signedIn = false; } catch (e) { /* fine */ }
    }
    if (out.signedIn === null && doc.querySelector('[data-testid="pv-nav-sign-in"]')) out.signedIn = false;
    out.signInPage = /\/ap\/(signin|mfa|cvf)|\/auth-redirect/i.test(String(location.pathname || '')) || !!doc.querySelector('#ap_email');
    out.robot = /validateCaptcha/i.test(String(location.pathname || '')) || /robot check/i.test(out.title) || !!doc.querySelector('#captchacharacters');
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 200); }
  return out;
}
var EXTRACT = '(' + pageExtract.toString() + ')()';
function ready(x) { return !!(x && typeof x === 'object' && (x.blobs && x.blobs.length || x.robot || x.signInPage || x.complete)); }

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return parseFloat(v); return null; }
function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i]; return null; }
function txt(v) { return shape.textOf ? shape.textOf(v) : str(v); }
function linkOf(e) { var l = e && e.link; return typeof l === 'string' ? l : (obj(l) && str(l.url)) || str(e && e.seasonLink) || str(e && e.href); }
function detailIdOf(href) { var m = /\/detail\/(?:[^\/?#]+\/)?([A-Za-z0-9]{8,40})(?:[\/?#]|$)/.exec(str(href)); return m ? m[1] : ''; }
function abs(href) { var h = str(href); if (!h) return ''; if (/^https:\/\//i.test(h)) return shape.cleanHttps(h); return h.charAt(0) === '/' ? ORIGIN + h : ''; }
function pathOf(u) { try { return new URL(u).pathname; } catch (e) { return ''; } }
function titleUrl(req) { return ORIGIN + '/detail/' + encodeURIComponent(req.id) + '/'; }

function imageOf(e) {
  var im = obj(e.images) || obj(e.image) || {};
  var pick = first(obj(im.heroshot) && im.heroshot.url, obj(im.covershot) && im.covershot.url, obj(im.cover) && im.cover.url,
    obj(im.packshot) && im.packshot.url, obj(im.hero) && im.hero.url, str(im.heroshot), str(im.covershot), str(im.packshot), str(e.imageUrl));
  return shape.cleanHttps(str(pick));
}

function runtimeOf(v) {
  var n = num(v);
  if (n !== null) return n > 100000 ? Math.round(n / 1000) : n;
  var m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*min)?/i.exec(str(v));
  if (!m || (!m[1] && !m[2])) return null;
  return ((+m[1] || 0) * 60 + (+m[2] || 0)) * 60;
}

function watchlistOf(e) {
  if (e.isInWatchlist === true || e.inWatchlist === true) return true;
  if (e.isInWatchlist === false || e.inWatchlist === false) return false;
  var wa = obj(e.watchlistAction) || obj(e.watchlistButton);
  if (!wa) return null;
  var s = JSON.stringify(wa).toLowerCase();
  if (/remove/.test(s)) return true;
  if (/"add|addtowatchlist|add to watchlist/.test(s)) return false;
  return null;
}

function parseShow(read, req) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.title);
  if (!step) return { state: 'error', reason: 'the reader returned no Prime Video page', show: null };
  var ex = obj(step.extracted) || {};
  if (ex.robot) return { state: 'error', reason: X.REASON_ROBOT, show: null };
  if (ex.signInPage || X.isSignInPath(pathOf(str(step.finalUrl) || str(ex.url)))) return { state: 'signed-out', reason: 'sign in to Prime Video in Quartz to see this title', show: null };
  var roots = (Array.isArray(ex.blobs) ? ex.blobs : []).map(function (b) { var p = X.parseJsonish(b); return p.ok ? p.value : null; }).filter(Boolean);
  if (!roots.length) {
    var e0 = obj(step.error);
    if (e0) return { state: 'error', reason: X.reasonForError(e0, num(step.status) || 0, BUDGET_MS), show: null };
    return { state: 'error', reason: 'the Prime Video page loaded but its page data was missing (Prime Video changed its layout?)', show: null };
  }
  var header = null, headerScore = -1;
  var episodes = [], epSeen = {};
  var seasons = {};
  var more = [], moreSeen = {};
  var counts = { progress: 0 };
  roots.forEach(function (root) {
    shape.walk(root, function (node, key) {
      if (!obj(node)) return;
      var title = txt(node.title) || txt(node.displayTitle);
      var tid = str(first(node.titleID, node.titleId, node.gti));
      if (title && node.synopsis !== undefined && num(node.episodeNumber) === null) {
        var score = (tid === req.id ? 4 : 0) + (node.releaseYear ? 1 : 0) + (node.entityType ? 1 : 0) + (obj(node.ratingBadge) ? 1 : 0);
        if (score > headerScore) { header = node; headerScore = score; }
      }
      var en = num(node.episodeNumber);
      if (en !== null && title) {
        var k = tid || ('e' + en + title);
        if (!epSeen[k]) {
          epSeen[k] = true;
          var p = I.progressOf(node);
          var watched = node.isWatched === true || node.completed === true || node.watched === true ? true : null;
          if (p !== null || watched) counts.progress++;
          var own = abs(linkOf(node));
          episodes.push({ id: tid, s: num(node.seasonNumber), e: en, title: title, synopsis: txt(node.synopsis), runtimeSec: runtimeOf(first(node.runtimeSeconds, node.durationSeconds, node.runtime, node.duration)),
            image: imageOf(node), progress: p, watched: watched, url: play.primeAutoplayUrl(own, ORIGIN) || '' });
        }
      }
      var sn = num(node.seasonNumber);
      if (sn !== null && en === null && (linkOf(node) || node.displayName)) {
        var sid = detailIdOf(linkOf(node)) || tid;
        if (!seasons[sn]) seasons[sn] = { n: sn, label: txt(node.displayName) || '', url: sid ? ORIGIN + '/detail/' + sid + '/' : '', id: sid };
      }
      if (Array.isArray(node.entities) && MORE_RE.test(txt(node.title) || txt(node.text))) {
        node.entities.forEach(function (m) {
          if (!obj(m)) return;
          var did = detailIdOf(linkOf(m));
          if (!did || did === req.id || moreSeen[did]) return;
          moreSeen[did] = true;
          var et = str(m.entityType);
          more.push({ title: txt(m.title) || txt(m.displayTitle), image: imageOf(m), url: ORIGIN + '/detail/' + did + '/', service: 'prime', year: num(m.releaseYear), type: /movie/i.test(et) ? 'movie' : /tv|show|season|series/i.test(et) ? 'show' : '' });
        });
      }
    });
  });
  if (!header && !episodes.length) {
    return { state: 'error', reason: 'the Prime Video detail page loaded but no title data matched (Prime Video changed its layout?)', show: null };
  }
  var h = header || {};
  var hereSeason = num(h.seasonNumber);
  episodes.forEach(function (ep) { if (ep.s === null) ep.s = hereSeason !== null ? hereSeason : 1; });
  var bySeason = {};
  episodes.forEach(function (ep) { (bySeason[ep.s] = bySeason[ep.s] || []).push(ep); });
  Object.keys(bySeason).forEach(function (n) { if (!seasons[n]) seasons[n] = { n: +n, label: '', url: n == hereSeason ? titleUrl(req) : '', id: '' }; });
  var et = str(first(h.entityType, h.titleType, h.contentType));
  var type = req.type === 'movie' || /movie/i.test(et) ? 'movie' : (req.type === 'show' || /tv|show|season|series|episode/i.test(et) || episodes.length ? 'show' : 'movie');
  var seasonList = Object.keys(seasons).map(function (n) { var s = seasons[n]; return { n: s.n, label: s.label, url: s.url, episodes: bySeason[n] || [], loaded: !!bySeason[n] }; });
  var notes = [];
  if (type === 'show' && episodes.length && !counts.progress) notes.push("Prime Video didn't say which episodes you've watched");
  var genres = (Array.isArray(h.genres) ? h.genres : []).map(function (g) { return typeof g === 'string' ? g : txt(obj(g) && (g.text || g.name)); });
  var rb = obj(h.ratingBadge) || obj(h.maturityRating) || {};
  var mp = type === 'movie' ? I.progressOf(h) : null;
  return {
    state: 'ok', reason: '', show: {
      service: 'prime', type: type, id: req.id, url: titleUrl(req),
      title: shape.cleanText(txt(first(h.parentTitle, h.showTitle)) || txt(h.title) || req.title, 200) || req.title,
      year: num(h.releaseYear) || req.year || null, rating: str(first(rb.displayText, rb.text, h.rating)), synopsis: shape.cleanText(txt(h.synopsis), 600),
      genres: genres, image: imageOf(h), runtimeSec: type === 'movie' ? runtimeOf(first(h.runtimeSeconds, h.runtime, h.duration)) : null,
      seasons: seasonList, resume: null, progress: mp, watched: type === 'movie' && (h.isWatched === true) ? true : null,
      playUrl: type === 'movie' ? (play.primeAutoplayUrl(abs(linkOf(h)), ORIGIN) || '') : '',
      more: more, watchlist: watchlistOf(h), progressKnown: counts.progress > 0 || mp !== null, source: 'service', notes: notes
    }
  };
}

function parse(read, req) {
  try { return parseShow(read, req); } catch (err) {
    return { state: 'error', reason: 'the Prime Video show reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', show: null };
  }
}

function steps(req) {
  return [{ name: 'title', type: 'view', url: titleUrl(req), extract: EXTRACT, ready: ready, settleMs: 1200, budgetMs: BUDGET_MS }];
}

module.exports = { id: 'prime', steps: steps, parse: parse, titleUrl: titleUrl, _internal: { EXTRACT: EXTRACT, pageExtract: pageExtract, runtimeOf: runtimeOf } };
