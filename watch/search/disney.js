'use strict';
/*
 * watch/search/disney.js -- Disney+'s own search, for Lumen's one search box (pure).
 *
 * How: one hidden reader view loads https://www.disneyplus.com/search?q=<what he typed> on
 * Quartz's default session, as his own browser would, and the reader captures the explore
 * search JSON the page fetches for itself over CDP (/explore/v1.x/search?query=...). Nothing
 * here calls Disney's API itself. Items are read with disney.js's own tolerant parser, so a
 * search tile and a row tile are the same shape.
 *
 * Shape: the explore search answer is a page of containers whose items are the same explore
 * items the home rows carry (pydisney, slyguy.disney.plus: data.page.containers[].items[]
 * with visuals, actions, artwork). NOT checked against a signed-in account; fixture only.
 * A title whose actions include an upsell is not in his plan ("Not in your plan").
 */
var shape = require('../shape');
var base = require('../adapters/disney');
var X = base._search;

var ID = 'disney';
var SITE = 'https://www.disneyplus.com';
var BUDGET_MS = 15000;
var MAX = 40;
var SEARCH_RE = /\/explore\/v[\d.]+\/search\b/i;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function capUrl(c) { return str(c && c.url); }
function status(c) { var s = Number(c && c.status); return isFinite(s) ? s : 0; }
function okStatus(c) { var s = status(c); return s === 0 || (s >= 200 && s < 300); }
function hasQuery(c) { return /[?&](query|q)=/i.test(capUrl(c)); }

function searchUrl(q) {
  return SITE + '/search?q=' + encodeURIComponent(shape.cleanText(String(q || ''), 200));
}

/* The search answers worth reading: those that carry the query when there are any (the page's
   own "explore" landing, fetched before the query runs, is trending titles, not results). */
function searchCaptures(captures) {
  var list = Array.isArray(captures) ? captures.filter(function (c) { return obj(c) && SEARCH_RE.test(capUrl(c)); }) : [];
  var withQ = list.filter(hasQuery);
  return withQ.length ? withQ : list;
}

/* Every explore item in a search answer, in the page's order. */
function itemsOf(json) {
  var out = [];
  shape.walk(json, function (node) {
    if (!obj(node) || !Array.isArray(node.items)) return;
    for (var i = 0; i < node.items.length; i++) {
      var it = node.items[i];
      if (obj(it) && (obj(it.visuals) || Array.isArray(it.actions))) out.push(it);
    }
  });
  return out;
}

function parseSearch(read) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.search);
  if (!step) return { state: 'error', reason: 'the reader returned no Disney+ page', items: [] };
  var ex = obj(step.extracted) || {};
  var finalUrl = str(step.finalUrl) || str(ex.url);
  if (X.signedOutByUrl(finalUrl)) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  if (X.profilePickerByUrl(finalUrl)) return { state: 'error', reason: X.PICKER_REASON, items: [] };
  var caps = searchCaptures(step.captures);
  var e = obj(step.error);
  if (caps.length && caps.every(function (c) { return status(c) === 401 || status(c) === 403; })) {
    return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  }
  var items = [];
  var seen = {};
  caps.filter(okStatus).forEach(function (c) {
    itemsOf(c.json).forEach(function (raw) {
      if (items.length >= MAX) return;
      var it = X.parseItem(raw, { name: '' }, { kind: 'search', badge: '', group: '' }, {});
      if (!it || seen[it.id]) return;
      seen[it.id] = true;
      it.offer = X.hasUpsell(raw) ? 'upgrade' : 'included';
      items.push(it);
    });
  });
  if (items.length) return { state: 'ok', reason: '', items: items };
  if (e && e.code !== 'timeout') return { state: 'error', reason: X.errorReason(e, step), items: [] };
  if (!caps.length && ex.login === true) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  if (caps.some(okStatus)) return { state: 'empty', reason: '', items: [] };
  if (e) return { state: 'error', reason: X.errorReason(e, step), items: [] };
  return { state: 'error', reason: "Disney+'s search page loaded but sent no results Lumen could read (Disney+ changed its layout?)", items: [] };
}

function parse(read) {
  try { return parseSearch(read); } catch (err) {
    return { state: 'error', reason: 'the Disney+ search reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', items: [] };
  }
}

/* Stop waiting once an answer that carries the query has items. */
function enough(captures) {
  try {
    var caps = searchCaptures(captures);
    return caps.some(function (c) { return hasQuery(c) && okStatus(c) && itemsOf(c.json).length > 0; });
  } catch (err) { return false; }
}

function steps(q) {
  return [{
    name: 'search', type: 'view', url: searchUrl(q), extract: X.EXTRACT, ready: X.ready,
    capture: [SEARCH_RE], enough: enough, settleMs: 2500, budgetMs: BUDGET_MS
  }];
}

module.exports = { id: ID, steps: steps, parse: parse, searchUrl: searchUrl, _internal: { SEARCH_RE: SEARCH_RE, itemsOf: itemsOf, enough: enough } };
