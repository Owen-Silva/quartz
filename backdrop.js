/* ============================================================
   backdrop.js — the one blurred picture behind the whole chrome.

   Quartz dresses like Helm: the tab strip, the toolbar and the side
   panes are translucent tints over ONE fixed background layer, and
   that layer is a picture blurred ONCE, ahead of time. This file
   owns that layer (index.html's .backdrop > .bg-base / .bg-photo /
   .bg-wash; backdrop.css paints them).

   What the picture is comes from Settings (key newtabBackground,
   read through Settings.backgroundConfig() and its change events):

     wallpaper  a copy of the Windows wallpaper, made by main into
                <userData>/backgrounds/wallpaper.<ext> (bgfiles.js).
                The default.
     builtin    one of Helm's photos, shipped in assets/backgrounds/ and
                listed by main (Settings.builtinBackground(id)). An id
                this build does not have shows the WALLPAPER instead,
                with state 'fallback' and the reason, so the window is
                never left plain over a stale setting.
     image      the user's own picture, the JPEG Settings keeps in
                IndexedDB (db 'browser', store 'assets', 'newtab-bg').
     video      the user's clip or GIF, main's copy in backgrounds/.
                It PLAYS on the new tab; behind the chrome it is one
                still frame, captured once and cached (below).
     none       no picture: the plain --bg ground.

   How it stays cheap, which is the whole point of the design:

   - The blur happens once per source, into a small canvas (about a
     third of the screen), with ctx.filter set to Helm's 28px scaled
     down by the same factor, and a few sigmas of overscan so the
     edges blur into real pixels instead of fading to grey. The
     result is a JPEG blob set as .bg-photo's background-image, with
     background-size: cover. Resizing the window only rescales a
     bitmap; nothing re-blurs, nothing runs per frame, and there is
     no CSS filter on a full-window layer for this GPU to tile.
   - It redoes the work only when the SOURCE changes: the kind, the
     clip (fileUrl + fileName + clipRev), the picture (imageRev), or
     a "Copy again from Windows". The dim slider, the theme and the
     accent never cause a re-blur (the wash is plain CSS).
   - A video or GIF is decoded exactly once per clip: an offscreen
     <video> (never put in the document) seeks to ~1 s in (10% in
     for a clip under ten seconds), one frame is drawn, the element
     is torn down, and the frame is cached in IndexedDB under
     'bg-still' as { id: fileUrl|fileName|clipRev, blob }. Later
     boots read the cached still and never touch the clip.

   No silent failures: when the picture cannot be had (no wallpaper
   file, a deleted clip, a picture that will not decode) the layer
   falls back to the plain --bg, <body data-bg-state="fallback">,
   and the reason is in Backdrop.state() for Settings to show under
   the picker.

   Public surface:
     <body data-bg-kind="wallpaper|image|video|none"
           data-bg-state="loading|ok|fallback">
     window.Backdrop.state()  -> { kind, state, reason, source }
     window.Backdrop.refresh() -> re-reads the source now
     window.Backdrop.recopyWallpaper() -> { ok, reason, copiedAt }
     'backdropchange' on document, detail = state()
   ============================================================ */
(function () {
  'use strict';

  /* Helm's --bg-blur at full size, and how far down the bitmap is
     rendered. A blurred picture has no detail to lose, so a third of
     the screen is plenty, and the blur radius shrinks with it so the
     result matches Helm's 28px once cover scales it back up. */
  var HELM_BLUR_PX = 28;
  var SCALE = 0.3;
  /* Overscan, in blur radii: Helm's .bg-photo sits at
     inset: calc(var(--bg-blur) * -2.5), so its picture is cover-fitted to
     the window plus 2.5 blur radii on every side and the edges blur into
     real pixels. The same 2.5 here frames the picture exactly as Helm
     does (and is past 99% of a gaussian's weight). */
  var OVERSCAN_SIGMAS = 2.5;
  var OUT_TYPE = 'image/jpeg';
  var OUT_QUALITY = 0.9;

  /* IndexedDB keys in Settings' asset store (db 'browser', 'assets'). */
  var IMAGE_KEY = 'newtab-bg';   // the user's picture (settings.js owns it)
  var STILL_KEY = 'bg-still';    // the cached video/GIF still (this file)
  var STILL_MAX_EDGE = 1280;     // the still is only ever blurred: small is fine
  var STILL_TIMEOUT_MS = 15000;

  var layer = document.querySelector('.backdrop');
  var photoEl = layer ? layer.querySelector('.bg-photo') : null;

  var current = { kind: 'wallpaper', state: 'loading', reason: null, source: null };
  var shownUrl = null;           // the object URL on .bg-photo right now
  var seq = 0;                   // newest render wins; older ones drop out
  var lastSig = null;
  var recopyNote = null;         // a failed "Copy again", told once
  var lastRender = null;         // test seam: what the last blur did

  /* --- reading the setting ---------------------------------------- */

  function settings() { return window.Settings || null; }

  function config() {
    var s = settings();
    if (s && typeof s.backgroundConfig === 'function') {
      try { return s.backgroundConfig(); } catch (err) { /* fall through */ }
    }
    return { kind: 'wallpaper', dim: 0.25 };
  }

  function bgApi() {
    var api = window.api;
    return api && api.background ? api.background : null;
  }

  function assets() {
    var s = settings();
    return s && s.assets && typeof s.assets.get === 'function' ? s.assets : null;
  }

  /** The cache key for a clip's still: changes exactly when the clip does. */
  function stillKey(cfg) {
    return [cfg.fileUrl || '', cfg.fileName || '', cfg.clipRev || 0].join('|');
  }

  /** Everything that decides the picture, and nothing that does not. */
  function signature(cfg) {
    if (cfg.kind === 'video') return 'video|' + stillKey(cfg);
    if (cfg.kind === 'image') return 'image|' + (cfg.imageRev || 0);
    if (cfg.kind === 'builtin') return 'builtin|' + (cfg.id || '');
    return String(cfg.kind);
  }

  /* --- state -------------------------------------------------------- */

  function snapshot() {
    return {
      kind: current.kind,
      state: current.state,
      reason: current.reason,
      source: current.source ? JSON.parse(JSON.stringify(current.source)) : null
    };
  }

  function publish(next) {
    current = next;
    var body = document.body;
    if (body) {
      body.setAttribute('data-bg-kind', next.kind);
      body.setAttribute('data-bg-state', next.state);
    }
    var detail = snapshot();
    try {
      document.dispatchEvent(new CustomEvent('backdropchange', { detail: detail }));
    } catch (err) { /* a listener's problem, not the layer's */ }
  }

  /** An Error carrying the plain-words reason the state line shows. */
  function fail(reason, source) {
    var err = new Error(reason);
    err.reason = reason;
    if (source) err.source = source;
    return err;
  }

  function reasonOf(err) {
    if (err && err.reason) return err.reason;
    return (err && err.message) || 'it could not be read';
  }

  /* --- the photo layer ---------------------------------------------- */

  function revokeLater(url) {
    if (!url) return;
    // After the next paint has swapped the layer over; revoking the URL the
    // layer is still painting from would blank it for a frame.
    window.setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (err) { /* already gone */ }
    }, 1000);
  }

  function clearPhoto() {
    if (!photoEl) return;
    photoEl.removeAttribute('data-ready');
    photoEl.style.backgroundImage = '';
    revokeLater(shownUrl);
    shownUrl = null;
  }

  /** Put a blurred blob on the layer once it has decoded (no half frame). */
  function showBlob(blob, mySeq) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.src = url;
    var decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
    return decoded.catch(function () { /* paint it anyway */ }).then(function () {
      if (mySeq !== seq || !photoEl) { revokeLater(url); return false; }
      photoEl.style.backgroundImage = 'url("' + url + '")';
      photoEl.setAttribute('data-ready', '');
      var old = shownUrl;
      shownUrl = url;
      revokeLater(old);
      return true;
    });
  }

  /* --- decoding --------------------------------------------------- */

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(fail('the picture could not be encoded'));
        }, type, quality);
      } catch (err) {
        // SecurityError: a tainted canvas. Say what that means here.
        reject(fail(err && err.name === 'SecurityError'
          ? 'the browser would not let the window read the file’s pixels'
          : reasonOf(err)));
      }
    });
  }

  /**
   * A file:// URL to an ImageBitmap, through a blob so nothing is tainted.
   * Electron lets a file:// page fetch() file:// URLs (its default
   * grantFileProtocolExtraPrivileges fuse). If a build ever turns that off,
   * fetch rejects outright, and the picture is loaded through an <img>
   * instead, which a file:// page may always do; only then could the canvas
   * end up tainted, and toBlob() says so in words.
   */
  function decodeUrl(url) {
    return fetch(url).then(function (res) {
      if (!res.ok && res.status !== 0) throw fail('the file could not be read (status ' + res.status + ')');
      return res.blob().then(function (blob) {
        if (!blob || !blob.size) throw fail('the file is empty');
        return decodeBlob(blob);
      });
    }, function () {
      return decodeViaImg(url);
    });
  }

  /** The <img> route for decodeUrl (fetch refused file://). */
  function decodeViaImg(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        img.onload = img.onerror = null;
        if (typeof window.createImageBitmap !== 'function') { resolve(img); return; }
        window.createImageBitmap(img).then(resolve, function () {
          reject(fail('the file is not a picture the browser can decode'));
        });
      };
      img.onerror = function () {
        img.onload = img.onerror = null;
        reject(fail('the file is missing or cannot be read'));
      };
      img.src = url;
    });
  }

  function decodeBlob(blob) {
    if (typeof window.createImageBitmap !== 'function') {
      return Promise.reject(fail('this window cannot decode pictures'));
    }
    return window.createImageBitmap(blob).catch(function () {
      throw fail('the file is not a picture the browser can decode');
    });
  }

  function closeBitmap(bm) {
    if (bm && typeof bm.close === 'function') { try { bm.close(); } catch (err) { /* fine */ } }
  }

  /** Draw src to fill w x h, cropping the long side (CSS cover). */
  function drawCover(ctx, src, w, h) {
    var sw = src.width || src.videoWidth;
    var sh = src.height || src.videoHeight;
    var scale = Math.max(w / sw, h / sh);
    var dw = sw * scale;
    var dh = sh * scale;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /**
   * The one blur. Source -> a (W+2m) x (H+2m) canvas, unfiltered, so there
   * are m real pixels past every edge; then that canvas -> W x H through
   * ctx.filter blur, offset by -m, so the edge pixels blur into picture,
   * not into transparent black. Encoded as a JPEG blob.
   */
  function blurToBlob(src) {
    var sw = src.width;
    var sh = src.height;
    if (!sw || !sh) { closeBitmap(src); return Promise.reject(fail('the picture has no pixels')); }

    var scr = window.screen || {};
    var vw = Math.max(window.innerWidth || 0, scr.width || 0, 640);
    var vh = Math.max(window.innerHeight || 0, scr.height || 0, 360);
    var W = Math.max(64, Math.round(vw * SCALE));
    var H = Math.max(36, Math.round(vh * SCALE));
    var b = Math.round(HELM_BLUR_PX * SCALE * 10) / 10;
    var m = Math.ceil(b * OVERSCAN_SIGMAS);

    var big = canvasOf(W + 2 * m, H + 2 * m);
    var bctx = big.getContext('2d');
    bctx.imageSmoothingQuality = 'high';
    drawCover(bctx, src, big.width, big.height);
    closeBitmap(src);

    var out = canvasOf(W, H);
    var ctx = out.getContext('2d');
    var filtered = false;
    if ('filter' in ctx) {
      ctx.filter = 'blur(' + b + 'px)';
      filtered = ctx.filter !== 'none';
    }
    if (filtered) {
      ctx.drawImage(big, -m, -m);
      ctx.filter = 'none';
    } else {
      // No canvas filters: soften by squeezing to an eighth and back up.
      // Coarser than a gaussian, still no hard detail behind the glass.
      var tiny = canvasOf(Math.max(8, W / 8), Math.max(8, H / 8));
      var tctx = tiny.getContext('2d');
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(big, 0, 0, tiny.width, tiny.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tiny, 0, 0, W, H);
    }

    var corner = null;
    try { corner = ctx.getImageData(0, 0, 1, 1).data[3]; } catch (err) { corner = null; }
    lastRender = { width: W, height: H, blur: b, overscan: m, filtered: filtered, cornerAlpha: corner };
    big.width = 0;                 // drop the big bitmap now, not at GC
    return toBlob(out, OUT_TYPE, OUT_QUALITY).then(function (blob) {
      out.width = 0;
      return blob;
    });
  }

  /* --- the sources -------------------------------------------------- */

  function wallpaperSource() {
    var api = bgApi();
    if (!api || typeof api.wallpaper !== 'function') {
      return Promise.reject(fail('this window was started before the wallpaper copy existed; restart the browser',
        { type: 'wallpaper', phase: 'copy' }));
    }
    return Promise.resolve().then(function () { return api.wallpaper(); }).then(function (res) {
      if (!res || typeof res.fileUrl !== 'string' || !res.fileUrl) {
        throw fail((res && res.reason) || 'the copy did not come back', { type: 'wallpaper', phase: 'copy' });
      }
      // phase: 'copy' failures are main's (no file, not a picture); 'read'
      // ones are the copy itself refusing to load or decode here.
      var source = {
        type: 'wallpaper',
        phase: 'read',
        url: res.fileUrl,
        fileName: res.fileName || null,
        copiedAt: res.copiedAt || null
      };
      return decodeUrl(res.fileUrl).then(function (bitmap) {
        return { bitmap: bitmap, source: source };
      }, function (err) {
        throw fail(reasonOf(err), source);
      });
    });
  }

  /**
   * A built-in photo: a file:// URL in the app folder, read like the
   * wallpaper copy. When Settings cannot resolve the id (a newer build's
   * photo, a deleted file, no list) the WALLPAPER is read in its place and
   * the result carries fallbackReason, which render() publishes as state
   * 'fallback' with that picture still shown (source.shown = true).
   */
  function builtinSource(cfg) {
    var s = settings();
    var ask = s && typeof s.builtinBackground === 'function'
      ? Promise.resolve().then(function () { return s.builtinBackground(cfg.id); })
      : Promise.resolve({ ok: false, reason: 'this window was started before the built-in photos existed; restart the browser' });
    return ask.then(function (res) {
      if (res && res.ok && res.item) {
        var item = res.item;
        var source = { type: 'builtin', id: item.id, title: item.title, url: item.fileUrl, fileName: item.file };
        return decodeUrl(item.fileUrl).then(function (bitmap) {
          return { bitmap: bitmap, source: source };
        }, function (err) {
          throw fail(reasonOf(err), source);
        });
      }
      var why = (res && res.reason) || 'the built-in photo could not be found';
      return wallpaperSource().then(function (got) {
        got.source.fallbackFor = { type: 'builtin', id: cfg.id || null };
        got.source.shown = true;
        got.fallbackReason = why;
        return got;
      }, function (err) {
        throw fail(why + '; the Windows wallpaper could not be shown either (' + reasonOf(err) + ')',
          { type: 'builtin', id: cfg.id || null });
      });
    });
  }

  function imageSource() {
    var store = assets();
    var source = { type: 'image', key: IMAGE_KEY };
    if (!store) return Promise.reject(fail('the picture store is not available in this window', source));
    return store.get(IMAGE_KEY).then(function (blob) {
      if (!blob) throw fail('no image is stored yet; choose one', source);
      source.bytes = blob.size || 0;
      return decodeBlob(blob).then(function (bitmap) {
        return { bitmap: bitmap, source: source };
      }, function () {
        throw fail('the stored image could not be decoded', source);
      });
    }, function (err) {
      if (err && err.reason) throw err;
      throw fail('the picture store could not be read', source);
    });
  }

  function extOfUrl(u) {
    var p = String(u || '').split(/[?#]/)[0];
    var dot = p.lastIndexOf('.');
    return dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
  }

  function isGif(cfg) {
    return extOfUrl(cfg.fileUrl) === 'gif' || extOfUrl(cfg.fileName) === 'gif';
  }

  function mediaErrorText(error) {
    var code = error && error.code;
    if (code === 4) return 'the file is missing or in a format the browser cannot play';
    if (code === 3) return 'the clip could not be decoded';
    if (code === 2) return 'the clip could not be read from disk';
    if (code === 1) return 'loading the clip was stopped';
    return (error && error.message) || 'the clip could not be opened';
  }

  /** A drawable (bitmap or <video>) down to STILL_MAX_EDGE, as a JPEG blob. */
  function stillBlobOf(src, w, h) {
    var scale = Math.min(1, STILL_MAX_EDGE / Math.max(w, h));
    var c = canvasOf(w * scale, h * scale);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return toBlob(c, OUT_TYPE, OUT_QUALITY).then(function (blob) { c.width = 0; return blob; });
  }

  /** The first frame of a GIF: createImageBitmap on its bytes gives exactly that. */
  function captureGifStill(cfg) {
    return decodeUrl(cfg.fileUrl).then(function (bitmap) {
      return stillBlobOf(bitmap, bitmap.width, bitmap.height).then(function (blob) {
        closeBitmap(bitmap);
        return blob;
      }, function (err) { closeBitmap(bitmap); throw err; });
    });
  }

  /**
   * One frame of a clip, from an offscreen <video> that is never added to
   * the document and is torn down (src removed, load() to free the decoder)
   * the moment the frame is drawn or the attempt fails.
   */
  function captureVideoStill(cfg) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      var done = false;
      var timer = 0;

      function teardown() {
        v.onloadedmetadata = v.onseeked = v.onerror = v.onloadeddata = null;
        try { v.pause(); } catch (err) { /* fine */ }
        v.removeAttribute('src');
        try { v.load(); } catch (err) { /* fine */ }
      }
      function finish(err, blob) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        teardown();
        if (err) reject(err); else resolve(blob);
      }
      function grab() {
        if (done) return;
        var w = v.videoWidth;
        var h = v.videoHeight;
        if (!w || !h) { finish(fail('the clip has no picture in it')); return; }
        stillBlobOf(v, w, h).then(function (blob) { finish(null, blob); },
          function (err) { finish(err); });
      }

      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.onerror = function () { finish(fail(mediaErrorText(v.error))); };
      v.onloadedmetadata = function () {
        var d = v.duration;
        var t = isFinite(d) && d > 0 ? Math.min(1, d * 0.1) : 0;
        if (t > 0) {
          v.onseeked = function () {
            if (v.readyState >= 2) grab();
            else v.onloadeddata = grab;
          };
          try { v.currentTime = t; } catch (err) { v.onloadeddata = grab; }
        } else {
          if (v.readyState >= 2) grab();
          else v.onloadeddata = grab;
        }
      };
      timer = window.setTimeout(function () {
        finish(fail('the clip did not give up a frame within ' + (STILL_TIMEOUT_MS / 1000) + ' s'));
      }, STILL_TIMEOUT_MS);
      v.src = cfg.fileUrl;
    });
  }

  function videoSource(cfg) {
    var key = stillKey(cfg);
    var source = { type: 'video', url: cfg.fileUrl || null, fileName: cfg.fileName || null, stillKey: key, still: null };
    if (!cfg.fileUrl) return Promise.reject(fail('no moving picture is chosen yet; choose one', source));
    var store = assets();

    function capture() {
      var grab = isGif(cfg) ? captureGifStill(cfg) : captureVideoStill(cfg);
      return grab.then(function (blob) {
        source.still = 'captured';
        var saved = store
          ? store.put(STILL_KEY, { id: key, blob: blob, fileName: cfg.fileName || null, at: Date.now() })
            .then(function () { source.cached = true; }, function () { source.cached = false; })
          : Promise.resolve();
        return saved.then(function () { return decodeBlob(blob); });
      }).then(function (bitmap) {
        return { bitmap: bitmap, source: source };
      }, function (err) {
        throw fail(reasonOf(err), source);
      });
    }

    var cached = store ? store.get(STILL_KEY).catch(function () { return null; }) : Promise.resolve(null);
    return cached.then(function (rec) {
      if (rec && rec.id === key && rec.blob) {
        return decodeBlob(rec.blob).then(function (bitmap) {
          source.still = 'cached';
          return { bitmap: bitmap, source: source };
        }, capture);   // a cached still that will not decode is simply retaken
      }
      return capture();
    });
  }

  /* --- the render ----------------------------------------------------- */

  function render(force) {
    var cfg = config();
    var sig = signature(cfg);
    if (!force && sig === lastSig) return Promise.resolve(snapshot());
    lastSig = sig;
    var mySeq = ++seq;
    var kind = cfg.kind;

    if (kind === 'none') {
      clearPhoto();
      publish({ kind: 'none', state: 'ok', reason: null, source: { type: 'none' } });
      return Promise.resolve(snapshot());
    }

    // The old picture stays up while the new one is prepared.
    publish({ kind: kind, state: 'loading', reason: null, source: null });

    var pick = kind === 'image' ? imageSource()
      : kind === 'video' ? videoSource(cfg)
      : kind === 'builtin' ? builtinSource(cfg)
      : wallpaperSource();

    return pick.then(function (got) {
      if (mySeq !== seq) { closeBitmap(got.bitmap); return null; }
      return blurToBlob(got.bitmap).then(function (blob) {
        return showBlob(blob, mySeq);
      }).then(function (shown) {
        if (!shown || mySeq !== seq) return;
        var note = null;
        if (kind === 'wallpaper' && recopyNote) { note = recopyNote; recopyNote = null; }
        // A built-in id stood in for by the wallpaper: shown, but said.
        if (got.fallbackReason) {
          publish({ kind: kind, state: 'fallback', reason: got.fallbackReason, source: got.source });
          return;
        }
        publish({ kind: kind, state: 'ok', reason: note, source: got.source });
      }, function (err) {
        throw fail(reasonOf(err), got.source);
      });
    }).catch(function (err) {
      if (mySeq !== seq) return;
      clearPhoto();
      publish({ kind: kind, state: 'fallback', reason: reasonOf(err), source: (err && err.source) || null });
    }).then(snapshot);
  }

  /**
   * "Copy again from Windows": main re-reads TranscodedWallpaper over the old
   * copy, then the layer re-renders (the copy's URL carries a fresh ?v=, so
   * nothing is served from cache). A failed copy keeps the old picture up;
   * its reason is returned AND shown in the state line once.
   */
  function recopyWallpaper() {
    var api = bgApi();
    if (!api || typeof api.recopyWallpaper !== 'function') {
      return Promise.resolve({ ok: false, reason: 'this window was started before the wallpaper copy existed; restart the browser' });
    }
    return Promise.resolve().then(function () { return api.recopyWallpaper(); }).then(function (res) {
      var out = res && typeof res === 'object' ? res : { ok: false, reason: 'no answer from the browser' };
      if (!out.ok && out.fileUrl) recopyNote = 'Could not copy it again: ' + (out.reason || 'unknown reason');
      if (config().kind === 'wallpaper') return render(true).then(function () { return out; });
      return out;
    }, function (err) {
      return { ok: false, reason: reasonOf(err) };
    });
  }

  /* --- boot ------------------------------------------------------------ */

  /* The public surface goes up BEFORE the first render, so anything that
     hears the first backdropchange can already ask Backdrop.state(). */
  window.Backdrop = {
    state: snapshot,
    refresh: function () { return render(true); },
    recopyWallpaper: recopyWallpaper,
    stillKey: stillKey,
    // test seams
    _lastRender: function () { return lastRender ? JSON.parse(JSON.stringify(lastRender)) : null; },
    _keys: { image: IMAGE_KEY, still: STILL_KEY }
  };

  var first = config();
  publish({ kind: first.kind, state: first.kind === 'none' ? 'ok' : 'loading', reason: null, source: null });

  var s = settings();
  if (s && typeof s.on === 'function') {
    s.on(function (all, keys) {
      if (Array.isArray(keys) && keys.indexOf('newtabBackground') < 0) return;
      dropStaleStill();
      render(false);
    });
  }
  render(true);

  /* A removed clip leaves no descriptor to key a still on (settings.js drops
     fileUrl), so its cached frame goes too rather than sit in IndexedDB. */
  function dropStaleStill() {
    var cfg = config();
    var store = assets();
    if (cfg.fileUrl || !store || typeof store['delete'] !== 'function') return;
    store['delete'](STILL_KEY).catch(function () { /* not there */ });
  }
})();
