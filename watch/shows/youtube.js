'use strict';
/*
 * watch/shows/youtube.js -- a series-like YouTube playlist as a Lumen show page (pure).
 *
 * How: the same playlist read watch/ytlib.js already does for the Library (one hidden view of
 * youtube.com/playlist?list=<id> on Quartz's session, ytInitialData read in the page), turned into
 * the SHOW shape: one "season" whose episodes are the playlist's videos in its own order, each
 * with YouTube's own watched bar (progress), playing at watch?v=<id>&list=<list> (YouTube's own
 * address, proven). Watch Later, Liked videos and mixes are not shows (model.js playlistIdOf).
 */
var shape = require('../shape');
var L = require('../ytlib');

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }

function titleUrl(req) { return L.playlistUrl(req.id); }

function steps(req) { return L.playlistSteps(req.id); }

function parse(read, req) {
  try {
    var r = L.parsePlaylist(read, req.id);
    if (r.state !== 'ok') return { state: r.state === 'signed-out' ? 'signed-out' : 'error', reason: r.reason || 'the playlist could not be read', show: null };
    var head = obj(r.playlist) || {};
    var eps = (Array.isArray(r.items) ? r.items : []).map(function (it, i) {
      var vid = str(it.vid);
      var p = typeof it.progress === 'number' ? it.progress : null;
      return {
        id: vid, s: 1, e: i + 1, title: shape.cleanText(it.title, 200), synopsis: shape.cleanText(obj(it.channel) ? it.channel.name : '', 120),
        runtimeSec: it.durationSec || null, image: it.image || '', progress: p, watched: null,
        url: !L.isVideoId(vid) ? '' : str(it.url).indexOf('https://www.youtube.com/watch?') === 0 ? str(it.url) + (/[?&]list=/.test(str(it.url)) ? '' : '&list=' + encodeURIComponent(req.id))
          : 'https://www.youtube.com/watch?v=' + vid + '&list=' + encodeURIComponent(req.id)
      };
    });
    if (!eps.length) return { state: 'error', reason: 'the playlist has no videos Lumen can show', show: null };
    var owner = shape.cleanText(head.owner || '', 120);
    return {
      state: 'ok', reason: '', show: {
        service: 'youtube', type: 'show', id: req.id, url: titleUrl(req), title: shape.cleanText(head.title || req.title, 200) || req.title,
        year: null, rating: '', synopsis: [owner ? 'A playlist by ' + owner : 'A YouTube playlist', head.count ? head.count : ''].filter(Boolean).join(' · '),
        genres: [], image: eps[0].image, runtimeSec: null,
        seasons: [{ n: 1, label: 'Videos', episodes: eps, loaded: true }], resume: null, progress: null, watched: null, playUrl: '',
        more: [], watchlist: null, progressKnown: true, source: 'service',
        notes: r.shortsHidden ? ['Shorts in this playlist are hidden'] : []
      }
    };
  } catch (err) {
    return { state: 'error', reason: 'the YouTube playlist reader hit an internal error (' + shape.cleanText(String((err && err.message) || err), 80) + ')', show: null };
  }
}

module.exports = { id: 'youtube', steps: steps, parse: parse, titleUrl: titleUrl };
