'use strict';

/*
 * reader-page.js — the reading page's own script.
 *
 * Runs inside a <webview> on file://, with no node and no preload: plain
 * browser script, no require(), no import. It is loaded from <head>, above the
 * stylesheet, because the two things it restores — text size and column width —
 * have to be on <html> before the first paint or the article visibly resizes
 * under the reader on every open.
 *
 * It owns three jobs and nothing else:
 *   1. the saved reading preferences (localStorage 'reader'),
 *   2. the top bar (back to the source page, A- / A+, narrow / wide),
 *   3. window.__applyArticle(article), which the browser chrome calls once with
 *      the parsed article. Until it lands, the page is a quiet placeholder.
 *
 * TRUST. The article body is sanitised in the chrome before it is sent here
 * (reader.js: scripts, frames, plugin objects, on* handlers and script: urls
 * are gone). This file still drops any <script> that somehow survives, because
 * the cost of being wrong is the whole guest.
 *
 * MOTION. Nothing animates on a loop: this is a page to sit still on, and
 * prefers-reduced-motion turns off even the one crossfade.
 */

(function () {
  var STORAGE_KEY = 'reader';

  var MIN_SIZE = 16;
  var MAX_SIZE = 26;
  var DEFAULT_SIZE = 19;

  var root = document.documentElement;

  /* ============================================================
     Preferences — applied before first paint, saved on every change
     ============================================================ */

  /** { size: number, width: 'narrow'|'wide'|null }, always a usable object. */
  var prefs = { size: DEFAULT_SIZE, width: null };

  function clampSize(value) {
    var n = Number(value);
    if (!isFinite(n)) return DEFAULT_SIZE;
    n = Math.round(n);
    if (n < MIN_SIZE) return MIN_SIZE;
    if (n > MAX_SIZE) return MAX_SIZE;
    return n;
  }

  /**
   * Read the saved preferences. file:// storage is not guaranteed, and the
   * value is whatever was last written there, so nothing below trusts it.
   */
  function load() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (err) { raw = null; }
    if (!raw) return;

    var saved = null;
    try { saved = JSON.parse(raw); } catch (err) { saved = null; }
    if (!saved || typeof saved !== 'object') return;

    prefs.size = clampSize(saved.size);
    prefs.width = saved.width === 'narrow' || saved.width === 'wide' ? saved.width : null;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) { /* storage blocked — the preference still holds for this page */ }
  }

  /**
   * Put the preferences on <html>: the stylesheet reads both through tokens,
   * so this is the only place either one is applied.
   */
  function apply() {
    root.style.setProperty('--body-size', prefs.size + 'px');
    if (prefs.width) root.setAttribute('data-width', prefs.width);
    else root.removeAttribute('data-width');
  }

  // Before first paint. Everything below waits for the DOM.
  load();
  apply();

  /* ============================================================
     The article
     ============================================================ */

  /** The article, if it arrived before the DOM was ready. */
  var waiting = null;
  var ready = false;

  var els = {
    placeholder: null, title: null, meta: null, content: null,
    sitename: null, back: null, smaller: null, bigger: null, width: null
  };

  /** The site a url is on, without the www. '' when the url is junk or absent. */
  function hostnameOf(url) {
    try {
      return new URL(String(url)).hostname.replace(/^www\./, '') || '';
    } catch (err) {
      return '';
    }
  }

  /** The byline / site line under the title, from whichever parts exist. */
  function metaLine(article) {
    var parts = [];
    if (article.byline) parts.push(String(article.byline).trim());
    var site = article.siteName ? String(article.siteName).trim() : hostnameOf(article.url);
    if (site && parts.indexOf(site) < 0) parts.push(site);
    return parts.join('  ·  ');
  }

  function render(article) {
    if (!article || typeof article !== 'object') return;

    var title = article.title ? String(article.title) : '';

    if (els.title) {
      els.title.textContent = title;
      els.title.hidden = !title;
    }

    if (els.meta) {
      var line = metaLine(article);
      els.meta.textContent = line;
      els.meta.hidden = !line;
    }

    if (els.sitename) {
      els.sitename.textContent = article.siteName
        ? String(article.siteName)
        : hostnameOf(article.url);
    }

    if (els.content) {
      // Parse into an inert <template> first, sweep it, and only then move it
      // into the page. A template's content belongs to a document with no
      // window: nothing in it loads, and nothing in it is checked against this
      // page's Content-Security-Policy yet. So an article's own style="..."
      // attributes (which the strict policy would refuse, one console error
      // each) and any image with a bad URL are gone before the live page sees
      // them, instead of being swept after they were already parsed live.
      var tpl = document.createElement('template');
      tpl.innerHTML = String(article.content || '');
      var frag = tpl.content;
      // Belt and braces: innerHTML never runs a <script>, but it does leave it
      // in the tree for anything later to move into a document that would.
      // The chrome already sanitised the string, but serialise-then-reparse is
      // the classic mXSS trick: sweep the parsed tree too, with the same rules.
      var unsafe = frag.querySelectorAll(
        'script, iframe, object, embed, noscript, style, link, meta, base, frame, frameset, form'
      );
      for (var i = 0; i < unsafe.length; i++) unsafe[i].remove();
      var all = frag.querySelectorAll('*');
      var urlAttrs = ['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'poster', 'data'];
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        var attrs = Array.prototype.slice.call(el.attributes);
        for (var k = 0; k < attrs.length; k++) {
          var name = attrs[k].name.toLowerCase();
          var value = String(attrs[k].value || '').replace(/[\u0000-\u0020]/g, '').toLowerCase();
          if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'style') {
            el.removeAttribute(attrs[k].name);
          } else if (urlAttrs.indexOf(name) !== -1 &&
                     (value.indexOf('javascript:') === 0 || value.indexOf('vbscript:') === 0 ||
                      value.indexOf('data:text/html') === 0)) {
            el.removeAttribute(attrs[k].name);
          }
        }
      }
      // Clean now: replace whatever was there (a second article reuses the page).
      els.content.textContent = '';
      els.content.appendChild(frag);
      els.content.classList.add('is-filled');
    }

    if (els.placeholder) els.placeholder.hidden = true;

    // The tab strip takes its label from here; the chrome needs nothing else.
    document.title = title || 'Reader';

    try { window.scrollTo(0, 0); } catch (err) { /* nothing to scroll yet */ }
  }

  /**
   * The one entry point the browser chrome calls, with the parsed article:
   * { title, byline, siteName, content, url, length }. Safe to call before the
   * DOM is ready — the article is held and painted the moment it is.
   */
  window.__applyArticle = function (article) {
    if (!ready) { waiting = article; return; }
    render(article);
  };

  /* ============================================================
     The top bar
     ============================================================ */

  /** ?src= — the page this article was lifted out of. */
  function sourceUrl() {
    var params = null;
    try { params = new URLSearchParams(window.location.search); } catch (err) { return ''; }
    var src = params.get('src');
    if (!src) return '';
    // Only a real page is worth going "back" to; anything else stays put.
    try {
      var parsed = new URL(src);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.href;
    } catch (err) {
      return '';
    }
  }

  function paintWidthButton() {
    if (!els.width) return;
    var wide = prefs.width === 'wide';
    els.width.textContent = wide ? 'Wide' : 'Narrow';
    els.width.title = wide ? 'Switch to the narrow column' : 'Switch to the wide column';
    els.width.setAttribute('aria-pressed', wide ? 'true' : 'false');
  }

  function setSize(next) {
    var size = clampSize(next);
    if (size === prefs.size) return;
    prefs.size = size;
    apply();
    save();
  }

  function wire() {
    var src = sourceUrl();
    if (els.back) {
      if (src) {
        // A real href, so the url shows on hover and the link reads as a link;
        // the click is taken over so this tab navigates rather than the page.
        els.back.href = src;
        els.back.title = src;
        els.back.addEventListener('click', function (event) {
          event.preventDefault();
          window.location.href = src;
        });
      } else {
        els.back.hidden = true;
      }
    }

    if (els.smaller) {
      els.smaller.addEventListener('click', function () { setSize(prefs.size - 1); });
    }
    if (els.bigger) {
      els.bigger.addEventListener('click', function () { setSize(prefs.size + 1); });
    }
    if (els.width) {
      els.width.addEventListener('click', function () {
        // Unset reads as the narrow end (the stylesheet's own 68ch), so the
        // first click always widens.
        prefs.width = prefs.width === 'wide' ? 'narrow' : 'wide';
        apply();
        save();
        paintWidthButton();
      });
    }
  }

  function boot() {
    els.placeholder = document.getElementById('placeholder');
    els.title = document.getElementById('title');
    els.meta = document.getElementById('meta');
    els.content = document.getElementById('content');
    els.sitename = document.getElementById('sitename');
    els.back = document.getElementById('back');
    els.smaller = document.getElementById('smaller');
    els.bigger = document.getElementById('bigger');
    els.width = document.getElementById('width');

    wire();
    paintWidthButton();

    ready = true;
    if (waiting) { render(waiting); waiting = null; }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Reachable so the preference maths can be exercised without a window.
  window.__readerHelpers = {
    clampSize: clampSize,
    hostnameOf: hostnameOf,
    metaLine: metaLine,
    prefs: prefs
  };
})();
