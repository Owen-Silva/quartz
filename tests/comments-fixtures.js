// tests/comments-fixtures.js -- LOCAL stand-ins for YouTube's comments, for Lumen's own comments (watch-comments.js):
// the watch page (tests/playview-fixtures.js) with its comments section in ytInitialData, YouTube's OWN comments
// section in its DOM (drawn lazily, only once it is in view, like YouTube's), each comment's own Like and Reply and
// the "Add a comment" box, all counting their presses; and the answers to the page's own continuation requests
// (POST /youtubei/v1/next): Top in YouTube's entity shape (frameworkUpdates mutations) and its older
// commentRenderer shape, Newest, and replies. Made-up people and text, never a real account.
//
// watch(q): q as playview-fixtures, plus q.cm = 'off' | 'none' | 'empty' | 'fail' | 'slow' | '' (the variant).
// next(body, variant): { status, json } for a POST body.
'use strict';
const F = require('./playview-fixtures');

const FIRST = F.TOKEN;                     // the first token, in ytInitialData
const T = { top2: 'CM-TOP-2', top3: 'CM-TOP-3', new1: 'CM-NEW-1', new2: 'CM-NEW-2', top1: 'CM-TOP-1' };
const COUNT = '1,234';
const av = (c, l) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="${c}"/><text x="44" y="58" font-size="38" text-anchor="middle" fill="#fff" font-family="Segoe UI">${l}</text></svg>`);
const COLORS = ['#5b6b7a', '#7a5b6b', '#6b7a5b', '#5b7a76', '#7a6e5b', '#655b7a'];
const NAMES = ['@quietglyph', '@jumpingpixel', '@gjpqy_typesetter', '@lowercase.lumen', '@frame_by_frame', '@sinewave440'];

// The first comment: links of every kind, a timestamp in this video, a mention, markup that must stay text.
const C1_TEXT = 'Pinned: the clip at 1:05 is the best part. Source: https://example.com/notes and @jumpingpixel made it. <img src=x onerror="window.__xss=1"> stays text, gjpqy.';
function c1Runs(vid) {
  const t = C1_TEXT;
  const at = (s) => t.indexOf(s);
  return [
    { startIndex: at('1:05'), length: 4, onTap: { innertubeCommand: { watchEndpoint: { videoId: vid, startTimeSeconds: 65 } } } },
    { startIndex: at('https://example.com/notes'), length: 'https://example.com/notes'.length,
      onTap: { innertubeCommand: { urlEndpoint: { url: 'https://www.youtube.com/redirect?event=comments&q=' + encodeURIComponent('https://example.com/notes') } } } },
    { startIndex: at('@jumpingpixel'), length: '@jumpingpixel'.length, onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCjump', canonicalBaseUrl: '/@jumpingpixel' } } } },
  ];
}
// Over the clamp's 300 characters, one paragraph: on a wide view it fits in four lines, so no "Read more" (r62).
const MID = 'A medium one, one paragraph: ' + 'the test pattern holds steady while the tone sweeps, and the frame pacing stays even, gjpqy. '.repeat(3).trim();
const LONG = 'A long one, so Read more shows.\n' + Array.from({ length: 8 }, (_, i) => 'Line ' + (i + 2) + ' of a long comment with descenders gjpqy, about frame pacing and the sine tone.').join('\n');

/** The made-up comment n of a sort ('top' | 'new'). */
function comment(sort, n, vid) {
  const i = (n - 1) % NAMES.length;
  const id = (sort === 'new' ? 'UgxNew' : 'UgxTop') + String(n).padStart(3, '0');
  const text = sort === 'top' && n === 1 ? C1_TEXT : sort === 'top' && n === 3 ? LONG : sort === 'top' && n === 6 ? MID
    : (sort === 'new' ? 'Newest comment ' + n + ', posted a moment ago.' : 'Top comment ' + n + ': the test pattern scrolls nicely, gjpqy.');
  return { id, n, author: NAMES[i], avatar: av(COLORS[i], NAMES[i].charAt(1).toUpperCase()),
    time: sort === 'new' ? (n === 1 ? '1 minute ago' : n + ' minutes ago') : (n === 2 ? '3 days ago (edited)' : (n % 5 + 1) + ' days ago'),
    text, runs: sort === 'top' && n === 1 ? c1Runs(vid) : [], likes: sort === 'new' ? String(n % 3) : n === 1 ? '2.4K' : String(400 - n * 7),
    replies: sort === 'top' && n === 1 ? 3 : sort === 'top' && n === 4 ? 1 : 0, pinned: sort === 'top' && n === 1,
    creator: sort === 'top' && n === 2, verified: sort === 'top' && n === 5, hearted: sort === 'top' && n === 1 };
}
function reply(parent, n) {
  const i = (n + 2) % NAMES.length;
  return { id: parent + '.r' + n, author: NAMES[i], avatar: av(COLORS[i], NAMES[i].charAt(1).toUpperCase()), time: n + ' days ago',
    text: 'Reply ' + n + ' to ' + parent + '.', runs: [], likes: String(n), replies: 0, replyLevel: 1 };
}

/* ---- the entity shape (YouTube's current one) ------------------------------------------------------- */
function entityThread(c, muts) {
  const ck = 'ck-' + c.id, sk = 'sk-' + c.id;
  muts.push({ entityKey: ck, type: 'ENTITY_MUTATION_TYPE_REPLACE', payload: { commentEntityPayload: { key: ck,
    properties: { commentId: c.id, content: { content: c.text, commandRuns: c.runs }, publishedTime: c.time, replyLevel: c.replyLevel || 0, toolbarStateKey: sk, authorButtonA11y: c.author },
    author: { channelId: 'UC' + c.author.slice(1), displayName: c.author, avatarThumbnailUrl: c.avatar, isVerified: !!c.verified, isCreator: !!c.creator,
      channelCommand: { innertubeCommand: { browseEndpoint: { browseId: 'UC' + c.author.slice(1), canonicalBaseUrl: '/' + c.author } } } },
    toolbar: { likeCountNotliked: c.likes, likeCountLiked: c.likes, replyCount: c.replies ? String(c.replies) : '', likeCountA11y: c.likes + ' likes' },
    avatar: { image: { sources: [{ url: c.avatar }] } } } } });
  muts.push({ entityKey: sk, type: 'ENTITY_MUTATION_TYPE_REPLACE', payload: { engagementToolbarStateEntityPayload: { key: sk,
    likeState: 'TOOLBAR_LIKE_STATE_INDIFFERENT', heartState: c.hearted ? 'TOOLBAR_HEART_STATE_HEARTED' : 'TOOLBAR_HEART_STATE_UNHEARTED' } } });
  return { commentViewModel: { commentKey: ck, toolbarStateKey: sk, commentId: c.id, pinnedText: c.pinned ? 'Pinned by @LumenTestChannel' : undefined } };
}
function entityItem(c, muts) {
  const th = { commentViewModel: { commentViewModel: entityThread(c, muts).commentViewModel } };
  if (c.pinned) th.renderingPriority = 'RENDERING_PRIORITY_PINNED_COMMENT';
  if (c.replies) th.replies = { commentRepliesRenderer: { contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'CM-REP-' + c.id } } } }],
    viewReplies: { buttonRenderer: { text: { runs: [{ text: c.replies + (c.replies === 1 ? ' reply' : ' replies') }] } } } } };
  return { commentThreadRenderer: th };
}
/* ---- the older shape ------------------------------------------------------------------------------- */
function legacyItem(c) {
  return { commentThreadRenderer: { comment: { commentRenderer: { commentId: c.id, authorText: { simpleText: c.author }, authorThumbnail: { thumbnails: [{ url: c.avatar }] },
    authorEndpoint: { browseEndpoint: { canonicalBaseUrl: '/' + c.author } }, contentText: { runs: [{ text: c.text }] }, publishedTimeText: { runs: [{ text: c.time }] },
    voteCount: { simpleText: c.likes }, isLiked: false, replyCount: c.replies || 0, authorIsChannelOwner: !!c.creator } } } };
}
function header(sel) {
  return { commentsHeaderRenderer: { countText: { runs: [{ text: COUNT }, { text: ' Comments' }] }, commentsCount: { simpleText: '1.2K' },
    sortMenu: { sortFilterSubMenuRenderer: { subMenuItems: [
      { title: 'Top', selected: sel === 'top', serviceEndpoint: { continuationCommand: { token: T.top1 } } },
      { title: 'Newest', selected: sel === 'new', serviceEndpoint: { continuationCommand: { token: T.new1 } } }] } } } };
}
const cont = (token) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** The answer to the page's own POST /youtubei/v1/next. */
function next(body, variant, vid) {
  const tok = body && body.continuation;
  const v = vid || 'pvTest00001';
  if (variant === 'fail') return { status: 500, json: { error: { code: 500, message: 'fixture: failing on purpose' } } };
  if (!tok && body && body.videoId) return { status: 200, json: { contents: watchData(v, variant).contents } };
  const muts = [];
  const reload = (items) => ({ onResponseReceivedEndpoints: [
    { reloadContinuationItemsCommand: { targetId: 'comments-section', continuationItems: [header(items.sort)] } },
    { reloadContinuationItemsCommand: { targetId: 'engagement-panel-comments-section', continuationItems: items.list } }], frameworkUpdates: { entityBatchUpdate: { mutations: muts } } });
  const append = (list) => ({ onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: list } }], frameworkUpdates: { entityBatchUpdate: { mutations: muts } } });
  if (tok === FIRST || tok === T.top1) {
    if (variant === 'empty') return { status: 200, json: { onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [{ commentsHeaderRenderer: { countText: { runs: [{ text: '0' }, { text: ' Comments' }] } } }] } }] } };
    return { status: 200, json: reload({ sort: 'top', list: range(1, 20).map((n) => entityItem(comment('top', n, v), muts)).concat([cont(T.top2)]) }) };
  }
  if (tok === T.top2) return { status: 200, json: append(range(21, 40).map((n) => entityItem(comment('top', n, v), muts)).concat([cont(T.top3)])) };
  if (tok === T.top3) return { status: 200, json: { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: range(41, 50).map((n) => legacyItem(comment('top', n, v))) } }] } };
  if (tok === T.new1) return { status: 200, json: reload({ sort: 'new', list: range(1, 20).map((n) => legacyItem(comment('new', n, v))).concat([cont(T.new2)]) }) };
  if (tok === T.new2) return { status: 200, json: { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: range(21, 25).map((n) => legacyItem(comment('new', n, v))) } }] } };
  let m = /^CM-REP-(.+?)(-2)?$/.exec(String(tok || ''));
  if (m) {
    const parent = m[1];
    const more = !!m[2];
    const total = parent === 'UgxTop001' ? 3 : 1;
    const ns = more ? range(3, total) : range(1, Math.min(2, total));
    const list = ns.map((n) => ({ commentViewModel: { commentViewModel: entityThread(reply(parent, n), muts).commentViewModel } }));
    if (!more && total > 2) list.push({ continuationItemRenderer: { button: { buttonRenderer: { text: { runs: [{ text: 'Show more replies' }] }, command: { continuationCommand: { token: 'CM-REP-' + parent + '-2' } } } } } });
    return { status: 200, json: append(list) };
  }
  return { status: 400, json: { error: { code: 400, message: 'fixture: unknown token' } } };
}

/** The comments section of the watch data, per variant. */
function watchData(vid, variant) {
  const sec = variant === 'off'
    ? { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [{ messageRenderer: { text: { runs: [{ text: 'Comments are turned off. ' }, { text: 'Learn more' }] } } }] } }
    : variant === 'none' ? null
      : { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [cont(FIRST)] } };
  return { currentVideoEndpoint: { watchEndpoint: { videoId: vid } }, contents: { twoColumnWatchNextResults: { results: { results: { contents: [
    { videoPrimaryInfoRenderer: { title: { runs: [{ text: F.TITLE }] } } }].concat(sec ? [sec] : []) } } } } };
}

/** YouTube's own comments section in the page's DOM: drawn once it is in view (like YouTube's lazy section). */
function ownSection(vid) {
  const firsts = range(1, 20).map((n) => comment('top', n, vid));
  return `<div id="comments-host"><ytd-comments id="comments"><div id="cm-sentinel" style="height:1px"></div></ytd-comments></div>
<script>
(function () {
  var P = window.__presses; P.cmLike = {}; P.cmPost = 0; P.cmReply = 0; P.cmDrawn = 0; P.cmOpen = 0;
  var LIST = ${JSON.stringify(firsts.map((c) => ({ id: c.id, author: c.author, text: c.text, time: c.time, likes: c.likes })))};
  var VID = ${JSON.stringify(vid)};
  var host = document.getElementById('comments');
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function commentHtml(c) {
    return '<ytd-comment-view-model><div id="author-text">' + esc(c.author) + '</div><span id="published-time-text"><a href="/watch?v=' + VID + '&lc=' + c.id + '">' + esc(c.time) + '</a></span>' +
      '<div id="content-text">' + esc(c.text) + '</div><ytd-comment-engagement-bar><span id="vote-count-middle">' + esc(c.likes) + '</span>' +
      '<div id="like-button"><button aria-pressed="false" aria-label="Like this comment">Like</button></div><div id="reply-button-end"><button aria-label="Reply">Reply</button></div></ytd-comment-engagement-bar></ytd-comment-view-model>';
  }
  function box(where, submitCount) {
    var b = document.createElement('ytd-commentbox');
    b.innerHTML = '<div id="contenteditable-root" contenteditable="true"></div><div id="submit-button"><button disabled>Comment</button></div>';
    var ed = b.querySelector('#contenteditable-root'), sb = b.querySelector('#submit-button button');
    ed.addEventListener('input', function () { sb.disabled = !ed.textContent.trim(); });
    sb.addEventListener('click', function () {
      submitCount();
      var c = { id: 'UgxMine' + Date.now(), author: '@lumen-tester', text: ed.textContent.trim(), time: 'just now', likes: '' };
      var t = document.createElement('ytd-comment-thread-renderer'); t.innerHTML = commentHtml(c);
      setTimeout(function () { where(t); b.remove(); wire(t); }, 200);
    });
    return b;
  }
  function wire(scope) {
    scope.querySelectorAll('#like-button button').forEach(function (lb) {
      if (lb.__w) return; lb.__w = 1;
      lb.addEventListener('click', function () {
        var id = (/lc=([^&]+)/.exec(lb.closest('ytd-comment-view-model').querySelector('#published-time-text a').getAttribute('href')) || [])[1];
        P.cmLike[id] = (P.cmLike[id] || 0) + 1;
        var on = lb.getAttribute('aria-pressed') !== 'true';
        setTimeout(function () { lb.setAttribute('aria-pressed', String(on)); }, 120);
      });
    });
    scope.querySelectorAll('#reply-button-end button').forEach(function (rb) {
      if (rb.__w) return; rb.__w = 1;
      rb.addEventListener('click', function () {
        var th = rb.closest('ytd-comment-thread-renderer');
        if (th.querySelector('ytd-commentbox')) return;
        var rep = th.querySelector('#replies') || th.appendChild(Object.assign(document.createElement('div'), { id: 'replies' }));
        th.insertBefore(box(function (t) { rep.appendChild(t.firstElementChild); }, function () { P.cmReply++; }), rep);
      });
    });
  }
  function draw() {
    if (P.cmDrawn) return; P.cmDrawn++;
    var h = document.createElement('ytd-comments-header-renderer');
    h.innerHTML = '<h2>${COUNT} Comments</h2><div id="simple-box"><div id="placeholder-area">Add a comment...</div></div>';
    var contents = document.createElement('div'); contents.id = 'contents';
    LIST.forEach(function (c) { var t = document.createElement('ytd-comment-thread-renderer'); t.innerHTML = commentHtml(c); contents.appendChild(t); });
    host.appendChild(h); host.appendChild(contents); wire(contents);
    h.querySelector('#placeholder-area').addEventListener('click', function () {
      P.cmOpen++;
      if (h.querySelector('ytd-commentbox')) return;
      h.appendChild(box(function (t) { contents.insertBefore(t, contents.firstChild); }, function () { P.cmPost++; }));
    });
  }
  // YouTube draws its section only when the section is in view (its own visibility check).
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) draw(); }); });
  io.observe(document.getElementById('cm-sentinel'));
})();
</script>`;
}

/** The watch page, with the comments variant. */
function watch(q) {
  const o = q || {};
  let html = F.youtubeWatch(o);
  const vid = o.vid || 'pvTest00001';
  // The page's own innertube config, and its comments section per variant.
  const patch = `<script>
  window.ytcfg.d.INNERTUBE_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20261001.00.00', hl: 'en' } };
  window.ytcfg.d.INNERTUBE_CLIENT_VERSION = '2.20261001.00.00'; window.ytcfg.d.INNERTUBE_CONTEXT_CLIENT_NAME = 1;
  (function () { var yd = window.ytInitialData; if (!yd) return; var want = ${JSON.stringify(watchData('__V__', o.cm).contents.twoColumnWatchNextResults.results.results.contents.slice(1))};
    var cs = yd.contents.twoColumnWatchNextResults.results.results.contents;
    yd.contents.twoColumnWatchNextResults.results.results.contents = cs.filter(function (c) { return !(c.itemSectionRenderer && c.itemSectionRenderer.sectionIdentifier === 'comment-item-section'); }).concat(want); })();
</script></head>`;
  html = html.replace('</head>', patch);
  html = html.replace(/<div id="comments"><ytd-comments>[\s\S]*?<\/ytd-comments><\/div>/, o.cm === 'off' || o.cm === 'none' ? '' : ownSection(vid));
  return html;
}

module.exports = { watch, next, comment, reply, FIRST, T, COUNT, C1_TEXT, LONG, NAMES };
