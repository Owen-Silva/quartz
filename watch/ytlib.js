'use strict';
/*
 * watch/ytlib.js -- YouTube past the home row, natively in Lumen: the Subscriptions feed, a
 * channel's Videos tab, the Library (Watch Later, Liked videos, playlists) and one playlist.
 * Pure: the reads it asks for, the parsers, the "new since you last opened Lumen" marker and the
 * page's request lines. watch/ytlib-main.js runs the reads; watch/ytlib-page.js draws them.
 *
 * Every page is read the way the home row is (watch/adapters/youtube.js): a hidden view of the
 * page the user is signed in to, window.ytInitialData copied out with the adapter's own EXTRACT, and
 * the adapter's tolerant walk (scanTree) for the videos, so the renderer churn it already handles
 * (videoRenderer -> richItemRenderer -> lockupViewModel) is handled here too. A second, light walk
 * over the same tree adds what a tile here needs that the home row does not: the channel (name,
 * avatar, link) and the age ("3 hours ago"). Read only: nothing here ever posts to YouTube.
 *
 * Every parse*() never throws: any input gives { state: 'ok' | 'signed-out' | 'error', reason, ... }.
 */
var shape = require('./shape');
var yt = require('./adapters/youtube');
var I = yt._internals;

var ORIGIN = 'https://www.youtube.com';
var BUDGET_MS = 20000;
var CAPS = { subs: 60, channel: 48, playlist: 100, shelf: 24, playlists: 60, seen: 3000, played: 1000 };
var VISIT_GAP_MS = 10 * 60e3;   // away this long, and coming back is "opening Lumen" again

var VIDEO_KEYS = {
  videoRenderer: 1, gridVideoRenderer: 1, compactVideoRenderer: 1, playlistVideoRenderer: 1,
  reelItemRenderer: 1, shortsLockupViewModel: 1, lockupViewModel: 1
};
var PLAYLIST_KEYS = { gridPlaylistRenderer: 1, playlistRenderer: 1, compactPlaylistRenderer: 1, lockupViewModel: 1 };
var EMPTY_KEYS = { feedNudgeRenderer: 1, messageRenderer: 1, backgroundPromoRenderer: 1 };

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v : ''; }
function get(o, path) {
  var cur = o;
  for (var i = 0; i < path.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[path[i]];
  }
  return cur;
}
function isVideoId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }
function isPlaylistId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(id) && !/^RD/.test(id); }
function text(v, max) { return shape.cleanText(shape.textOf(v), max || 120); }

/* ---------------------------------------------------------------- URLs */

/**
 * A channel link as Lumen keeps it: '/@handle', '/channel/UC...', '/c/name' or '/user/name'
 * (path only, no tab), or '' when it is not a YouTube channel. Takes a full youtube.com URL,
 * a path, or a browseEndpoint's canonicalBaseUrl.
 */
function channelPath(u) {
  var s = str(u).trim();
  if (!s || s.length > 300) return '';
  var p = s;
  if (/^(https?:)?\/\//i.test(s)) {
    var x;
    try { x = new URL(s.indexOf('//') === 0 ? 'https:' + s : s); } catch (err) { return ''; }
    if (!/^(www\.|m\.)?youtube\.com$/i.test(x.hostname)) return '';
    p = x.pathname;
  }
  p = p.split(/[?#]/)[0];
  var m = /^\/(@[^\/\s]{1,100})(?:\/[A-Za-z]*)?\/?$/.exec(p);
  if (m) {
    var h = m[1];
    try { h = '@' + encodeURIComponent(decodeURIComponent(h.slice(1))); } catch (err) { return ''; }
    return '/' + h;
  }
  m = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/[A-Za-z]*)?\/?$/.exec(p);
  if (m) return '/channel/' + m[1];
  m = /^\/(c|user)\/([A-Za-z0-9._-]{1,100})(?:\/[A-Za-z]*)?\/?$/.exec(p);
  if (m) return '/' + m[1] + '/' + m[2];
  return '';
}
function channelUrl(path) { return path ? ORIGIN + path : ''; }
function channelVideosUrl(path) { return path ? ORIGIN + path + '/videos' : ''; }
function channelShortsUrl(path) { return path ? ORIGIN + path + '/shorts' : ''; }
function playlistUrl(id) { return isPlaylistId(id) ? ORIGIN + '/playlist?list=' + id : ''; }
var SUBS_URL = ORIGIN + '/feed/subscriptions';
var PLAYLISTS_URL = ORIGIN + '/feed/playlists';

/* ---------------------------------------------------------------- the reads */

function view(name, url, optional) {
  var s = { name: name, type: 'view', url: url, extract: I.EXTRACT, ready: I.ready, budgetMs: BUDGET_MS };
  if (optional) s.optional = true;
  return s;
}
function subsSteps() { return [view('subs', SUBS_URL)]; }
function channelSteps(path) { return channelPath(path) ? [view('channel', channelVideosUrl(channelPath(path)))] : []; }
function librarySteps() { return [view('wl', playlistUrl('WL')), view('ll', playlistUrl('LL')), view('playlists', PLAYLISTS_URL, true)]; }
function playlistSteps(id) { return isPlaylistId(id) ? [view('playlist', playlistUrl(id))] : []; }

/* ---------------------------------------------------------------- one step's verdict */

function hostPath(u) {
  if (typeof u !== 'string' || !u) return null;
  try { var x = new URL(u); return { host: x.hostname.toLowerCase(), path: x.pathname }; } catch (err) { return null; }
}

/**
 * One read step -> { status: 'ok' | 'signed-out' | 'captcha' | 'error' | 'nodata' | 'missing', reason, data, loggedIn }.
 * The same verdicts the home row's adapter gives (a Google sign-in page, a /sorry captcha, the
 * reader's own errors), so a channel page and the home row never disagree about why.
 */
function stepData(step) {
  if (!step || typeof step !== 'object') return { status: 'missing', reason: '', data: null, loggedIn: null };
  var ex = obj(step.extracted);
  var landed = [str(step.finalUrl), ex ? str(ex.url) : ''];
  for (var i = 0; i < landed.length; i++) {
    var hp = hostPath(landed[i]);
    if (!hp) continue;
    if (hp.host === 'accounts.google.com' || hp.path.indexOf('/ServiceLogin') === 0) return { status: 'signed-out', reason: '', data: null, loggedIn: false };
    if (/^\/sorry\b/.test(hp.path) && (/(^|\.)google\.com$/.test(hp.host) || /(^|\.)youtube\.com$/.test(hp.host))) {
      return { status: 'captcha', reason: 'blocked by a captcha', data: null, loggedIn: null };
    }
  }
  if (step.error) return { status: 'error', reason: I.reasonForError(step.error, step.status), data: null, loggedIn: null };
  if (!ex) return { status: 'error', reason: step.ok === false ? "the page didn't load" : 'the page loaded but the reader got nothing back', data: null, loggedIn: null };
  var data = obj(ex.data) || obj(ex.ytInitialData);
  var loggedIn = typeof ex.loggedIn === 'boolean' ? ex.loggedIn : null;
  if (!data) {
    if (loggedIn === false) return { status: 'signed-out', reason: '', data: null, loggedIn: false };
    return { status: 'nodata', reason: 'the page loaded but had no ytInitialData (YouTube changed its layout?)', data: null, loggedIn: loggedIn };
  }
  return { status: 'ok', reason: '', data: data, loggedIn: loggedIn };
}

/* ---------------------------------------------------------------- what the home walk leaves out */

function avatarOf(sources) {
  var list = arr(sources);
  var best = '';
  var bestScore = Infinity;
  for (var i = 0; i < list.length; i++) {
    var t = obj(list[i]);
    if (!t) continue;
    var u = shape.cleanHttps(str(t.url));
    if (!u) continue;
    var w = typeof t.width === 'number' ? t.width : 0;
    var score = w ? Math.abs(w - 88) : 500;
    if (score < bestScore) { best = u; bestScore = score; }
  }
  return best;
}

/* The first browseEndpoint under v that names a channel: { id, path }. */
function browseOf(v) {
  var found = null;
  shape.walk(v, function (n, key) {
    if (found) return false;
    if (key === 'browseEndpoint' && obj(n)) {
      var id = str(n.browseId);
      var p = channelPath(str(n.canonicalBaseUrl)) || (/^UC[A-Za-z0-9_-]{22}$/.test(id) ? '/channel/' + id : '');
      if (p) found = { id: /^UC/.test(id) ? id : '', path: p };
      return false;
    }
    return true;
  });
  return found;
}

var AGO = /(\d+)\s*(second|sec|minute|min|hour|hr|day|week|wk|month|mo|year|yr)s?\s+ago/i;
var UNIT = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600, day: 86400, week: 604800, wk: 604800, month: 2629800, mo: 2629800, year: 31557600, yr: 31557600 };
function isAge(t) { return AGO.test(t) || /^(streamed|premiered)\b/i.test(t) || /^(premieres|scheduled for)\b/i.test(t); }
function ageSec(t) {
  var m = AGO.exec(str(t));
  return m ? parseInt(m[1], 10) * UNIT[m[2].toLowerCase()] : null;
}

/* One video renderer -> { channel: { name, path, avatar }, age } (whatever of it the entry carries). */
function extrasFrom(key, node) {
  var x = { name: '', path: '', avatar: '', age: '', views: '' };
  if (key === 'lockupViewModel') {
    var meta = obj(get(node, ['metadata', 'lockupMetadataViewModel'])) || {};
    x.avatar = avatarOf(get(meta, ['image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources']));
    var rows = arr(get(meta, ['metadata', 'contentMetadataViewModel', 'metadataRows']));
    for (var r = 0; r < rows.length; r++) {
      var parts = arr(obj(rows[r]) && rows[r].metadataParts);
      for (var p = 0; p < parts.length; p++) {
        var t = text(parts[p] && parts[p].text);
        if (!t) continue;
        if (r === 0 && p === 0 && !isAge(t) && !/views?$|watching$/i.test(t)) x.name = t;
        else if (!x.age && isAge(t)) x.age = t;
        else if (!x.views && /views?$|watching$/i.test(t)) x.views = t;
      }
    }
    var b = browseOf(get(meta, ['image'])) || browseOf(get(meta, ['metadata']));
    if (b) x.path = b.path;
  } else if (key === 'shortsLockupViewModel' || key === 'reelItemRenderer') {
    x.views = text(get(node, ['overlayMetadata', 'secondaryText'])) || text(node.viewCountText);
  } else {
    var by = node.ownerText || node.longBylineText || node.shortBylineText;
    x.name = text(by);
    var b2 = browseOf(by) || browseOf(node.channelThumbnailSupportedRenderers);
    if (b2) x.path = b2.path;
    x.avatar = avatarOf(get(node, ['channelThumbnailSupportedRenderers', 'channelThumbnailWithLinkRenderer', 'thumbnail', 'thumbnails'])) ||
      avatarOf(get(node, ['channelThumbnail', 'thumbnails']));
    x.age = text(node.publishedTimeText);
    if (!x.age) {
      var vi = text(node.videoInfo);
      var bits = vi.split(/\s*•\s*/);
      for (var k = 0; k < bits.length; k++) if (isAge(bits[k])) { x.age = bits[k]; break; }
    }
    x.views = text(node.shortViewCountText) || text(node.viewCountText);
    if (!x.age) {
      var up = get(node, ['upcomingEventData', 'startTime']);
      if (up) x.age = 'Upcoming';
    }
  }
  return x;
}

function idOf(key, node) {
  if (key === 'lockupViewModel') return str(node.contentId);
  if (key === 'shortsLockupViewModel') return str(get(node, ['onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId'])) || str(node.entityId).replace(/^shorts-shelf-item-/, '');
  return str(node.videoId);
}

function collectExtras(root) {
  var out = {};
  shape.walk(root, function (node, key) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
    if (key === 'menu' || key === 'menuRenderer' || key === 'topbar') return false;
    if (typeof key === 'string' && VIDEO_KEYS[key]) {
      var id = idOf(key, node);
      if (isVideoId(id) && !out[id]) out[id] = extrasFrom(key, node);
      return false;
    }
    return true;
  });
  return out;
}

function hasEmptyMarker(root) {
  var seen = false;
  shape.walk(root, function (n, key) {
    if (seen) return false;
    if (typeof key === 'string' && EMPTY_KEYS[key] && obj(n)) { seen = true; return false; }
    return !(key === 'topbar');
  });
  return seen;
}

/** The one text a page's alert / message says ("This playlist doesn't exist"), or ''. */
function alertText(root) {
  var t = '';
  shape.walk(root, function (n, key) {
    if (t) return false;
    if ((key === 'alertRenderer' || key === 'alertWithButtonRenderer' || key === 'messageRenderer') && obj(n)) {
      t = text(n.text, 160) || text(n.subtext, 160);
      return false;
    }
    return key !== 'topbar';
  });
  return t;
}

/* ---------------------------------------------------------------- tiles */

function joinDot(parts) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = shape.cleanText(str(parts[i]), 120);
    if (p && out.indexOf(p) === -1) out.push(p);
  }
  return out.join(' · ');
}

/**
 * The adapter's walk, plus the extras, -> tiles: { id, vid, service, kind, title, subtitle, image, images,
 * progress, url, durationSec, badge, also, yt: true, channel: { name, path, avatar }, age, ageSec, live, upcoming, short }.
 * `fixed` is a channel every tile belongs to (a channel page names it once, in its header).
 */
function tilesOf(data, opts) {
  var o = opts || {};
  var scan = I.scanTree(data);
  var extras = collectExtras(data);
  var seen = {};
  var out = [];
  var shorts = 0;
  for (var i = 0; i < scan.items.length; i++) {
    var it = scan.items[i];
    var vid = String(it.id).replace(/^youtube:/, '');
    if (!isVideoId(vid) || seen[vid]) continue;
    seen[vid] = true;
    if (it._short) { shorts++; continue; }
    var ex = extras[vid] || { name: '', path: '', avatar: '', age: '', views: '' };
    var ch = o.fixed ? { name: o.fixed.name || ex.name, path: o.fixed.path || ex.path, avatar: o.fixed.avatar || ex.avatar }
      : { name: ex.name, path: ex.path, avatar: ex.avatar };
    var live = it.badge === 'Live';
    var upcoming = it.badge === 'Upcoming';
    var age = live ? 'Live now' : ex.age;
    var sub = o.fixed ? joinDot([age, ex.views]) : joinDot([ch.name, age]);
    var clean = shape.cleanItem({
      id: it.id, service: 'youtube', kind: 'rec', title: it.title, subtitle: sub || it.subtitle, image: it.image, images: it.images,
      progress: it.progress, url: it.url, startsAt: null, durationSec: it.durationSec, badge: it.badge, group: ''
    });
    if (!clean) continue;
    clean.also = [];
    clean.yt = true;
    clean.vid = vid;
    clean.channel = { name: shape.cleanText(ch.name, 120), path: channelPath(ch.path), avatar: shape.cleanHttps(ch.avatar) };
    clean.age = shape.cleanText(age, 60);
    clean.ageSec = live ? 0 : ageSec(age);
    clean.live = live;
    clean.upcoming = upcoming;
    out.push(clean);
    if (out.length >= (o.cap || CAPS.subs)) break;
  }
  return { items: out, shorts: shorts, found: scan.stats.found, empty: scan.stats.empty || hasEmptyMarker(data) };
}

/* Newest first: YouTube's order, made sure of where every age is known (live first, upcoming last). */
function newestFirst(items) {
  var known = items.every(function (it) { return it.live || it.upcoming || it.ageSec !== null; });
  if (!known) return items;
  var rank = function (it) { return it.live ? -1 : it.upcoming ? Infinity : it.ageSec; };
  return items.map(function (it, i) { return { it: it, i: i }; })
    .sort(function (a, b) { var d = rank(a.it) - rank(b.it); return d || a.i - b.i; })
    .map(function (x) { return x.it; });
}

/* ---------------------------------------------------------------- parse: subscriptions */

function fail(reason, extra) {
  var o = { state: 'error', reason: reason, items: [] };
  for (var k in (extra || {})) o[k] = extra[k];
  return o;
}

function stepFailure(st, what) {
  if (st.status === 'missing') return "the reader didn't open " + what;
  return st.reason || 'the read failed';
}

function parseSubsInner(read) {
  var st = stepData(read && read.steps && read.steps.subs);
  if (st.status === 'signed-out') return { state: 'signed-out', reason: 'sign in to YouTube to see your subscriptions', items: [] };
  if (st.status !== 'ok') return fail(stepFailure(st, 'the Subscriptions page'));
  var t = tilesOf(st.data, { cap: CAPS.subs });
  if (st.loggedIn === false) return { state: 'signed-out', reason: 'sign in to YouTube to see your subscriptions', items: [] };
  if (!t.items.length && t.found === 0 && !t.empty) return fail('the page loaded but no videos matched (YouTube changed its layout?)');
  return { state: 'ok', reason: '', items: newestFirst(t.items), shortsHidden: t.shorts, empty: !t.items.length };
}

function parseSubs(read) {
  try { return parseSubsInner(read); } catch (err) { return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')'); }
}

/* ---------------------------------------------------------------- parse: a channel */

function firstSources(root, key) {
  var found = '';
  shape.walk(root, function (n, k) {
    if (found) return false;
    if (k === key && obj(n)) { found = avatarOf(get(n, ['image', 'sources']) || get(n, ['avatar', 'avatarViewModel', 'image', 'sources']) || get(n, ['thumbnails'])); return false; }
    return true;
  });
  return found;
}

/* The channel's own header: { name, handle, path, avatar, banner, subscribers, videos, id }. */
function channelHeader(data, askedPath) {
  var h = { name: '', handle: '', path: '', avatar: '', banner: '', subscribers: '', videos: '', id: '', description: '' };
  var md = obj(get(data, ['metadata', 'channelMetadataRenderer']));
  if (md) {
    h.name = text(md.title);
    h.id = /^UC[A-Za-z0-9_-]{22}$/.test(str(md.externalId)) ? md.externalId : '';
    h.path = channelPath(str(md.vanityChannelUrl)) || channelPath(str(md.channelUrl));
    h.description = shape.cleanText(str(md.description), 300);
  }
  var ph = obj(get(data, ['header', 'pageHeaderRenderer', 'content', 'pageHeaderViewModel']));
  if (ph) {
    h.name = h.name || text(get(ph, ['title', 'dynamicTextViewModel', 'text']));
    h.avatar = h.avatar || avatarOf(get(ph, ['image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources']));
    h.banner = avatarOf(get(ph, ['banner', 'imageBannerViewModel', 'image', 'sources']));
    var rows = arr(get(ph, ['metadata', 'contentMetadataViewModel', 'metadataRows']));
    rows.forEach(function (r) {
      arr(obj(r) && r.metadataParts).forEach(function (p) {
        var t = text(p && p.text);
        if (/^@/.test(t) && !h.handle) h.handle = t;
        else if (/subscribers?$/i.test(t) && !h.subscribers) h.subscribers = t;
        else if (/videos?$/i.test(t) && !h.videos) h.videos = t;
      });
    });
  }
  var c4 = obj(get(data, ['header', 'c4TabbedHeaderRenderer']));
  if (c4) {
    h.name = h.name || text(c4.title);
    h.id = h.id || (/^UC[A-Za-z0-9_-]{22}$/.test(str(c4.channelId)) ? c4.channelId : '');
    h.avatar = h.avatar || avatarOf(get(c4, ['avatar', 'thumbnails']));
    h.banner = h.banner || avatarOf(get(c4, ['banner', 'thumbnails']));
    h.handle = h.handle || text(c4.channelHandleText);
    h.subscribers = h.subscribers || text(c4.subscriberCountText);
    h.videos = h.videos || text(c4.videosCountText);
  }
  // The header's own avatar comes in sizes near a tile's; the metadata's is one 900 px still.
  if (!h.avatar && md) h.avatar = avatarOf(get(md, ['avatar', 'thumbnails']));
  if (!h.handle && /^\/@/.test(askedPath || '')) { try { h.handle = decodeURIComponent(askedPath.slice(1)); } catch (err) { h.handle = ''; } }
  h.path = h.path || channelPath(askedPath) || (h.id ? '/channel/' + h.id : '');
  h.name = shape.cleanText(h.name, 120);
  h.handle = shape.cleanText(h.handle, 120);
  return h;
}

/* The selected tab's content (the Videos grid), or the whole tree when there are no tabs. */
function selectedTab(data) {
  var tabs = arr(get(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']));
  for (var i = 0; i < tabs.length; i++) {
    var tr = obj(tabs[i] && (tabs[i].tabRenderer || tabs[i].expandableTabRenderer));
    if (tr && tr.selected && tr.content) return { content: tr.content, title: text(tr.title) };
  }
  return { content: get(data, ['contents']) || data, title: '' };
}

function parseChannelInner(read, askedPath) {
  var st = stepData(read && read.steps && read.steps.channel);
  // A channel is public: signed out it still reads (only the Subscribe state would differ).
  if (st.status === 'signed-out') return { state: 'signed-out', reason: 'YouTube sent the reader to its sign-in page', items: [], channel: null };
  if (st.status !== 'ok') return fail(stepFailure(st, 'the channel page'), { channel: null });
  var head = channelHeader(st.data, askedPath);
  var tab = selectedTab(st.data);
  var t = tilesOf(tab.content, { cap: CAPS.channel, fixed: { name: head.name, path: head.path, avatar: head.avatar } });
  if (!head.name && !t.items.length) {
    var al = alertText(st.data);
    return fail(al ? 'YouTube says: ' + al : 'the page loaded but no channel matched (YouTube changed its layout?)', { channel: null });
  }
  if (!t.items.length && t.found === 0 && !t.empty && !head.name) return fail('the page loaded but no videos matched (YouTube changed its layout?)', { channel: head });
  return { state: 'ok', reason: '', items: t.items, shortsHidden: t.shorts, channel: head, tab: tab.title, signedIn: st.loggedIn !== false };
}

function parseChannel(read, askedPath) {
  try { return parseChannelInner(read, askedPath); } catch (err) { return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')', { channel: null }); }
}

/* ---------------------------------------------------------------- parse: playlists */

/* One playlist renderer -> { id, title, count, image, url, owner } or null. */
function playlistFrom(key, node) {
  var id = '';
  var title = '';
  var count = '';
  var image = '';
  var owner = '';
  if (key === 'lockupViewModel') {
    var ct = str(node.contentType);
    if (ct && ct !== 'LOCKUP_CONTENT_TYPE_PLAYLIST' && ct !== 'LOCKUP_CONTENT_TYPE_PODCAST') return null;
    if (!ct && !get(node, ['contentImage', 'collectionThumbnailViewModel'])) return null;
    id = str(node.contentId);
    var meta = obj(get(node, ['metadata', 'lockupMetadataViewModel'])) || {};
    title = text(meta.title, 200);
    var rows = arr(get(meta, ['metadata', 'contentMetadataViewModel', 'metadataRows']));
    rows.forEach(function (r) {
      arr(obj(r) && r.metadataParts).forEach(function (p) {
        var t = text(p && p.text);
        if (!t) return;
        if (/videos?$|episodes?$/i.test(t) && !count) count = t;
        else if (!owner && !/^(view full playlist|updated|private|public|unlisted|playlist)\b/i.test(t)) owner = t;
      });
    });
    var prim = get(node, ['contentImage', 'collectionThumbnailViewModel', 'primaryThumbnail', 'thumbnailViewModel']);
    image = avatarOf(get(prim, ['image', 'sources']));
    shape.walk(prim, function (n, k) {
      if (k === 'thumbnailBadgeViewModel' && obj(n)) { var bt = text(n.text); if (/\d/.test(bt) && !count) count = /videos?|episodes?/i.test(bt) ? bt : bt + ' videos'; return false; }
      return true;
    });
  } else {
    id = str(node.playlistId);
    title = text(node.title, 200);
    count = text(node.videoCountText) || (text(node.videoCountShortText) ? text(node.videoCountShortText) + ' videos' : '') || (str(node.videoCount) ? node.videoCount + ' videos' : '');
    owner = text(node.shortBylineText) || text(node.longBylineText) || text(node.ownerText);
    var thumbs = get(node, ['thumbnail', 'thumbnails']) || get(node, ['thumbnailRenderer', 'playlistVideoThumbnailRenderer', 'thumbnail', 'thumbnails']) ||
      get(node, ['thumbnails', 0, 'thumbnails']) || get(node, ['thumbnailRenderer', 'playlistCustomThumbnailRenderer', 'thumbnail', 'thumbnails']);
    image = avatarOf(thumbs);
  }
  if (!isPlaylistId(id) || !title) return null;
  var big = image.replace(/\/(default|mqdefault|hqdefault)\.jpg/, '/hqdefault.jpg');
  return { id: id, title: shape.cleanText(title, 200), count: shape.cleanText(count, 40), image: shape.cleanHttps(big) || image, url: playlistUrl(id), owner: shape.cleanText(owner, 120) };
}

function playlistsOf(data) {
  var out = [];
  var seen = {};
  shape.walk(data, function (node, key) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
    if (key === 'menu' || key === 'topbar' || key === 'guide') return false;
    if (typeof key === 'string' && PLAYLIST_KEYS[key]) {
      var p = playlistFrom(key, node);
      if (p && !seen[p.id] && p.id !== 'WL' && p.id !== 'LL') { seen[p.id] = true; out.push(p); }
      return false;
    }
    return true;
  });
  return out.slice(0, CAPS.playlists);
}

/* A playlist page's header: { id, title, owner, count }. */
function playlistHeader(data, id) {
  var h = { id: id, title: '', owner: '', count: '' };
  var pm = obj(get(data, ['metadata', 'playlistMetadataRenderer']));
  if (pm) h.title = text(pm.title, 200);
  var ph = obj(get(data, ['header', 'pageHeaderRenderer']));
  if (ph) {
    h.title = h.title || text(ph.pageTitle, 200) || text(get(ph, ['content', 'pageHeaderViewModel', 'title', 'dynamicTextViewModel', 'text']), 200);
    var rows = arr(get(ph, ['content', 'pageHeaderViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows']));
    rows.forEach(function (r) {
      arr(obj(r) && r.metadataParts).forEach(function (p) {
        var t = text(p && p.text) || text(p && p.avatarStack && p.avatarStack.avatarStackViewModel && p.avatarStack.avatarStackViewModel.text);
        if (/videos?$/i.test(t) && !h.count) h.count = t;
        else if (/^by\s/i.test(t) && !h.owner) h.owner = t.replace(/^by\s+/i, '');
      });
    });
  }
  var old = obj(get(data, ['header', 'playlistHeaderRenderer']));
  if (old) {
    h.title = h.title || text(old.title, 200);
    h.owner = h.owner || text(old.ownerText);
    h.count = h.count || text(old.numVideosText) || text(old.stats && old.stats[0]);
  }
  shape.walk(get(data, ['sidebar']), function (n, k) {
    if (k === 'playlistSidebarPrimaryInfoRenderer' && obj(n)) {
      h.title = h.title || text(n.title, 200);
      h.count = h.count || text(arr(n.stats)[0]);
      return false;
    }
    if (k === 'videoOwnerRenderer' && obj(n)) { h.owner = h.owner || text(n.title); return false; }
    return true;
  });
  if (!h.title && id === 'WL') h.title = 'Watch later';
  if (!h.title && id === 'LL') h.title = 'Liked videos';
  return h;
}

function playlistPart(st, id, cap) {
  if (st.status === 'signed-out') return { state: 'signed-out', reason: '', items: [], playlist: null };
  if (st.status !== 'ok') return { state: 'error', reason: stepFailure(st, 'the playlist'), items: [], playlist: null };
  var head = playlistHeader(st.data, id);
  var t = tilesOf(st.data, { cap: cap });
  if (!t.items.length && !t.empty && t.found === 0) {
    var al = alertText(st.data);
    if (al) return { state: 'error', reason: 'YouTube says: ' + al, items: [], playlist: head };
    if (!head.title || id === 'WL' || id === 'LL') {
      if (st.loggedIn === false) return { state: 'signed-out', reason: '', items: [], playlist: null };
      return { state: 'error', reason: 'the page loaded but no videos matched (YouTube changed its layout?)', items: [], playlist: head };
    }
  }
  if ((id === 'WL' || id === 'LL') && st.loggedIn === false) return { state: 'signed-out', reason: '', items: [], playlist: null };
  return { state: 'ok', reason: '', items: t.items, playlist: head, shortsHidden: t.shorts };
}

function parsePlaylist(read, id) {
  try {
    var r = playlistPart(stepData(read && read.steps && read.steps.playlist), id, CAPS.playlist);
    if (r.state === 'signed-out') r.reason = 'sign in to YouTube to see this playlist';
    return r;
  } catch (err) {
    return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')', { playlist: null });
  }
}

/* ---------------------------------------------------------------- parse: the Library */

function parseLibraryInner(read) {
  var steps = (read && read.steps) || {};
  var wl = stepData(steps.wl);
  var ll = stepData(steps.ll);
  var pl = stepData(steps.playlists);
  if (wl.status === 'signed-out' || ll.status === 'signed-out' || pl.status === 'signed-out') {
    return { state: 'signed-out', reason: 'sign in to YouTube to see your library', items: [] };
  }
  var out = { state: 'ok', reason: '', items: [] };
  out.wl = playlistPart(wl, 'WL', CAPS.shelf);
  out.ll = playlistPart(ll, 'LL', CAPS.shelf);
  if (out.wl.state === 'signed-out' || out.ll.state === 'signed-out') return { state: 'signed-out', reason: 'sign in to YouTube to see your library', items: [] };
  if (pl.status === 'ok') {
    var lists = playlistsOf(pl.data);
    out.playlists = { state: 'ok', reason: '', items: lists, empty: !lists.length };
    if (!lists.length && !hasEmptyMarker(pl.data)) {
      var any = false;
      shape.walk(pl.data, function (n, k) { if (any) return false; if (typeof k === 'string' && PLAYLIST_KEYS[k]) any = true; return true; });
      if (!any) out.playlists = { state: 'ok', reason: '', items: [], empty: true, note: 'no playlists matched' };
    }
  } else {
    out.playlists = { state: 'error', reason: stepFailure(pl, 'the Playlists page'), items: [] };
  }
  if (out.wl.state === 'error' && out.ll.state === 'error' && out.playlists.state === 'error') {
    return fail(out.wl.reason === out.ll.reason ? out.wl.reason : (out.wl.reason || out.ll.reason));
  }
  return out;
}

function parseLibrary(read) {
  try { return parseLibraryInner(read); } catch (err) { return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')'); }
}

/* ---------------------------------------------------------------- new since you last opened Lumen */

/*
 * store: { seen: { vid: firstSeenAt }, played: { vid: at }, baseline: bool, cutoff: ms, lastOffAt: ms, on: bool }
 *   seen      when a Subscriptions read first listed the video (the first read ever only sets the baseline:
 *             a first run shows nothing as new, since Lumen cannot know what he had already seen)
 *   cutoff    the end of the previous visit: a video Lumen first saw after it is new in this visit
 *   played    opened from Lumen: never new again
 * A visit is Lumen on screen; leaving for under VISIT_GAP_MS (a tab switch) is the same visit.
 */
function blankStore() { return { seen: {}, played: {}, baseline: false, cutoff: 0, lastOffAt: 0, on: false }; }

function cleanStore(raw) {
  var s = blankStore();
  var r = obj(raw) || {};
  var seen = obj(r.seen) || {};
  for (var k in seen) if (isVideoId(k) && typeof seen[k] === 'number' && isFinite(seen[k])) s.seen[k] = seen[k];
  var played = obj(r.played) || {};
  for (var p in played) if (isVideoId(p) && typeof played[p] === 'number' && isFinite(played[p])) s.played[p] = played[p];
  s.baseline = r.baseline === true;
  s.cutoff = typeof r.cutoff === 'number' && isFinite(r.cutoff) ? r.cutoff : 0;
  s.lastOffAt = typeof r.lastOffAt === 'number' && isFinite(r.lastOffAt) ? r.lastOffAt : 0;
  return s;
}

function capMap(m, cap) {
  var keys = Object.keys(m);
  if (keys.length <= cap) return m;
  keys.sort(function (a, b) { return m[b] - m[a]; });
  var out = {};
  for (var i = 0; i < cap; i++) out[keys[i]] = m[keys[i]];
  return out;
}

/** A Subscriptions read landed: remember when each video was first seen. */
function noteSeen(store, items, now) {
  var first = !store.baseline;
  for (var i = 0; i < items.length; i++) {
    var v = items[i].vid;
    if (!isVideoId(v) || store.seen[v] !== undefined) continue;
    store.seen[v] = first ? 0 : now;
  }
  if (first) { store.baseline = true; store.cutoff = now; }
  store.seen = capMap(store.seen, CAPS.seen);
}

/** Lumen came on screen (on) or left it. -> true when this starts a new visit. */
function sight(store, on, now) {
  if (on) {
    if (store.on) return false;
    store.on = true;
    if (!store.lastOffAt || now - store.lastOffAt >= VISIT_GAP_MS) {
      if (store.lastOffAt) store.cutoff = store.lastOffAt;
      return true;
    }
    return false;
  }
  if (!store.on) return false;
  store.on = false;
  store.lastOffAt = now;
  return false;
}

function isNew(store, vid) {
  if (!store.baseline || store.played[vid] !== undefined) return false;
  var at = store.seen[vid];
  return typeof at === 'number' && at > store.cutoff;
}

function newIds(store, items) {
  var out = [];
  for (var i = 0; i < items.length; i++) if (isNew(store, items[i].vid)) out.push(items[i].vid);
  return out;
}

function notePlayed(store, vid, now) {
  if (!isVideoId(vid)) return false;
  store.played[vid] = now;
  store.played = capMap(store.played, CAPS.played);
  return true;
}

/* ---------------------------------------------------------------- the page's lines */

/**
 * quartz-watch:yt {...} from the page, checked: { op: 'subs' | 'channel' | 'library' | 'playlist' | 'played',
 * force, seq, path?, id? } or null. A channel is only ever a youtube.com channel path; a playlist only an id.
 */
function cleanLine(msg) {
  var m = obj(msg);
  if (!m) return null;
  var seq = Number.isInteger(m.seq) && m.seq >= 0 ? m.seq : 0;
  var force = m.force === true;
  switch (m.op) {
    case 'subs': case 'library':
      return { op: m.op, seq: seq, force: force };
    case 'channel': {
      var p = channelPath(str(m.url) || str(m.path));
      return p ? { op: 'channel', seq: seq, force: force, path: p } : null;
    }
    case 'playlist':
      return isPlaylistId(str(m.id)) ? { op: 'playlist', seq: seq, force: force, id: m.id } : null;
    case 'played':
      return isVideoId(str(m.id)) ? { op: 'played', id: m.id } : null;
    default:
      return null;
  }
}

module.exports = {
  ORIGIN: ORIGIN, SUBS_URL: SUBS_URL, PLAYLISTS_URL: PLAYLISTS_URL, VISIT_GAP_MS: VISIT_GAP_MS, CAPS: CAPS,
  channelPath: channelPath, channelUrl: channelUrl, channelVideosUrl: channelVideosUrl, channelShortsUrl: channelShortsUrl,
  playlistUrl: playlistUrl, isPlaylistId: isPlaylistId, isVideoId: isVideoId,
  subsSteps: subsSteps, channelSteps: channelSteps, librarySteps: librarySteps, playlistSteps: playlistSteps,
  parseSubs: parseSubs, parseChannel: parseChannel, parseLibrary: parseLibrary, parsePlaylist: parsePlaylist,
  blankStore: blankStore, cleanStore: cleanStore, noteSeen: noteSeen, sight: sight, isNew: isNew, newIds: newIds, notePlayed: notePlayed,
  cleanLine: cleanLine,
  _internals: { stepData: stepData, collectExtras: collectExtras, tilesOf: tilesOf, playlistsOf: playlistsOf, channelHeader: channelHeader, ageSec: ageSec, newestFirst: newestFirst }
};
