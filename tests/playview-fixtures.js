// tests/playview-fixtures.js -- LOCAL stand-ins for the pages Lumen's playback view hosts (watch-playview-e2e.js).
// Never a real service: a fake youtube.com/watch page with the real ids (#masthead, #secondary, #comments, the
// sponsored cards, #movie_player playing a local looping clip, ytd-watch-metadata with the title, the channel, the
// subscriber count, the description, and the Like, Dislike, Subscribe and Save buttons, each counting its presses),
// and a fake player page for each of Disney+, Hulu, Prime Video and ESPN+ (a header, the player root, a footer).
//
// youtubeWatch(q): q.signedout, q.bare (a player and nothing else), q.noplayer (no #movie_player), q.still (YouTube's
// "Video paused. Continue watching?" after 600 ms), q.links (a description with YouTube's own links: chapter times,
// another site, an @handle, a hashtag, another video, a javascript: link, hostile markup as text; q.vid is the page's
// video id). #movie_player has YouTube's seekTo / playVideo,
// counted in window.__seeks / window.__plays.
'use strict';

const TITLE = 'Lumen Test Video: jumping gjpqy glyphs';
const CHANNEL = 'Lumen Test Channel';
const SUBS = '1.24M subscribers';
const DESC = 'A local clip for Lumen’s playback view.\nSecond line of the description, with descenders: gjpqy.\nThird line.\nFourth line that only shows after Show more.';
// q.links: a description drawn the way YouTube draws it (relative hrefs for its own pages, /redirect for other
// sites), with hostile markup as TEXT (escaped here, so the page's innerText has the raw "<script>" words).
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
function descLinksHtml(vid) {
  const v = encodeURIComponent(String(vid || '').replace(/[^\w-]/g, ''));
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const other = 'https://www.youtube.com/redirect?event=video_description&amp;q=https%3A%2F%2Fexample.com%2Fdocs';
  return `Chapters: <a class="yt-core-attributed-string__link" href="/watch?v=${v}&amp;t=0s">0:00</a> Intro, <a class="yt-core-attributed-string__link" href="/watch?v=${v}&amp;t=20s">0:20</a> The middle\n` +
    `Site: <a class="yt-core-attributed-string__link" href="${other}">example.com/docs</a> by <span class="yt-core-attributed-string--link-inherit-color"><a class="yt-core-attributed-string__link" href="/@lumentest">@lumentest</a></span> <a class="yt-core-attributed-string__link" href="/hashtag/lumentest">#lumentest</a>\n` +
    `Next: <a class="yt-core-attributed-string__link" href="/watch?v=pvOther0001">Another video</a>. Bad: <a href="javascript:window.__pwned=3">not a link</a>\n` +
    `${esc(HOSTILE)}\n` +
    `${'More words that fill the lines under the fold. '.repeat(10)}\n` +
    `Later:<a class="yt-core-attributed-string__link" href="/watch?v=${v}&amp;t=5s">0:05</a> after the fold`;
}
const META = '48,213 views · 3 days ago';
const TOKEN = 'FAKE-COMMENTS-CONTINUATION-TOKEN-0001';
const AVATAR = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="#5b6b7a"/><text x="44" y="58" font-size="40" text-anchor="middle" fill="#fff" font-family="Segoe UI">L</text></svg>');

const BASE_CSS = `body{margin:0;background:#fff;color:#0f0f0f;font:14px/1.4 Roboto,"Segoe UI",sans-serif}
ytd-app,ytd-watch-flexy,ytd-masthead,ytd-watch-metadata,ytd-video-owner-renderer,ytd-channel-name,ytd-subscribe-button-renderer,
segmented-like-dislike-button-view-model,like-button-view-model,dislike-button-view-model,ytd-text-inline-expander,yt-attributed-string,
ytd-comments,ytd-ad-slot-renderer,ytd-popup-container,tp-yt-paper-dialog,yt-confirm-dialog-renderer,ytd-add-to-playlist-renderer,
ytd-playlist-add-to-option-renderer,tp-yt-paper-checkbox,yt-formatted-string{display:block}
#masthead-container{position:sticky;top:0;z-index:5;background:#fff;height:56px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid #ddd}
#columns{display:flex;gap:24px;padding:24px}#primary{flex:1;min-width:0}#secondary{width:400px;flex:none}
#movie_player{position:relative;width:100%;aspect-ratio:16/9;background:#000;overflow:hidden}
#movie_player video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.ytp-chrome-bottom{position:absolute;left:12px;right:12px;bottom:0;height:44px;display:flex;align-items:center;gap:12px;color:#fff;font-size:13px;
  background:linear-gradient(transparent,rgba(0,0,0,.6))}
.ytp-progress{flex:1;height:3px;background:rgba(255,255,255,.3)}.ytp-progress i{display:block;width:30%;height:100%;background:#f00}
.ytp-ad-module{position:absolute;right:12px;bottom:60px}
#top-row{display:flex;justify-content:space-between;align-items:center;margin-top:12px}#owner{display:flex;align-items:center;gap:12px}
#avatar img{width:40px;height:40px;border-radius:50%}button{font:inherit}
.sponsored{border:2px solid #f90;padding:12px;margin-bottom:12px}.rec{padding:8px 0;border-bottom:1px solid #eee}
tp-yt-paper-dialog{position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);background:#fff;padding:20px;box-shadow:0 4px 24px rgba(0,0,0,.4);z-index:3000}`;

// The late redraw (r64, ?late=<ms>): YouTube's own in-page move the way it really goes. Lumen's Play now asks the
// app to move (watch-player-yt.js MOVE_JS: a yt-navigate on ytd-app, answered by yt-navigate-start); the address
// changes AT ONCE, but the title, the channel, the buttons' labels, document.title and ytd-watch-flexy's video-id
// still say the last video until its data is in, <ms> later (Shorts measured up to ~650 ms on real YouTube).
// ytInitialData stays the first video's, as on YouTube. window.__late keeps the times for the e2e.
const LATE_T = 'Late video B, drawn after the move';
const LATE_C = 'Late Channel B';
function lateMove(ms) {
  const lag = Math.max(0, Math.min(5000, Number(ms) || 0));
  return `(function () {
    var app = document.querySelector('ytd-app');
    window.__late = { lag: ${lag}, moves: 0, movedAt: 0, drawnAt: 0, to: '' };
    app.addEventListener('yt-navigate', function (e) {
      var ep = e.detail && e.detail.endpoint, we = ep && ep.watchEndpoint;
      if (!we || !we.videoId) return;
      var id = String(we.videoId);
      window.__late.moves++; window.__late.to = id; window.__late.movedAt = Date.now();
      history.pushState({}, '', '/watch?v=' + encodeURIComponent(id));
      window.dispatchEvent(new CustomEvent('yt-navigate-start'));
      setTimeout(function () {
        document.querySelector('ytd-watch-flexy').setAttribute('video-id', id);
        document.querySelector('ytd-watch-metadata #title h1 yt-formatted-string').textContent = ${JSON.stringify(LATE_T)};
        document.querySelector('#channel-name #text a').textContent = ${JSON.stringify(LATE_C)};
        document.querySelector('#owner-sub-count').textContent = '7 subscribers';
        document.querySelector('#sub').setAttribute('aria-label', 'Subscribe to ' + ${JSON.stringify(LATE_C)} + '.');
        document.querySelector('#description-inline-expander yt-attributed-string').textContent = 'The late video’s own description.';
        document.title = ${JSON.stringify(LATE_T + ' - YouTube')};
        window.__late.drawnAt = Date.now();
      }, ${lag});
    });
  })();`;
}

// A page whose reads all fail after the early one (r64 #5, ?earlyfail): ytInitialPlayerResponse is there at once
// (the early read takes its words), a slow script holds DOMContentLoaded back so that read lands first, and from
// DOMContentLoaded on every read Lumen asks of the page throws (window.__lumenPv answers v, apply and early only).
const EARLY_T = 'Early words, then no read works';
function earlyFailHead(vid) {
  return `window.ytInitialPlayerResponse = { videoDetails: { videoId: ${JSON.stringify(String(vid || ''))}, title: ${JSON.stringify(EARLY_T)}, author: 'Early Channel', channelId: '', shortDescription: '' } };
  (function () {
    var cur, broken = false;
    var bad = function () { throw new Error('this test page answers no read'); };
    Object.defineProperty(window, '__lumenPv', { configurable: false,
      get: function () { return broken && cur ? { v: cur.v, apply: cur.apply, early: cur.early, read: bad, tick: bad, watch: bad, press: bad, seek: bad } : cur; },
      set: function (x) { cur = x; } });
    document.addEventListener('DOMContentLoaded', function () { broken = true; window.__brokenAt = Date.now(); });
  })();`;
}

function youtubeWatch(q) {
  const o = q || {};
  const masthead = `<div id="masthead-container"><ytd-masthead id="masthead"><b>YouTube</b><input id="search" placeholder="Search" style="width:420px">
    ${o.signedout ? '<a id="signin" href="https://accounts.google.com/ServiceLogin?service=youtube">Sign in</a>' : '<button id="avatar-btn">O</button>'}</ytd-masthead></div>`;
  const player = o.noplayer ? '<div id="no-player"><video id="v" src="/__media/clip.mp4" autoplay muted loop playsinline style="width:100%"></video></div>' :
    `<div id="player"><div id="movie_player" class="html5-video-player" tabindex="-1"><div class="html5-video-container">
      <video id="v" class="video-stream html5-main-video" src="/__media/clip.mp4" autoplay muted loop playsinline></video></div>
      <div class="ytp-ad-module"></div><div class="ytp-chrome-bottom"><span id="ytp-play">❚❚</span><div class="ytp-progress"><i></i></div><span>CC</span><span>HD</span><span id="ytp-fs">⛶</span></div></div></div>`;
  const meta = o.bare ? '' : `<div id="below"><ytd-watch-metadata>
    <div id="title"><h1><yt-formatted-string>${TITLE}</yt-formatted-string></h1></div>
    <div id="top-row"><div id="owner"><ytd-video-owner-renderer><a id="avatar" href="/@lumentest"><img src="${AVATAR}" alt=""></a>
      <div id="upload-info"><ytd-channel-name id="channel-name"><div id="container"><div id="text-container"><yt-formatted-string id="text"><a href="/@lumentest">${CHANNEL}</a></yt-formatted-string></div></div></ytd-channel-name>
      <yt-formatted-string id="owner-sub-count">${SUBS}</yt-formatted-string></div></ytd-video-owner-renderer>
      <div id="subscribe-button"><ytd-subscribe-button-renderer><button id="sub" aria-label="Subscribe to ${CHANNEL}.">Subscribe</button></ytd-subscribe-button-renderer></div></div>
      <div id="actions"><div id="top-level-buttons-computed"><segmented-like-dislike-button-view-model>
        <like-button-view-model><button id="like" aria-pressed="false" aria-label="like this video along with 12,345 other people">12K</button></like-button-view-model>
        <dislike-button-view-model><button id="dislike" aria-pressed="false" aria-label="Dislike this video"></button></dislike-button-view-model></segmented-like-dislike-button-view-model>
        <button id="save" aria-label="Save to playlist">Save</button></div></div></div>
    <div id="description"><div id="info-container"><span id="info">${META}</span></div>
      <ytd-text-inline-expander id="description-inline-expander"><yt-attributed-string${o.links ? ' style="white-space:pre-wrap"' : ''}>${o.links ? descLinksHtml(o.vid) : DESC}</yt-attributed-string><button id="expand">...more</button></ytd-text-inline-expander></div>
    </ytd-watch-metadata>
    <div id="comments"><ytd-comments><h2>Comments</h2><p class="comment">Comment one, from a viewer.</p></ytd-comments></div></div>`;
  const secondary = `<div id="secondary"><div id="player-ads"><ytd-ad-slot-renderer class="sponsored">Sponsored: a card that must not show</ytd-ad-slot-renderer></div>
    <div id="related">${[1, 2, 3, 4, 5, 6].map((i) => `<div class="rec">Recommended video ${i}</div>`).join('')}</div></div>`;
  const data = {
    currentVideoEndpoint: { watchEndpoint: { videoId: '__VID__' } },
    contents: { twoColumnWatchNextResults: { results: { results: { contents: [
      { videoPrimaryInfoRenderer: { title: { runs: [{ text: TITLE }] }, viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '48,213 views' } } }, dateText: { simpleText: '3 days ago' } } },
      { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: { runs: [{ text: CHANNEL }] }, subscriberCountText: { simpleText: SUBS }, thumbnail: { thumbnails: [{ url: AVATAR }] } } },
        attributedDescription: { content: DESC } } },
      { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: TOKEN } } } }] } },
    ] } } } },
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${o.bare ? 'YouTube' : TITLE + ' - YouTube'}</title><style>${BASE_CSS}</style>
<script>
  var VID = new URL(location.href).searchParams.get('v') || '';
  window.ytcfg = { d: { LOGGED_IN: ${o.signedout ? 'false' : 'true'} }, get: function (k) { return this.d[k]; } };
  ${o.bare ? '' : 'window.ytInitialData = JSON.parse(' + JSON.stringify(JSON.stringify(data)) + '.replace("__VID__", VID));'}
  window.__presses = { like: 0, dislike: 0, sub: 0, confirm: 0, save: 0, saveOpt: 0, saveClose: 0 };
  window.__keys = [];
  window.__born = Date.now() + ':' + Math.random();
  ${o.earlyfail ? earlyFailHead(o.vid) : ''}
</script></head>
<body>${o.earlyfail ? '<script src="/__slow.js"></script>' : ''}<ytd-app>${masthead}<div id="page-manager"><ytd-watch-flexy${o.late ? ' video-id="' + String(o.vid || '').replace(/[^\w-]/g, '') + '"' : ''}><div id="columns"><div id="primary">${player}${meta}</div>${secondary}</div></ytd-watch-flexy></div></ytd-app>
<ytd-popup-container id="popups"></ytd-popup-container>
<script>
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var P = window.__presses, pops = $('#popups');
  var like = $('#like'), dis = $('#dislike'), sub = $('#sub'), save = $('#save');
  function setSub(on) { var h = sub.closest('ytd-subscribe-button-renderer'); if (on) h.setAttribute('subscribed', ''); else h.removeAttribute('subscribed');
    sub.textContent = on ? 'Subscribed' : 'Subscribe'; sub.setAttribute('aria-label', (on ? 'Unsubscribe from ' : 'Subscribe to ') + ${JSON.stringify(CHANNEL)} + '.'); }
  if (like) like.addEventListener('click', function () { P.like++; var on = like.getAttribute('aria-pressed') !== 'true'; like.setAttribute('aria-pressed', String(on)); if (on) dis.setAttribute('aria-pressed', 'false'); });
  if (dis) dis.addEventListener('click', function () { P.dislike++; var on = dis.getAttribute('aria-pressed') !== 'true'; dis.setAttribute('aria-pressed', String(on)); if (on) like.setAttribute('aria-pressed', 'false'); });
  if (sub) sub.addEventListener('click', function () {
    P.sub++;
    if (${o.signedout ? 'true' : 'false'}) return;   // signed out: YouTube would show its sign-in card (never pressed by Lumen)
    if (!sub.closest('ytd-subscribe-button-renderer').hasAttribute('subscribed')) { setSub(true); return; }
    var d = document.createElement('tp-yt-paper-dialog');
    d.innerHTML = '<yt-confirm-dialog-renderer><p>Unsubscribe from ' + ${JSON.stringify(CHANNEL)} + '?</p><div id="cancel-button"><button>Cancel</button></div><div id="confirm-button"><button>Unsubscribe</button></div></yt-confirm-dialog-renderer>';
    setTimeout(function () { pops.appendChild(d); }, 150);
    d.querySelector('#confirm-button button').addEventListener('click', function () { P.confirm++; setSub(false); d.remove(); });
    d.querySelector('#cancel-button button').addEventListener('click', function () { d.remove(); });
  });
  if (save) save.addEventListener('click', function () {
    P.save++;
    if (document.querySelector('ytd-add-to-playlist-renderer')) return;
    var r = document.createElement('tp-yt-paper-dialog');
    r.innerHTML = '<ytd-add-to-playlist-renderer><div id="header">Save video to...</div><div id="close-button"><button>X</button></div>' +
      [['Watch later', false], ['Lumen picks', true]].map(function (x) { return '<ytd-playlist-add-to-option-renderer><tp-yt-paper-checkbox id="checkbox" aria-checked="' + x[1] + '"' + (x[1] ? ' checked' : '') + '><div id="label">' + x[0] + '</div></tp-yt-paper-checkbox></ytd-playlist-add-to-option-renderer>'; }).join('') + '</ytd-add-to-playlist-renderer>';
    setTimeout(function () {
      pops.appendChild(r);
      r.querySelectorAll('#checkbox').forEach(function (cb) { cb.addEventListener('click', function () { P.saveOpt++; var on = cb.getAttribute('aria-checked') !== 'true'; cb.setAttribute('aria-checked', String(on)); if (on) cb.setAttribute('checked', ''); else cb.removeAttribute('checked'); }); });
      r.querySelector('#close-button button').addEventListener('click', function () { P.saveClose++; r.remove(); });
    }, 120);
  });
  // YouTube's own keys, on the document, the way its player takes them.
  document.addEventListener('keydown', function (e) {
    var v = document.getElementById('v'), mp = document.getElementById('movie_player');
    if (!v || e.ctrlKey || e.altKey || e.metaKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === ' ' || k === 'k') { if (v.paused) v.play().catch(function () {}); else v.pause(); }
    else if (k === 'j') v.currentTime = Math.max(0, v.currentTime - 10);
    else if (k === 'l') v.currentTime = v.currentTime + 10;
    else if (k === 'm') v.muted = !v.muted;
    else if (k === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else if (mp) mp.requestFullscreen().catch(function (err) { window.__fsErr = String(err); }); }
    else return;
    window.__keys.push(k);
    e.preventDefault();
  });
  // YouTube's player API on #movie_player, the part Lumen's description times use: seekTo and playVideo, counted.
  window.__seeks = [];
  window.__plays = 0;
  (function () {
    var mp0 = document.getElementById('movie_player'), v0 = document.getElementById('v');
    if (!mp0 || !v0) return;
    mp0.seekTo = function (t) { window.__seeks.push(Number(t)); v0.currentTime = Number(t) || 0; };
    mp0.playVideo = function () { window.__plays++; var r = v0.play(); if (r && r.catch) r.catch(function () {}); };
  })();
  ${o.still ? `setTimeout(function () { var d = document.createElement('tp-yt-paper-dialog'); d.id = 'still'; d.innerHTML = '<yt-confirm-dialog-renderer><p>Video paused. Continue watching?</p><div id="confirm-button"><button>Yes</button></div></yt-confirm-dialog-renderer>'; pops.appendChild(d); }, 600);` : ''}
  ${o.late ? lateMove(o.late) : ''}
})();
</script></body></html>`;
}

// The services' own player pages: a header and a footer of their own, the player root (the id or class Lumen
// looks for, for that service), the clip, and a control bar inside the root.
const ROOT_FOR = {
  disney: ['div', 'id="hudson-wrapper"'],
  hulu: ['div', 'id="web-player-app"'],
  prime: ['div', 'id="dv-web-player"'],
  espn: ['div', 'class="btm-media-player"'],
};
const NAME_FOR = { disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN+' };
function servicePlayer(svc, title) {
  const r = ROOT_FOR[svc];
  const name = NAME_FOR[svc];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Watch ${title} | ${name}</title><meta property="og:title" content="${title}">
<style>body{margin:0;background:#1a1d29;color:#fff;font:14px/1.4 "Segoe UI",sans-serif}header{height:64px;display:flex;align-items:center;padding:0 24px;background:#0e0f14}
.wrap{padding:24px}[data-box]{position:relative;width:70%;aspect-ratio:16/9;background:#000}[data-box] video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.ctl{position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:linear-gradient(transparent,rgba(0,0,0,.7))}
.more{margin-top:24px;display:flex;gap:12px}.more div{width:160px;height:90px;background:#2b3040}</style></head>
<body><header id="svc-header">${name} — the service’s own header</header><div class="wrap">
<${r[0]} ${r[1]} data-box="playerbox"><video id="v" src="/__media/clip.mp4" autoplay muted loop playsinline></video><div class="ctl controls__footer">▶ ${name} controls</div></${r[0]}>
<section class="more" id="svc-more"><div></div><div></div><div></div></section><footer id="svc-footer">${name} footer</footer></div>
<script>window.__keys = []; document.addEventListener('keydown', function (e) { window.__keys.push(e.key); });</script></body></html>`;
}

module.exports = { youtubeWatch, servicePlayer, TITLE, CHANNEL, SUBS, DESC, META, TOKEN, NAME_FOR, HOSTILE, LATE_T, LATE_C, EARLY_T };
