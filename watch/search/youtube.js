'use strict';
/*
 * watch/search/youtube.js -- the CHANNELS on YouTube's public results page, for Lumen's one
 * search box (pure). The videos come from youtube.js's parseSearch (the same page, the same
 * one cookie-less fetch); this reads the channelRenderer tiles youtube.js skips on purpose.
 *
 * Shape (public results page, ytInitialData): channelRenderer { channelId, title.simpleText,
 * navigationEndpoint.browseEndpoint.canonicalBaseUrl ('/@handle'), thumbnail.thumbnails[],
 * subscriberCountText / videoCountText } -- YouTube moved the subscriber count between those
 * two fields in 2024, so whichever says "subscribers" is used.
 */
var shape = require('../shape');
var yt = require('../adapters/youtube');

var ORIGIN = 'https://www.youtube.com';
var MAX = 6;
var CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{20,24}$/;
var HANDLE_RE = /^\/@[A-Za-z0-9._%-]{1,100}$/;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

function channelFrom(r) {
  var name = shape.cleanText(shape.textOf(r.title), 100);
  if (!name) return null;
  var id = typeof r.channelId === 'string' && CHANNEL_ID_RE.test(r.channelId) ? r.channelId : '';
  var nav = obj(r.navigationEndpoint) || {};
  var be = obj(nav.browseEndpoint) || {};
  var handle = typeof be.canonicalBaseUrl === 'string' && HANDLE_RE.test(be.canonicalBaseUrl) ? be.canonicalBaseUrl : '';
  var url = handle ? ORIGIN + handle : (id ? ORIGIN + '/channel/' + id : '');
  if (!url) return null;
  var thumbs = obj(r.thumbnail) && Array.isArray(r.thumbnail.thumbnails) ? r.thumbnail.thumbnails : [];
  var image = '';
  for (var i = thumbs.length - 1; i >= 0 && !image; i--) {
    var u = obj(thumbs[i]) ? String(thumbs[i].url || '') : '';
    if (u.indexOf('//') === 0) u = 'https:' + u;
    image = shape.cleanHttps(u);
  }
  var texts = [shape.textOf(r.subscriberCountText), shape.textOf(r.videoCountText)].map(function (t) { return shape.cleanText(t, 60); });
  var subs = texts.filter(function (t) { return /subscriber/i.test(t); })[0] || '';
  var handleText = texts.filter(function (t) { return /^@/.test(t); })[0] || (handle ? handle.slice(1) : '');
  return { id: id || handle, name: name, url: url, image: image, subs: subs, handle: shape.cleanText(handleText, 100) };
}

function parseChannels(html) {
  try {
    var data = yt._internals.findInitialData(html);
    if (!data) return [];
    var out = [];
    var seen = {};
    shape.walk(data, function (node, key) {
      if (out.length >= MAX) return false;
      if (key === 'channelRenderer' && obj(node)) {
        var c = channelFrom(node);
        if (c && !seen[c.url]) { seen[c.url] = true; out.push(c); }
        return false;
      }
      return true;
    });
    return out;
  } catch (err) {
    return [];
  }
}

module.exports = { parseChannels: parseChannels };
