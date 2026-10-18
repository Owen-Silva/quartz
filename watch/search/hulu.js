'use strict';
/*
 * watch/search/hulu.js -- hulu.com's own search, for Lumen's one search box (pure).
 *
 * How: one hidden reader view loads https://www.hulu.com/search?q=<what he typed> on Quartz's
 * default session and the reader captures, over CDP, the search JSON the page fetches for
 * itself from discover.hulu.com (/content/v5/search/...). Nothing here calls Hulu's API itself.
 * Items are read with hulu.js's own tolerant parser (snake_case API and camelCase page model).
 *
 * Shape: the search answer groups results (groups[].results[] or a flat results[] / items[]),
 * each result an entity tile like the hub's (entity_metadata, visuals, actions.browse,
 * personalization). NOT checked against a signed-in account; fixture only. A locked tile
 * (actions.upsell, personalization.locked) is not in his plan.
 */
var shape = require('../shape');
var base = require('../adapters/hulu');
var X = base._search;

var ID = 'hulu';
var SITE = 'https://www.hulu.com';
var BUDGET_MS = 15000;
var MAX = 40;
var SEARCH_RE = /\/content\/v\d+\/search\b/i;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function capUrl(c) { return str(c && c.url); }
function status(c) { var s = Number(c && c.status); return isFinite(s) ? s : 0; }
function okStatus(c) { var s = status(c); return s === 0 || (s >= 200 && s < 300); }

function searchUrl(q) {
  return SITE + '/search?q=' + encodeURIComponent(shape.cleanText(String(q || ''), 200));
}

function looksLikeTile(it) {
  return obj(it) && (obj(it.entity_metadata) || obj(it.entityMetadata) || obj(it.visuals) || obj(it.actions) || obj(it.metrics_info));
}

/* Every result tile in a search answer, in the page's order. */
function itemsOf(json) {
  var out = [];
  shape.walk(json, function (node) {
    if (!obj(node)) return;
    ['results', 'items', 'entities'].forEach(function (k) {
      if (!Array.isArray(node[k])) return;
      for (var i = 0; i < node[k].length; i++) if (looksLikeTile(node[k][i])) out.push(node[k][i]);
    });
  });
  return out;
}

function parseSearch(read) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.search);
  if (!step) return { state: 'error', reason: 'the reader returned no hulu.com page', items: [] };
  var sv = X.stepView(step);
  if (X.movedToDisney(sv.finalUrl)) return { state: 'error', reason: 'hulu.com sent Lumen to Disney+: Hulu plays inside Disney+ for this account, so its titles are in the Disney+ row', items: [] };
  if (X.signedOutByUrl(sv.finalUrl)) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  if (X.profilePickerByUrl(sv.finalUrl)) return { state: 'error', reason: X.PICKER_REASON, items: [] };
  var caps = sv.captures.filter(function (c) { return SEARCH_RE.test(capUrl(c)); });
  if (caps.length && caps.every(function (c) { return status(c) === 401 || status(c) === 403; })) {
    return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  }
  var items = [];
  var seen = {};
  caps.filter(okStatus).forEach(function (c) {
    itemsOf(c.json).forEach(function (raw) {
      if (items.length >= MAX) return;
      var it = X.parseItem(raw, { name: '' }, { kind: 'search' });
      if (!it || seen[it.id]) return;
      seen[it.id] = true;
      it.offer = X.locked(raw) ? 'upgrade' : 'included';
      items.push(it);
    });
  });
  var e = obj(step.error);
  if (items.length) return { state: 'ok', reason: '', items: items };
  if (e && e.code !== 'timeout') return { state: 'error', reason: X.errorReason(e, step, BUDGET_MS), items: [] };
  if (!caps.length && sv.ex.login === true) return { state: 'signed-out', reason: X.SIGNED_OUT_REASON, items: [] };
  if (caps.some(okStatus)) return { state: 'empty', reason: '', items: [] };
  if (e) return { state: 'error', reason: X.errorReason(e, step, BUDGET_MS), items: [] };
  return { state: 'error', reason: "hulu.com's search page loaded but sent no results Lumen could read (Hulu changed its layout?)", items: [] };
}

function parse(read) {
  try { return parseSearch(read); } catch (err) {
    return { state: 'error', reason: 'the Hulu search reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', items: [] };
  }
}

function enough(captures) {
  try {
    return (Array.isArray(captures) ? captures : []).some(function (c) { return obj(c) && SEARCH_RE.test(capUrl(c)) && okStatus(c) && itemsOf(c.json).length > 0; });
  } catch (err) { return false; }
}

function steps(q) {
  return [{
    name: 'search', type: 'view', url: searchUrl(q), extract: X.EXTRACT, ready: X.ready,
    capture: [SEARCH_RE], enough: enough, settleMs: 2500, budgetMs: BUDGET_MS
  }];
}

module.exports = { id: ID, steps: steps, parse: parse, searchUrl: searchUrl, _internal: { SEARCH_RE: SEARCH_RE, itemsOf: itemsOf, enough: enough } };
