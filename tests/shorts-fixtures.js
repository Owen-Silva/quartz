'use strict';
// tests/shorts-fixtures.js -- LOCAL stand-ins for YouTube's Shorts pages, for watch-shorts-e2e.js. Never a real
// service, never the user's account. The video is a SYNTHETIC clip (ffmpeg testsrc2: colour bars and a counter).
//
//   shortsPage(id, q)   youtube.com/shorts/<id> (and /shorts, which picks the first, as YouTube's does): a
//                       ytd-shorts app with one ytd-reel-video-renderer per Short in a scroll-snap container,
//                       each with its player, its title/channel overlay (yt-reel-metapanel-view-model), its
//                       action bar (like/dislike/menu), and YouTube's own up/down buttons. Its own wheel
//                       (one Short per gesture), ArrowUp/ArrowDown and buttons move with history.pushState,
//                       as YouTube's do. Every press is counted in window.__presses; every move in __moves.
//                       q.signedout: ytcfg LOGGED_IN false. q.ad (a Short's index): that Short is an ad
//                       Short (YouTube's ad slot in its player, "Sponsored", a "Visit advertiser" button at
//                       its bottom; presses counted in __presses.adCta).
//                       q.shapes (a shape per Short: ['3x4', '9x16', ...]): that Short's video is
//                       /__media/short.mp4?shape=<shape> (a clip that shape; the e2e serves it), so Shorts differ in shape.
//   channelShorts(path) a channel's Shorts tab: a grid of /shorts/<id> links.
const SHORTS = [
  { id: 'Xk3pQ9vLm2A', title: 'Open chord swap drill in 30 seconds', channel: '@guitarcoachryan', name: 'Guitar Coach Ryan', likes: '12K' },
  { id: 'Rt7nB2wQe5Z', title: 'Three quick-chord drills for tight spaces', channel: '@skillsbybree', name: 'Skills by Bree', likes: '8.4K' },
  { id: 'Hp4sD8kJy1M', title: 'Hammer-ons and pulls, slowed down', channel: '@guitarcoachryan', name: 'Guitar Coach Ryan', likes: '3.1K' },
  { id: 'Vb6mN3cXz9T', title: 'Leg work warm-up before every bike ride', channel: '@bikeratdrills', name: 'Bike Rat Drills', likes: '967' }
];
const PLAYLISTS = ['Watch later', 'Cooking ideas'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function list(id) {
  if (!id || SHORTS.some((s) => s.id === id)) return SHORTS.slice();
  // A Short from Lumen's home row: YouTube's sequence starts with it.
  return [{ id, title: 'Home row Short ' + id, channel: '@lumenhomerow', name: 'Lumen Home Row', likes: '42' }].concat(SHORTS);
}

function shortsPage(id, q) {
  const o = q || {};
  const L = list(id);
  const start = Math.max(0, L.findIndex((s) => s.id === id));
  const reels = L.map((s, i) => `
  <ytd-reel-video-renderer id="r${i}" data-i="${i}"${i === start ? ' is-active' : ''}>
    <div id="player-container">
      <video class="html5-main-video" src="/__media/short.mp4${o.shapes && o.shapes[i] ? '?shape=' + esc(o.shapes[i]) : ''}" muted loop playsinline preload="${i === start ? 'auto' : 'none'}"></video>
      <div class="ytp-chrome-top"><button class="ytp-play-button" aria-label="Pause (k)">II</button></div>${String(i) === String(o.ad) ? `
      <ytd-ad-slot-renderer class="fx-ad"><span class="fx-ad-badge">Sponsored</span><button class="fx-ad-cta" aria-label="Visit advertiser">Visit advertiser</button></ytd-ad-slot-renderer>` : ''}
      <yt-reel-metapanel-view-model id="metapanel">
        <yt-reel-channel-bar-view-model><img class="yt-core-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
          <span class="ytReelChannelBarViewModelChannelName"><a href="/${esc(s.channel)}">${esc(s.channel)}</a></span>
          <subscribe-button-view-model data-ch="${esc(s.channel)}"><button class="sub" aria-label="Subscribe to ${esc(s.name)}">Subscribe</button></subscribe-button-view-model>
        </yt-reel-channel-bar-view-model>
        <yt-shorts-video-title-view-model><h2>${esc(s.title)}</h2></yt-shorts-video-title-view-model>
      </yt-reel-metapanel-view-model>
    </div>
    <reel-action-bar-view-model id="actions">
      <like-button-view-model><button class="like" aria-pressed="false" aria-label="like this video along with ${esc(s.likes)} other people"></button><span class="yt-spec-button-shape-with-label__label">${esc(s.likes)}</span></like-button-view-model>
      <dislike-button-view-model><button class="dislike" aria-pressed="false" aria-label="Dislike this video"></button><span class="yt-spec-button-shape-with-label__label">Dislike</span></dislike-button-view-model>
      <div id="comments-button"><button aria-label="View comments">C</button></div>
      <div id="menu-button"><button class="menu" aria-label="More actions">...</button></div>
    </reel-action-bar-view-model>
  </ytd-reel-video-renderer>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(L[start].title)} #shorts - YouTube</title>
<script>var ytcfg={data_:{LOGGED_IN:${o.signedout ? 'false' : 'true'}},get:function(k){return this.data_[k];}};</script>
<style>
body{margin:0;background:#0f0f0f;color:#f1f1f1;font:14px Roboto,Arial,sans-serif}
#masthead-container{position:fixed;top:0;left:0;right:0;height:56px;background:#0f0f0f;z-index:5;display:flex;align-items:center;padding:0 16px}
tp-yt-app-drawer{position:fixed;left:0;top:56px;bottom:0;width:72px;background:#181818}
ytd-shorts{display:block;position:absolute;top:56px;left:72px;right:0;bottom:0}
#shorts-inner-container{height:100%;overflow-y:scroll;scroll-snap-type:y mandatory;scrollbar-width:none}
ytd-reel-video-renderer{display:flex;justify-content:center;align-items:flex-end;gap:12px;height:100%;padding:12px 0;box-sizing:border-box;scroll-snap-align:start}
#player-container{position:relative;height:100%;aspect-ratio:9/16;background:#000;border-radius:12px;overflow:hidden}
#player-container video{width:100%;height:100%;object-fit:cover;display:block}
.ytp-chrome-top{position:absolute;top:8px;left:8px;right:8px}
ytd-ad-slot-renderer.fx-ad{position:absolute;left:12px;right:12px;bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:8px;z-index:2}
.fx-ad-badge{background:#ffd34d;color:#000;font-weight:700;font-size:12px;padding:2px 6px;border-radius:4px}
.fx-ad-cta{height:36px;padding:0 14px;border:0;border-radius:18px;background:#3ea6ff;color:#000;font-weight:600}
.ytp-chrome-top button{background:rgba(0,0,0,.4);color:#fff;border:0;border-radius:50%;width:36px;height:36px}
#metapanel{position:absolute;left:0;right:0;bottom:0;padding:12px;background:linear-gradient(transparent,rgba(0,0,0,.7))}
#metapanel h2{margin:6px 0 0;font-size:15px}
#actions{display:flex;flex-direction:column;gap:14px}
#actions button{width:48px;height:48px;border-radius:50%;border:0;background:#272727;color:#fff}
#actions button[aria-pressed="true"]{background:#f1f1f1;color:#0f0f0f}
#navigation-container{position:fixed;right:24px;top:40%;display:flex;flex-direction:column;gap:12px}
#navigation-container button{width:56px;height:56px;border-radius:50%;border:0;background:#272727;color:#fff}
#navigation-container button:disabled{opacity:.3}
ytd-popup-container{position:fixed;inset:0;pointer-events:none;z-index:10}
ytd-popup-container > *{pointer-events:auto}
.menu-pop,tp-yt-paper-dialog,ytd-add-to-playlist-renderer{position:fixed;right:90px;bottom:90px;background:#282828;padding:10px;border-radius:12px;display:block}
</style></head><body>
<div id="masthead-container"><ytd-masthead><a id="logo">YouTube</a><input id="search" placeholder="Search"><button id="avatar-btn">O</button></ytd-masthead></div>
<tp-yt-app-drawer id="guide"></tp-yt-app-drawer>
<ytd-shorts><div id="shorts-container"><div id="shorts-inner-container">${reels}</div></div>
  <div id="navigation-container">
    <div id="navigation-button-up"><button aria-label="Previous video">&#9650;</button></div>
    <div id="navigation-button-down"><button aria-label="Next video">&#9660;</button></div>
  </div>
</ytd-shorts>
<ytd-popup-container id="pop"></ytd-popup-container>
<script>
(function () {
  var L = ${JSON.stringify(L)};
  var PL = ${JSON.stringify(PLAYLISTS)};
  var cur = ${start};
  var subs = {}, liked = {}, disliked = {}, saved = {};
  window.__presses = { like: 0, dislike: 0, sub: 0, confirm: 0, menu: 0, saveItem: 0, saveToggle: 0, saveClose: 0, next: 0, prev: 0, adCta: 0 };
  window.__moves = [];
  window.__born = Date.now();
  var box = document.getElementById('shorts-inner-container');
  var reels = [].slice.call(document.querySelectorAll('ytd-reel-video-renderer'));
  var up = document.querySelector('#navigation-button-up button'), dn = document.querySelector('#navigation-button-down button');
  function paint() {
    reels.forEach(function (r, i) {
      var s = L[i];
      var lb = r.querySelector('button.like'), db = r.querySelector('button.dislike'), sb = r.querySelector('button.sub');
      lb.setAttribute('aria-pressed', liked[s.id] ? 'true' : 'false');
      db.setAttribute('aria-pressed', disliked[s.id] ? 'true' : 'false');
      var on = !!subs[s.channel];
      sb.textContent = on ? 'Subscribed' : 'Subscribe';
      sb.setAttribute('aria-label', (on ? 'Unsubscribe from ' : 'Subscribe to ') + s.name);
      if (on) sb.parentNode.setAttribute('subscribed', ''); else sb.parentNode.removeAttribute('subscribed');
    });
    up.disabled = cur === 0;
    dn.disabled = cur === L.length - 1;
  }
  function go(i, how) {
    if (i < 0 || i >= L.length || i === cur) return false;
    reels[cur].removeAttribute('is-active');
    var ov = reels[cur].querySelector('video'); try { ov.pause(); } catch (e) {}
    cur = i;
    reels[i].setAttribute('is-active', '');
    reels[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.pushState({}, '', '/shorts/' + L[i].id + location.search);
    document.title = L[i].title + ' #shorts - YouTube';
    var v = reels[i].querySelector('video'); v.preload = 'auto'; try { v.play().catch(function () {}); } catch (e) {}
    window.__moves.push({ to: L[i].id, how: how, at: Date.now() });
    paint();
    return true;
  }
  up.addEventListener('click', function () { window.__presses.prev++; go(cur - 1, 'button'); });
  dn.addEventListener('click', function () { window.__presses.next++; go(cur + 1, 'button'); });
  // YouTube's own wheel: one Short per gesture (a burst with less than 200 ms between events is one).
  var lastT = 0, armed = true;
  document.querySelector('ytd-shorts').addEventListener('wheel', function (e) {
    e.preventDefault();
    var now = Date.now();
    if (now - lastT > 200) armed = true;
    lastT = now;
    if (armed && Math.abs(e.deltaY) >= 4) { armed = false; go(cur + (e.deltaY > 0 ? 1 : -1), 'wheel'); }
  }, { passive: false });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); go(cur + 1, 'key'); }
    if (e.key === 'ArrowUp') { e.preventDefault(); go(cur - 1, 'key'); }
  });
  [].forEach.call(document.querySelectorAll('.fx-ad-cta'), function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); window.__presses.adCta++; }); });
  var pop = document.getElementById('pop');
  function clearPop() { pop.innerHTML = ''; }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var r = b.closest('ytd-reel-video-renderer'); var s = r ? L[+r.getAttribute('data-i')] : null;
    if (b.classList.contains('like')) { window.__presses.like++; liked[s.id] = !liked[s.id]; if (liked[s.id]) disliked[s.id] = false; paint(); }
    else if (b.classList.contains('dislike')) { window.__presses.dislike++; disliked[s.id] = !disliked[s.id]; if (disliked[s.id]) liked[s.id] = false; paint(); }
    else if (b.classList.contains('sub')) {
      window.__presses.sub++;
      if (!subs[s.channel]) { subs[s.channel] = true; paint(); return; }
      pop.innerHTML = '<tp-yt-paper-dialog><yt-confirm-dialog-renderer><p>Unsubscribe from ' + s.name + '?</p><div id="confirm-button"><button class="ok">Unsubscribe</button></div></yt-confirm-dialog-renderer></tp-yt-paper-dialog>';
      pop.querySelector('.ok').addEventListener('click', function (ev) { ev.stopPropagation(); window.__presses.confirm++; subs[s.channel] = false; clearPop(); paint(); });
    }
    else if (b.classList.contains('menu')) {
      window.__presses.menu++;
      pop.innerHTML = '<div class="menu-pop"><ytd-menu-service-item-renderer class="save-item">Save</ytd-menu-service-item-renderer><ytd-menu-service-item-renderer>Report</ytd-menu-service-item-renderer></div>';
      pop.querySelector('.save-item').addEventListener('click', function () {
        window.__presses.saveItem++;
        var key = L[cur].id;
        pop.innerHTML = '<ytd-add-to-playlist-renderer><div id="close-button"><button class="close">x</button></div>' + PL.map(function (n, i) {
          return '<ytd-playlist-add-to-option-renderer><div id="checkbox" role="checkbox" data-i="' + i + '" aria-checked="' + (!!(saved[key] || {})[i]) + '"></div><span id="label">' + n + '</span></ytd-playlist-add-to-option-renderer>';
        }).join('') + '</ytd-add-to-playlist-renderer>';
        [].forEach.call(pop.querySelectorAll('#checkbox'), function (c) {
          c.addEventListener('click', function () { window.__presses.saveToggle++; var m = saved[key] = saved[key] || {}; var i = +c.getAttribute('data-i'); m[i] = !m[i]; c.setAttribute('aria-checked', String(!!m[i])); });
        });
        pop.querySelector('.close').addEventListener('click', function (ev) { ev.stopPropagation(); window.__presses.saveClose++; clearPop(); });
      });
    }
  });
  if (location.pathname.replace(/\\/+$/, '') === '/shorts') history.replaceState({}, '', '/shorts/' + L[cur].id + location.search);
  paint();
  var v0 = reels[cur].querySelector('video'); try { v0.play().catch(function () {}); } catch (e) {}
  requestAnimationFrame(function () { reels[cur].scrollIntoView({ block: 'start' }); });
})();
</script></body></html>`;
}

function channelShorts(path) {
  const mine = SHORTS.filter((s) => '/' + s.channel === path);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shorts - YouTube</title>
<script>var ytcfg={data_:{LOGGED_IN:true},get:function(k){return this.data_[k];}};</script></head><body style="background:#0f0f0f;color:#fff;font:14px Arial">
<div id="masthead-container"><ytd-masthead>YouTube</ytd-masthead></div>
<ytd-rich-grid-renderer>${mine.map((s) => `<ytd-rich-item-renderer><a href="/shorts/${s.id}" id="thumbnail">${esc(s.title)}</a></ytd-rich-item-renderer>`).join('')}</ytd-rich-grid-renderer>
</body></html>`;
}

/** A channel's avatar: a small coloured disc (data: URL), a different colour per channel. */
function avatarOf(channel) {
  let h = 0;
  for (const c of String(channel)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="24" fill="hsl(${h},55%,45%)"/></svg>`);
}

/**
 * realShortsPage(id, q): youtube.com/shorts/<id> shaped as the REAL page is today (read 10-18 from public Shorts,
 * signed out, in a throwaway profile; sanitized snapshot in tests/yt-real/). What the old stand-in got wrong:
 *   - ONE ytd-reel-video-renderer (no is-active) in #reel-overlay-container, which the page MOVES into the current
 *     sequence slot (div#N.reel-video-in-sequence-new: YouTube's own 9:16 size, smaller than the page, a 16px gap,
 *     neighbours' thumbnails above and below) inside #shorts-container's scroll-snap list;
 *   - its ONE #shorts-player <video> takes each Short in turn; the player sizes it itself (inline width/left from the
 *     player's box, as YouTube's does), so a box Lumen widened later leaves it offset;
 *   - a HIDDEN watch page (ytd-watch-flexy #movie_player) with its own paused <video>, ahead of the Shorts app;
 *   - the channel bar: yt-decorated-avatar-view-model's <img> gets its src only once laid out (an IntersectionObserver,
 *     as YouTube's lazy image does), Subscribe is .ytReelChannelBarViewModelReelSubscribeButton button-view-model
 *     button; the action bar: like-button-view-model, dislike-button-view-model (signed in only), comments, share.
 *   - Up/Down: #navigation-button-up/down ytd-button-renderer button; the wheel is the list's own native scroll-snap
 *     (no wheel script), the page follows the slot that snaps in.
 * q.signedout: ytcfg LOGGED_IN false and no Dislike (as signed out today). q.preload: the neighbours' slots carry
 * their own paused <video> (the per-Short layout some pages still have). Presses in __presses, moves in __moves.
 */
function realShortsPage(id, q) {
  const o = q || {};
  const L = list(id);
  const start = Math.max(0, L.findIndex((s) => s.id === id));
  const slots = L.map((s, i) => `<div id="${i}" class="reel-video-in-sequence-new style-scope ytd-shorts"><div class="reel-video-in-sequence-thumbnail style-scope ytd-shorts"></div>${o.preload && i !== start ? '<video class="fx-preload" src="/__media/short.mp4" preload="auto" muted playsinline></video>' : ''}</div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(L[start].title)} #shorts - YouTube</title>
<script>var ytcfg={data_:{LOGGED_IN:${o.signedout ? 'false' : 'true'}},get:function(k){return this.data_[k];}};</script>
<style>
body{margin:0;background:#0f0f0f;color:#f1f1f1;font:14px Roboto,Arial,sans-serif}
#masthead-container{position:fixed;top:0;left:0;right:0;height:56px;background:#0f0f0f;z-index:5}
ytd-watch-flexy[hidden]{display:none}
ytd-shorts{display:flex;position:fixed;top:56px;left:0;right:0;bottom:0}
#shorts-container{flex:1;display:flex;justify-content:center;overflow-y:scroll;scroll-snap-type:y mandatory;scrollbar-width:none}
#shorts-inner-container{width:100%}
.reel-video-in-sequence-new{--h:calc(100vh - 56px - 96px);position:relative;width:calc(var(--h) * 9 / 16);min-width:180px;height:var(--h);margin:0 auto 16px;border-radius:12px;overflow:hidden;scroll-snap-align:start;background:#222}
.reel-video-in-sequence-thumbnail{position:absolute;inset:0;background:linear-gradient(#333,#111)}
.fx-preload{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
#reel-overlay-container{position:absolute;inset:0;display:flex;justify-content:center}
ytd-reel-video-renderer{position:relative;display:flex;justify-content:center;width:100%;height:100%}
#short-video-container,.player-wrapper{width:100%;height:100%}
#player-container{position:relative;width:100%;height:100%}
ytd-player,#container{display:block;width:100%;height:100%}
#shorts-player{position:relative;width:100%;height:100%;overflow:hidden;background:#000}
.html5-video-container{position:relative;height:0}
#shorts-player video{position:absolute;object-fit:cover}
yt-reel-player-overlay-view-model{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:flex-end;padding:12px;gap:8px}
yt-reel-metapanel-view-model{flex:1}
yt-reel-channel-bar-view-model{display:flex;align-items:center;gap:8px}
yt-avatar-shape img{width:32px;height:32px;border-radius:50%;display:block}
reel-action-bar-view-model{display:flex;flex-direction:column;gap:12px}
reel-action-bar-view-model button{width:48px;height:48px;border-radius:50%;border:0;background:#272727;color:#fff}
.navigation-container{position:fixed;right:24px;top:40%;display:flex;flex-direction:column;gap:12px}
.navigation-container button{width:56px;height:56px;border-radius:50%;border:0;background:#272727;color:#fff}
</style></head><body>
<ytd-app>
<div id="masthead-container"><ytd-masthead><a id="logo">YouTube</a>${o.signedout ? '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>' : '<button id="avatar-btn">O</button>'}</ytd-masthead></div>
<div id="content"><ytd-page-manager id="page-manager">
<ytd-watch-flexy class="watch-root-element" hidden><div id="player-container"><ytd-player id="ytd-player"><div id="container"><div id="movie_player" class="html5-video-player ytp-transparent"><div class="html5-video-container"><video class="video-stream html5-main-video" src="/__media/short.mp4" preload="auto" muted playsinline></video></div><div class="ytp-chrome-bottom"></div></div></div></ytd-player></div></ytd-watch-flexy>
<ytd-shorts>
  <div id="shorts-container"><div id="shorts-inner-container">${slots}</div></div>
  <div class="navigation-container">
    <div id="navigation-button-up" class="navigation-button"><ytd-button-renderer><yt-button-shape><button aria-label="Previous video">&#9650;</button></yt-button-shape></ytd-button-renderer></div>
    <div id="navigation-button-down" class="navigation-button"><ytd-button-renderer><yt-button-shape><button aria-label="Next video">&#9660;</button></yt-button-shape></ytd-button-renderer></div>
  </div>
</ytd-shorts>
</ytd-page-manager></div>
</ytd-app>
<template id="ov"><div id="reel-overlay-container" class="style-scope ytd-shorts">
  <ytd-reel-video-renderer id="reel-video-renderer" class="style-scope ytd-shorts" data-i="${start}">
    <div id="short-video-container" class="short-video-container"><div class="player-wrapper"><div id="player-container" class="player-container">
      <ytd-player id="player"><div id="container"><div id="shorts-player" class="html5-video-player ytp-hide-controls"><div class="html5-video-container"><video class="video-stream html5-main-video" src="/__media/short.mp4" muted loop playsinline preload="auto"></video></div></div></div></ytd-player>
    </div></div>
    <div class="player-controls"><ytd-shorts-player-controls><div id="menu-button"><button-view-model><button class="menu" aria-label="More actions">&#8942;</button></button-view-model></div></ytd-shorts-player-controls></div>
    <yt-reel-player-overlay-view-model>
      <yt-reel-metapanel-view-model>
        <yt-reel-channel-bar-view-model class="ytReelChannelBarViewModelHost">
          <yt-decorated-avatar-view-model><yt-avatar-shape><div class="ytSpecAvatarShapeHost" role="button"><img class="ytCoreImageHost ytSpecAvatarShapeImage" alt=""></div></yt-avatar-shape></yt-decorated-avatar-view-model>
          <span class="ytReelChannelBarViewModelChannelName"><a class="ytAttributedStringLink fx-chan" href="/"></a></span>
          <div class="ytReelChannelBarViewModelReelSubscribeButton"><button-view-model><button class="sub ytSpecButtonShapeNextHost" aria-label="Subscribe">Subscribe</button></button-view-model></div>
        </yt-reel-channel-bar-view-model>
        <yt-shorts-video-title-view-model><h2 class="fx-title"></h2></yt-shorts-video-title-view-model>
      </yt-reel-metapanel-view-model>
      <reel-action-bar-view-model class="ytwReelActionBarViewModelHost">
        <like-button-view-model><toggle-button-view-model><button-view-model><label><button class="like" aria-pressed="false" aria-label=""></button><div class="ytSpecButtonShapeWithLabelLabel"><span class="fx-likes"></span></div></label></button-view-model></toggle-button-view-model></like-button-view-model>${o.signedout ? '' : `
        <dislike-button-view-model><toggle-button-view-model><button-view-model><label><button class="dislike" aria-pressed="false" aria-label="Dislike this video"></button><div class="ytSpecButtonShapeWithLabelLabel"><span>Dislike</span></div></label></button-view-model></toggle-button-view-model></dislike-button-view-model>`}
        <button-view-model><label><button aria-label="View 12 comments">C</button></label></button-view-model>
        <button-view-model><label><button aria-label="Share">S</button></label></button-view-model>
      </reel-action-bar-view-model>
    </yt-reel-player-overlay-view-model>
    </div>
  </ytd-reel-video-renderer>
  <div id="ads-overlay"></div>
</div></template>
<script>
(function () {
  var L = ${JSON.stringify(L.map((s) => Object.assign({ avatar: avatarOf(s.channel) }, s)))};
  var cur = ${start};
  var subs = {}, liked = {}, disliked = {};
  window.__presses = { like: 0, dislike: 0, sub: 0, menu: 0, next: 0, prev: 0 };
  window.__moves = [];
  window.__born = Date.now();
  var box = document.getElementById('shorts-container');
  var ov = document.getElementById('ov').content.firstElementChild;
  var reel = ov.querySelector('ytd-reel-video-renderer'), sp = ov.querySelector('#shorts-player'), v = sp.querySelector('video');
  var img = ov.querySelector('yt-avatar-shape img');
  var up = document.querySelector('#navigation-button-up button'), dn = document.querySelector('#navigation-button-down button');
  // YouTube's lazy image: the src only once the <img> is laid out on screen.
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && !img.getAttribute('src') && img.dataset.src) img.setAttribute('src', img.dataset.src); }); });
  // YouTube's player sizes its <video> itself, from its own box (9:16 by height, centred).
  function size() { var pw = sp.clientWidth, ph = sp.clientHeight; if (!pw || !ph) return; var w = Math.round(ph * 9 / 16); v.style.cssText = 'width: ' + w + 'px; height: ' + ph + 'px; left: ' + Math.round((pw - w) / 2) + 'px; top: 0px;'; }
  new ResizeObserver(size).observe(sp);
  function fill(i) {
    var s = L[i];
    reel.setAttribute('data-i', i);
    ov.querySelector('.fx-title').textContent = s.title;
    var a = ov.querySelector('.fx-chan'); a.textContent = s.channel; a.setAttribute('href', '/' + s.channel + '/shorts');
    ov.querySelector('.fx-likes').textContent = s.likes;
    img.removeAttribute('src'); img.dataset.src = s.avatar; io.unobserve(img); io.observe(img);
    paint();
  }
  function paint() {
    var s = L[cur];
    var lb = ov.querySelector('button.like'), db = ov.querySelector('button.dislike'), sb = ov.querySelector('button.sub');
    lb.setAttribute('aria-pressed', liked[s.id] ? 'true' : 'false');
    lb.setAttribute('aria-label', 'like this video along with ' + s.likes + ' other people');
    if (db) db.setAttribute('aria-pressed', disliked[s.id] ? 'true' : 'false');
    var on = !!subs[s.channel];
    sb.textContent = on ? 'Subscribed' : 'Subscribe';
    sb.setAttribute('aria-label', on ? 'Unsubscribe from ' + s.name : 'Subscribe');
    up.setAttribute('aria-disabled', cur === 0 ? 'true' : 'false');
    dn.setAttribute('aria-disabled', cur === L.length - 1 ? 'true' : 'false');
  }
  function place(i, how) {
    document.getElementById(String(i)).appendChild(ov);
    fill(i);
    try { v.currentTime = 0; } catch (e) {}
    try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
    if (how !== 'scroll') document.getElementById(String(i)).scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  function go(i, how) {
    if (i < 0 || i >= L.length || i === cur) return false;
    cur = i;
    place(i, how);
    history.pushState({}, '', '/shorts/' + L[i].id + location.search);
    document.title = L[i].title + ' #shorts - YouTube';
    window.__moves.push({ to: L[i].id, how: how, at: Date.now() });
    return true;
  }
  place(cur, 'load');
  up.addEventListener('click', function () { window.__presses.prev++; go(cur - 1, 'button'); });
  dn.addEventListener('click', function () { window.__presses.next++; go(cur + 1, 'button'); });
  // The list's own scroll-snap: the slot that snaps in becomes current (a wheel over the list, a trackpad).
  box.addEventListener('scrollend', function () { var i = Math.round(box.scrollTop / (document.getElementById('0').offsetHeight + 16)); if (i !== cur) go(i, 'scroll'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); go(cur + 1, 'key'); }
    if (e.key === 'ArrowUp') { e.preventDefault(); go(cur - 1, 'key'); }
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !ov.contains(b)) return;
    var s = L[cur];
    if (b.classList.contains('like')) { window.__presses.like++; liked[s.id] = !liked[s.id]; if (liked[s.id]) disliked[s.id] = false; paint(); }
    else if (b.classList.contains('dislike')) { window.__presses.dislike++; disliked[s.id] = !disliked[s.id]; if (disliked[s.id]) liked[s.id] = false; paint(); }
    else if (b.classList.contains('sub')) { window.__presses.sub++; if (!subs[s.channel]) { subs[s.channel] = true; paint(); } }
    else if (b.classList.contains('menu')) window.__presses.menu++;
  });
})();
</script></body></html>`;
}

module.exports = { SHORTS, PLAYLISTS, shortsPage, realShortsPage, channelShorts, list, avatarOf };
