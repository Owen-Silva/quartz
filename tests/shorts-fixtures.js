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
      <video class="html5-main-video" src="/__media/short.mp4" muted loop playsinline preload="${i === start ? 'auto' : 'none'}"></video>
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

module.exports = { SHORTS, PLAYLISTS, shortsPage, channelShorts, list };
