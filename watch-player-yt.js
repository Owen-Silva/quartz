/* ============================================================
   watch-player-yt.js -- YouTube in Lumen's player layer.

   A YouTube video plays as YouTube's FULL watch page in the layer
   (comments, Like, Subscribe, Save, the description), in Quartz's
   normal session, so it is his signed-in YouTube. The embed is used
   only where the full page does not fit:
     - a multiview tile (s.multi): just the video;
     - the fallback, when the full page didn't load: "Play just the
       video" on the failed state.
   Any slot showing the embed gets a one-click "Full page" in the
   layer's bar, which loads that video's watch page in the same slot
   at the same start time.

   Loaded by index.html before watch-player.js, which calls in at
   its hooks (slotUrl, referrer, bar, sync, stateActs); with this
   file missing, the layer plays whatever URL it was given. Also a
   CommonJS module for the unit harness (pure parts only).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./watch-player-hosts'));
  else root.WatchPlayerYT = factory(root.WatchPlayerHosts);
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  // The same app identity watch/preview.js sends: YouTube's embed refuses to play (error 153)
  // without a Referer naming the app that embeds it. Only the embed gets it.
  var REFERER = 'https://github.com/Owen-Silva/quartz';
  var ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }

  /**
   * The ONE video a YouTube slot's URL is: { id, start, origin, embed } or null. service: the
   * slot's service; a test origin (rebased 127.0.0.1) counts when the slot says 'youtube'.
   */
  function videoOf(url, service) {
    var u = parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    var short = /(^|\.)youtu\.be$/i.test(u.hostname);
    if (service !== 'youtube' && !short && !(H && H.serviceFor(u.href) === 'youtube')) return null;
    var id = '';
    var embed = false;
    if (short) id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      var m = /^\/(embed|live)\/([^/?#]+)/.exec(u.pathname);
      if (m) { id = m[2]; embed = m[1] === 'embed'; }
    }
    if (!ID_RE.test(id)) return null;
    var t = u.searchParams.get('t') || u.searchParams.get('start') || '';
    var start = H && typeof H.seconds === 'function' ? H.seconds(t) : (/^\d+$/.test(t) ? Number(t) : 0);
    return { id: id, start: start, origin: short ? 'https://www.youtube.com' : u.origin, embed: embed };
  }

  /** The embed with sound and YouTube's own controls (a tile, or the fallback). */
  function embedUrl(v) {
    return v.origin + '/embed/' + v.id + '?autoplay=1&playsinline=1&rel=0' + (v.start ? '&start=' + v.start : '');
  }
  /** The full watch page, at the same time. */
  function pageUrl(v) {
    return v.origin + '/watch?v=' + v.id + (v.start ? '&t=' + v.start + 's' : '');
  }
  /** 'embed' for a multiview tile, else 'page': the full watch page is the default. */
  function modeFor(o) { return o && o.multi ? 'embed' : 'page'; }

  /** What a slot should load for `url`: the same URL, or the page/embed form of that video. */
  function slotUrlFor(url, o) {
    var x = o || {};
    var v = videoOf(url, x.service);
    if (!v) return url;
    var want = modeFor(x);
    if (want === 'embed' && !v.embed) return embedUrl(v);
    if (want === 'page' && v.embed) return pageUrl(v);
    return url;
  }

  /* ---------------------------------------------------------------- the layer's hooks */

  var UI = { fullBtn: null, lastFull: '', pv: false };

  function slotUrl(ctx, s, url) {
    var next = slotUrlFor(url, { service: s.service, multi: !!s.multi });
    return next !== url ? next : undefined;
  }
  function referrer(ctx, s, url) {
    var v = videoOf(url, s.service);
    return v && v.embed ? REFERER : undefined;
  }
  function fullPage(ctx, s) {
    var slot = s || ctx.focused();
    var v = slot && slot.view ? videoOf(slot.url, slot.service) : null;
    if (!v || !v.embed) return false;
    var u = pageUrl(v);
    UI.lastFull = u;
    slot.url = u;
    try { var pr = slot.view.loadURL(u); if (pr && pr.catch) pr.catch(function () { /* did-fail-load says the rest */ }); } catch (e) { slot.view.setAttribute('src', u); }
    if (UI.fullBtn) UI.fullBtn.hidden = true;
    return true;
  }
  function bar(ctx, barEl) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wp-btn wp-yt-full';
    b.textContent = 'Full page';
    b.title = 'YouTube’s full page: comments, Like, Subscribe, Save';
    b.setAttribute('aria-label', 'Open YouTube’s full page for this video: comments, Like, Subscribe and Save');
    b.hidden = true;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      // Lumen's view (watch-playview.js): the same button switches between the view and the full page.
      var PV = window.LumenPlayview;
      if (UI.pv && PV && typeof PV.toggle === 'function' && PV.toggle(ctx.focused())) { sync(ctx, ctx.focused()); return; }
      fullPage(ctx);
    });
    UI.fullBtn = b;
    barEl.appendChild(b);
  }
  function sync(ctx, s) {
    if (!UI.fullBtn) return;
    var PV = typeof window !== 'undefined' ? window.LumenPlayview : null;
    var pv = PV && typeof PV.toggleFor === 'function' && s ? PV.toggleFor(s) : null;
    UI.pv = !!pv;
    if (pv) {
      UI.fullBtn.hidden = false;
      UI.fullBtn.textContent = pv.label;
      UI.fullBtn.title = pv.title;
      UI.fullBtn.setAttribute('aria-label', pv.title);
      return;
    }
    UI.fullBtn.textContent = 'Full page';
    UI.fullBtn.title = 'YouTube’s full page: comments, Like, Subscribe, Save';
    UI.fullBtn.setAttribute('aria-label', 'Open YouTube’s full page for this video: comments, Like, Subscribe and Save');
    var v = s && s.view ? videoOf(s.url, s.service) : null;
    UI.fullBtn.hidden = !(v && v.embed);
  }
  function stateActs(ctx, s, kind, acts) {
    if (kind !== 'failed' || !s.view) return;
    var v = videoOf(s.url, s.service);
    if (!v || v.embed) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wp-btn';
    b.textContent = 'Play just the video';
    b.title = 'YouTube’s embedded player, without comments; “Full page” brings the page back';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var u = embedUrl(v);
      s.state.hidden = true;
      s.tile.classList.remove('has-state');
      s.url = u;
      try { s.view.setAttribute('httpreferrer', REFERER); } catch (err) { /* the load below carries it too */ }
      try { var pr = s.view.loadURL(u, { httpReferrer: REFERER }); if (pr && pr.catch) pr.catch(function () { /* did-fail-load */ }); } catch (err) { s.view.setAttribute('src', u); }
      sync(ctx, s);
    });
    acts.appendChild(b);
  }

  return {
    REFERER: REFERER,
    videoOf: videoOf,
    embedUrl: embedUrl,
    pageUrl: pageUrl,
    modeFor: modeFor,
    slotUrlFor: slotUrlFor,
    // the layer's hooks (watch-player.js X())
    slotUrl: slotUrl,
    referrer: referrer,
    bar: bar,
    sync: sync,
    stateActs: stateActs,
    // e2e: press "Full page" the way a click does, and what the button shows
    _fullPage: function () { return UI.fullBtn && !UI.fullBtn.hidden ? (UI.fullBtn.click(), true) : false; },
    _state: function () { return { fullShown: !!(UI.fullBtn && !UI.fullBtn.hidden), lastFull: UI.lastFull, label: UI.fullBtn ? UI.fullBtn.textContent : '', pv: UI.pv }; }
  };
});
