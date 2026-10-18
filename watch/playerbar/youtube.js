/* ============================================================
   watch/playerbar/youtube.js -- Lumen's play bar on YouTube.

   YouTube's page has its own player API on #movie_player, so every
   menu here is Lumen-drawn: quality (getAvailableQualityLevels /
   setPlaybackQualityRange), captions (the captions module's track
   list, or YouTube's CC button when the list is not there yet) and
   the audio track where the video has more than one.

   Ads: #movie_player wears .ad-showing while one plays. Lumen's bar
   says "Ad" with the time left and refuses to seek; YouTube's own ad
   UI (Skip, the countdown, "Why this ad") stays visible and
   clickable. Nothing here skips, hides or speeds up an ad.

   The `page` functions run INSIDE YouTube's page (the bridge,
   watch-playerbar-page.js, serializes them): no closures, ES5 only.
   ============================================================ */
(function (root, factory) {
  var a = factory();
  if (typeof module === 'object' && module.exports) module.exports = a;
  else { root.LumenPlayerBarAdapters = root.LumenPlayerBarAdapters || {}; root.LumenPlayerBarAdapters[a.id] = a; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    id: 'youtube',
    name: 'YouTube',
    video: ['#movie_player video.html5-main-video', '#movie_player video'],
    // The element whose class says "an ad is playing": watched with one MutationObserver.
    adRoot: '#movie_player',
    // YouTube's own control bar and its top strip (title, share, Watch later in the embed).
    hide: ['.ytp-chrome-bottom', '.ytp-gradient-bottom', '.ytp-chrome-top', '.ytp-gradient-top', '.ytp-large-play-button'],
    // Inside a hidden part, these stay visible and clickable: every ad piece, its Skip button,
    // its "Why this ad" and the countdown, and YouTube's popups (age check, consent, errors).
    keep: ['[class*="ytp-ad"]', '[class*="skip"]', '.ytp-popup', '.ytp-error', '.ytp-offline-slate'],
    // The service's own buttons, for "open YouTube's own menu" (never needed while the API answers).
    own: { captions: '.ytp-subtitles-button', quality: '.ytp-settings-button', audio: '.ytp-settings-button', more: '.ytp-settings-button' },
    next: '.ytp-next-button',
    labels: { quality: 'Quality' },
    page: {
      menus: function (d, v) {
        var p = d.getElementById('movie_player');
        var out = {};
        var LBL = { highres: '4320p (8K)', hd2880: '2880p (5K)', hd2160: '2160p (4K)', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
          large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto' };
        if (p && typeof p.getAvailableQualityLevels === 'function') {
          var lv = [];
          try { lv = p.getAvailableQualityLevels() || []; } catch (e) { lv = []; }
          var cur = '';
          try { cur = typeof p.getPlaybackQuality === 'function' ? String(p.getPlaybackQuality() || '') : ''; } catch (e) { cur = ''; }
          if (lv.length) {
            var items = [];
            if (lv.indexOf('auto') < 0) items.push({ id: 'auto', label: 'Auto' });
            for (var i = 0; i < lv.length; i++) items.push({ id: String(lv[i]), label: LBL[lv[i]] || String(lv[i]) });
            var pref = p.__lumenQ || 'auto';
            out.quality = { via: 'api', items: items, cur: pref, now: LBL[cur] || cur };
          }
        }
        if (p && typeof p.getOption === 'function') {
          var tl = null, ct = null;
          try { tl = p.getOption('captions', 'tracklist'); } catch (e) { tl = null; }
          if (tl && tl.length) {
            try { ct = p.getOption('captions', 'track'); } catch (e) { ct = null; }
            var ci = [], curC = 'off';
            for (var j = 0; j < tl.length; j++) {
              var t = tl[j] || {};
              var id = String(t.languageCode || '') + (t.kind === 'asr' ? ':asr' : '');
              ci.push({ id: id, label: String(t.displayName || t.languageName || t.languageCode || 'Track ' + (j + 1)) });
              if (ct && ct.languageCode && ct.languageCode === t.languageCode && (ct.kind || '') === (t.kind || '')) curC = id;
            }
            out.captions = { via: 'api', off: true, items: ci, cur: curC };
          }
        }
        if (!out.captions) {
          var cc = d.querySelector('.ytp-subtitles-button');
          if (cc && cc.getAttribute('aria-disabled') !== 'true' && cc.style.display !== 'none') {
            out.captions = { via: 'button', off: true, items: [{ id: 'on', label: 'On' }], cur: cc.getAttribute('aria-pressed') === 'true' ? 'on' : 'off' };
          }
        }
        if (p && typeof p.getAvailableAudioTracks === 'function') {
          var at = [];
          try { at = p.getAvailableAudioTracks() || []; } catch (e) { at = []; }
          if (at.length > 1) {
            var cur2 = null;
            try { cur2 = typeof p.getAudioTrack === 'function' ? p.getAudioTrack() : null; } catch (e) { cur2 = null; }
            var ai = [], curA = '';
            for (var k = 0; k < at.length; k++) {
              var a = at[k] || {};
              var aid = String(a.id != null ? a.id : k);
              var nm = a.displayName || a.name || (typeof a.getName === 'function' ? a.getName() : '') || ('Track ' + (k + 1));
              ai.push({ id: aid, label: String(nm) });
              if (cur2 && (cur2 === a || (cur2.id != null && String(cur2.id) === aid))) curA = aid;
            }
            out.audio = { via: 'api', items: ai, cur: curA };
          }
        }
        return out;
      },
      pick: function (kind, id, d, v) {
        var p = d.getElementById('movie_player');
        if (kind === 'quality') {
          if (!p || typeof p.setPlaybackQualityRange !== 'function') return false;
          p.setPlaybackQualityRange(id, id);
          if (id !== 'auto' && typeof p.setPlaybackQuality === 'function') { try { p.setPlaybackQuality(id); } catch (e) { /* the range is enough */ } }
          p.__lumenQ = id;
          return true;
        }
        if (kind === 'captions') {
          var tl = null;
          try { tl = p && typeof p.getOption === 'function' ? p.getOption('captions', 'tracklist') : null; } catch (e) { tl = null; }
          if (tl && tl.length) {
            if (id === 'off') {
              try { p.setOption('captions', 'track', {}); } catch (e) { /* the unload below */ }
              if (typeof p.unloadModule === 'function') p.unloadModule('captions');
              return true;
            }
            for (var i = 0; i < tl.length; i++) {
              var t = tl[i] || {};
              if (String(t.languageCode || '') + (t.kind === 'asr' ? ':asr' : '') === id) {
                if (typeof p.loadModule === 'function') p.loadModule('captions');
                p.setOption('captions', 'track', t);
                return true;
              }
            }
            return false;
          }
          var cc = d.querySelector('.ytp-subtitles-button');
          if (!cc) return false;
          var on = cc.getAttribute('aria-pressed') === 'true';
          if ((id === 'off') === on) cc.click();
          return true;
        }
        if (kind === 'audio') {
          if (!p || typeof p.getAvailableAudioTracks !== 'function' || typeof p.setAudioTrack !== 'function') return false;
          var at = p.getAvailableAudioTracks() || [];
          for (var k = 0; k < at.length; k++) {
            if (String(at[k] && at[k].id != null ? at[k].id : k) === id) { p.setAudioTrack(at[k]); return true; }
          }
          return false;
        }
        return false;
      },
      ad: function (d, v) {
        var p = d.getElementById('movie_player');
        if (!p || !p.classList.contains('ad-showing')) return null;
        var sk = d.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
        var skip = !!(sk && sk.offsetParent !== null && getComputedStyle(sk).display !== 'none');
        var tx = d.querySelector('.ytp-ad-duration-remaining, .ytp-ad-preview-text, .ytp-ad-text');
        var left = v && isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - v.currentTime) : null;
        return { on: true, left: left, text: tx ? String(tx.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '', skip: skip };
      },
      hasNext: function (d) {
        var b = d.querySelector('.ytp-next-button');
        return !!(b && b.getAttribute('aria-disabled') !== 'true' && b.style.display !== 'none' && /[?&]list=/.test(String(location.search)));
      }
    }
  };
});
