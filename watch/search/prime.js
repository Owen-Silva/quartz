'use strict';
/*
 * watch/search/prime.js -- Prime Video's own search, for Lumen's one search box (pure).
 *
 * How: one hidden reader view loads https://www.primevideo.com/search/ref=atv_nb_sr?phrase=<q>
 * on Quartz's default session and reads the page state Prime Video embeds in the HTML
 * (dv-web-page-hydration-data), with prime.js's own page-side extract (heavy keys dropped in
 * the page). No extra request is made.
 *
 * Shape: the search page's hydration carries containers with entities like the storefront's
 * (titleID, title, link.url /detail/<id>, images, entitlementCues). Entitled = included with
 * Prime; "rent or buy" and channel subscriptions are said from Prime's own cues. NOT checked
 * against a signed-in account; fixture only.
 */
var shape = require('../shape');
var base = require('../adapters/prime');
var X = base._search;

var ID = 'prime';
var ORIGIN = 'https://www.primevideo.com';
var BUDGET_MS = 15000;
var MAX = 40;
var SIGNED_OUT_REASON = 'sign in to Prime Video in Quartz to search it';

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }

function searchUrl(q) {
  return ORIGIN + '/search/ref=atv_nb_sr?phrase=' + encodeURIComponent(shape.cleanText(String(q || ''), 200)) + '&ie=UTF8';
}

function parseSearch(read) {
  var r = obj(read);
  var step = r && obj(r.steps) && obj(r.steps.search);
  if (!step) return { state: 'error', reason: 'the reader returned nothing', items: [] };
  var x = step.extracted;
  if (typeof x === 'string') x = { hydration: x };
  x = obj(x) || {};
  var fp = X.urlParts(str(step.finalUrl) || str(x.url) || str(step.url));
  var path = fp ? fp.path : '';
  var title = str(step.title) || str(x.title);
  if (X.isSignInPath(path) || x.signInPage === true) return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [] };
  if (x.robot === true || X.isCaptchaPath(path) || /robot check/i.test(title)) return { state: 'error', reason: X.REASON_ROBOT, items: [] };
  var hyd = X.parseJsonish(x.hydration);
  var storeP = X.parseJsonish(x.store);
  var auth = X.storeAuth(storeP.ok ? obj(storeP.value) : null);
  if (auth === null && x.signedIn === false) auth = false;
  if (!hyd.ok) {
    if (auth === false) return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [] };
    if (step.error) return { state: 'error', reason: X.reasonForError(step.error, step.status, BUDGET_MS), items: [] };
    return { state: 'error', reason: "Prime Video's search page loaded but its page data was missing (Prime Video changed its layout?)", items: [] };
  }
  // Prime's search works signed out too, but then "included" would be a guess: say sign in.
  if (auth === false || (auth === null && X.hasSignInCta(hyd.value))) return { state: 'signed-out', reason: SIGNED_OUT_REASON, items: [] };

  var counts = { skipped: { hero: 0, decoy: 0, rent: 0, channel: 0, noLink: 0, noTitle: 0, dupe: 0 } };
  var items = [];
  var seen = {};
  X.findContainers(hyd.value).forEach(function (c) {
    if (X.DECOY_CONTAINER.test(str(c.containerType))) return;
    for (var j = 0; j < c.entities.length && items.length < MAX; j++) {
      var e = c.entities[j];
      var it = X.itemFrom(e, c, 'search', '', counts);
      if (!it || seen[it.id]) continue;
      seen[it.id] = true;
      var ent = X.entitlementOf(obj(e) || {}, c);
      it.offer = ent.entitled === true ? 'included' : (ent.offer === 'rent' ? 'rent' : (ent.offer === 'channel' ? 'channel' : (ent.entitled === false ? 'upgrade' : '')));
      it.badge = '';
      items.push(it);
    }
  });
  if (items.length) return { state: 'ok', reason: '', items: items };
  return { state: 'empty', reason: '', items: [] };
}

function parse(read) {
  try { return parseSearch(read); } catch (err) {
    return { state: 'error', reason: 'the Prime Video search reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', items: [] };
  }
}

function steps(q) {
  return [{ name: 'search', type: 'view', url: searchUrl(q), extract: X.EXTRACT, ready: X.ready, settleMs: 1200, budgetMs: BUDGET_MS }];
}

module.exports = { id: ID, steps: steps, parse: parse, searchUrl: searchUrl };
