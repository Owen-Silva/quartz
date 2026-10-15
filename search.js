/* ============================================================
   search.js — Quartz's own search results page (search.html).

   A bundled, preload-less file:// guest. The question is in the
   address and the answer comes from main; this file never sees the
   Brave key and never fetches anything itself.

     search.html?q=<text>&kind=web|news|videos&page=0..9
                &theme=&palette=&hue=      (read by newtab-theme.js)

   The contract with main (bravesearch.js):
     out  console line  quartz-search:query {"q","kind","offset","seq"}
     in   window.__applySearch(answer)
            ok:   { seq, ok: true, results, more, altered, cached, webUrl }
            fail: { seq, ok: false, state, title, detail, webUrl,
                    retry, settings }
   and with the chrome (app.js):
     out  console line  quartz-search:settings {}   opens Settings > Search

   No silent failures: every way this can go wrong ends on the
   problem panel with what went wrong, in Brave's own words where
   there are any, and the plain web search (search.brave.com, no key
   needed) offered as a link. Nothing here redirects on its own. If
   no answer arrives at all (an older Quartz, or this file opened in
   another browser) the page says so after NO_ANSWER_MS.

   Results are built with createElement + textContent. Brave's own
   <strong> highlighting is the one piece of markup kept: the
   snippet is parsed in an inert <template> (no scripts run, nothing
   loads) and only <strong>/<b> survive, as <strong>; every other
   node becomes its text.
   ============================================================ */

(function () {
  'use strict';

  var NO_ANSWER_MS = 15000;
  var KINDS = ['web', 'news', 'videos'];
  var KIND_NAME = { web: 'All', news: 'News', videos: 'Videos' };
  var MAX_PAGE = 9;

  var params = new URLSearchParams(window.location.search);
  var query = String(params.get('q') || '').replace(/\s+/g, ' ').trim();
  var kind = KINDS.indexOf(params.get('kind')) >= 0 ? params.get('kind') : 'web';
  var page = Math.max(0, Math.min(MAX_PAGE, parseInt(params.get('page') || '0', 10) || 0));

  var seq = 0;
  var timer = null;
  var phase = 'idle';      // 'idle' | 'loading' | 'ok' | 'problem'
  var last = null;         // the answer on screen, for the test seam

  /* ---------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Brave's snippet text -> nodes, keeping only its <strong> highlights. */
  function appendMarked(parent, text) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(text == null ? '' : text);   // inert: nothing runs, nothing loads
    var nodes = tpl.content.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3) parent.appendChild(document.createTextNode(n.nodeValue));
      else if (n.nodeType === 1) {
        if (n.tagName === 'STRONG' || n.tagName === 'B') parent.appendChild(el('strong', null, n.textContent));
        else if (n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') parent.appendChild(document.createTextNode(n.textContent));
      }
    }
  }

  /** The plain-text form of a snippet (for the title attribute and the tab title). */
  function plain(text) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(text == null ? '' : text);
    return tpl.content.textContent || '';
  }

  /** This page again with a different kind or page, keeping the look it is wearing now. */
  function pageUrl(nextKind, nextPage) {
    var p = new URLSearchParams();
    p.set('q', query);
    if (nextKind !== 'web') p.set('kind', nextKind);
    if (nextPage > 0) p.set('page', String(nextPage));
    var root = document.documentElement;
    var theme = root.getAttribute('data-theme');
    if (theme === 'light' || theme === 'dark') p.set('theme', theme);
    var palette = root.getAttribute('data-palette');
    if (palette) p.set('palette', palette);
    var hue = typeof window.__accentHue === 'function' ? window.__accentHue() : null;
    if (typeof hue === 'number' && isFinite(hue)) p.set('hue', String(hue));
    return window.location.pathname + '?' + p.toString();
  }

  function webSearchUrl() {
    var base = kind === 'news' ? 'https://search.brave.com/news?q='
      : kind === 'videos' ? 'https://search.brave.com/videos?q='
        : 'https://search.brave.com/search?q=';
    return base + encodeURIComponent(query);
  }

  function formatViews(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B views';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M views';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K views';
    return n + (n === 1 ? ' view' : ' views');
  }

  /** A favicon in its well; the host's first letter when there is none or it fails. */
  function favicon(r) {
    var well = el('span', 'sr-fav');
    var letter = el('span', 'sr-fav-letter', (r.host || '?').charAt(0).toUpperCase());
    well.appendChild(letter);
    if (r.favicon) {
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.width = 16; img.height = 16;
      img.onload = function () { well.classList.add('has-img'); };
      img.onerror = function () { img.remove(); };
      img.src = r.favicon;
      well.appendChild(img);
    }
    return well;
  }

  function thumb(r, cls) {
    var box = el('span', cls);
    if (r.thumb) {
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () { box.classList.add('is-empty'); img.remove(); };
      img.src = r.thumb;
      box.appendChild(img);
    } else {
      box.classList.add('is-empty');
    }
    return box;
  }

  /* ---------------------------------------------------------- results */

  function siteLine(r, extra) {
    var line = el('div', 'sr-site');
    line.appendChild(favicon(r));
    var words = el('span', 'sr-site-words');
    words.appendChild(el('span', 'sr-host', r.host || ''));
    if (r.path) words.appendChild(el('span', 'sr-path', ' ' + r.path));
    if (extra) words.appendChild(el('span', 'sr-path', ' · ' + extra));
    line.appendChild(words);
    return line;
  }

  function titleLink(r) {
    var a = el('a', 'sr-title');
    a.href = r.url;
    a.title = r.url;
    appendMarked(a, r.title);
    return a;
  }

  function snippet(r) {
    var p = el('p', 'sr-desc');
    if (r.age) p.appendChild(el('span', 'sr-age', r.age + ' — '));
    appendMarked(p, r.description);
    return p;
  }

  function webItem(r) {
    var li = el('li', 'sr-result sr-web');
    li.appendChild(siteLine(r));
    li.appendChild(titleLink(r));
    if (r.description) li.appendChild(snippet(r));
    return li;
  }

  function newsItem(r) {
    var li = el('li', 'sr-result sr-news');
    var body = el('div', 'sr-body');
    body.appendChild(siteLine(r, r.source && r.source !== r.host ? r.source : ''));
    body.appendChild(titleLink(r));
    if (r.description) body.appendChild(snippet(r));
    li.appendChild(body);
    var link = el('a', 'sr-thumb-link');
    link.href = r.url;
    link.tabIndex = -1;
    link.setAttribute('aria-hidden', 'true');
    link.appendChild(thumb(r, 'sr-thumb'));
    li.appendChild(link);
    return li;
  }

  function videoItem(r) {
    var li = el('li', 'sr-result sr-video');
    var link = el('a', 'sr-thumb-link');
    link.href = r.url;
    link.tabIndex = -1;
    link.setAttribute('aria-hidden', 'true');
    var box = thumb(r, 'sr-thumb sr-thumb-wide');
    if (r.duration) box.appendChild(el('span', 'sr-duration', r.duration));
    link.appendChild(box);
    li.appendChild(link);
    var body = el('div', 'sr-body');
    body.appendChild(titleLink(r));
    var by = [r.creator, r.publisher && r.publisher !== r.creator ? r.publisher : '', formatViews(r.views), r.age]
      .filter(function (s) { return !!s; }).join(' · ');
    // A video's path ("› watch") says nothing: host, then who and when.
    body.appendChild(siteLine({ host: r.host, favicon: r.favicon, path: '' }, by));
    if (r.description) {
      var p = el('p', 'sr-desc');
      appendMarked(p, r.description);
      body.appendChild(p);
    }
    li.appendChild(body);
    return li;
  }

  /* ---------------------------------------------------------- the frame */

  function paintFrame() {
    $('sr-query').textContent = query || 'Search';
    $('sr-query').title = query;
    document.title = query ? query + ' – Search' : 'Search';
    var tabs = document.querySelectorAll('.sr-tab');
    for (var i = 0; i < tabs.length; i++) {
      var k = tabs[i].getAttribute('data-kind');
      tabs[i].href = pageUrl(k, 0);
      if (k === kind) { tabs[i].classList.add('is-on'); tabs[i].setAttribute('aria-current', 'page'); }
      else { tabs[i].classList.remove('is-on'); tabs[i].removeAttribute('aria-current'); }
    }
    $('sr-plain').href = webSearchUrl();
  }

  function setMeta(text) { $('sr-meta').textContent = text || ''; }

  function clearBody() {
    $('sr-results').textContent = '';
    $('sr-results').removeAttribute('aria-busy');
    $('sr-problem').hidden = true;
    $('sr-pager').hidden = true;
    $('sr-altered').hidden = true;
    document.body.removeAttribute('data-state');
  }

  function paintLoading() {
    clearBody();
    document.body.setAttribute('data-state', 'loading');
    setMeta('Searching Brave…');
    var list = $('sr-results');
    list.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 4; i++) {
      var li = el('li', 'sr-result sr-skeleton');
      li.appendChild(el('span', 'sr-sk sr-sk-site'));
      li.appendChild(el('span', 'sr-sk sr-sk-title'));
      li.appendChild(el('span', 'sr-sk sr-sk-line'));
      li.appendChild(el('span', 'sr-sk sr-sk-line sr-sk-short'));
      list.appendChild(li);
    }
  }

  /**
   * The problem panel. `p` is { state, title, detail, retry, settings, webUrl }.
   * The plain web search is always offered; Settings and Try again only when
   * they can help.
   */
  function paintProblem(p) {
    clearBody();
    phase = 'problem';
    document.body.setAttribute('data-state', 'problem');
    var box = $('sr-problem');
    box.setAttribute('data-problem', p.state || 'unknown');
    $('sr-problem-title').textContent = p.title || 'This search did not work';
    $('sr-problem-detail').textContent = p.detail || '';
    var actions = $('sr-actions');
    actions.textContent = '';
    if (p.settings) {
      var set = el('button', 'sr-btn sr-btn-primary sr-act-settings', 'Open Settings › Search');
      set.type = 'button';
      set.addEventListener('click', function () { console.log('quartz-search:settings {}'); });
      actions.appendChild(set);
    }
    if (p.retry) {
      var again = el('button', 'sr-btn' + (p.settings ? '' : ' sr-btn-primary') + ' sr-act-retry', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () { ask(); });
      actions.appendChild(again);
    }
    var web = el('a', 'sr-btn sr-act-web', 'Search on search.brave.com instead');
    web.href = p.webUrl || webSearchUrl();
    actions.appendChild(web);
    box.hidden = false;
    setMeta('');
  }

  function paintResults(a) {
    clearBody();
    phase = 'ok';
    document.body.setAttribute('data-state', 'ok');
    var list = $('sr-results');
    var results = Array.isArray(a.results) ? a.results : [];
    if (a.altered && a.altered !== query) {
      var alt = $('sr-altered');
      alt.textContent = '';
      alt.appendChild(document.createTextNode('Brave searched for '));
      alt.appendChild(el('strong', null, a.altered));
      alt.appendChild(document.createTextNode(' instead.'));
      alt.hidden = false;
    }
    if (!results.length) {
      paintProblem({
        state: 'empty',
        title: 'Brave found nothing for “' + query + '”' + (kind === 'web' ? '' : ' in ' + KIND_NAME[kind]),
        detail: page > 0 ? 'There are no more results past this page.' : 'Try other words, another tab, or the plain web search.',
        retry: false, settings: false, webUrl: a.webUrl
      });
      return;
    }
    var make = kind === 'news' ? newsItem : kind === 'videos' ? videoItem : webItem;
    for (var i = 0; i < results.length; i++) list.appendChild(make(results[i]));
    var bits = [(page > 0 ? 'Page ' + (page + 1) + ' · ' : '') + results.length + (results.length === 1 ? ' result' : ' results')];
    if (a.cached) bits.push('from memory, no search spent');
    setMeta(bits.join(' · '));
    var prev = page > 0, next = !!a.more && page < MAX_PAGE;
    if (prev || next) {
      $('sr-prev').hidden = !prev;
      $('sr-next').hidden = !next;
      if (prev) $('sr-prev').href = pageUrl(kind, page - 1);
      if (next) $('sr-next').href = pageUrl(kind, page + 1);
      $('sr-page').textContent = 'Page ' + (page + 1);
      $('sr-pager').hidden = false;
    }
  }

  /* ---------------------------------------------------------- the ask */

  function noAnswer() {
    timer = null;
    paintProblem({
      state: 'no-answer',
      title: 'Quartz did not answer this search',
      detail: 'No reply from the browser in ' + (NO_ANSWER_MS / 1000) + ' seconds. This page only works inside Quartz; restarting Quartz picks up a newer build.',
      retry: true, settings: false
    });
  }

  function ask() {
    if (!query) {
      paintProblem({ state: 'no-query', title: 'Nothing to search for', detail: 'Type a search in the address bar above.', retry: false, settings: false });
      return;
    }
    seq += 1;
    phase = 'loading';
    last = null;
    paintLoading();
    if (timer) clearTimeout(timer);
    timer = setTimeout(noAnswer, NO_ANSWER_MS);
    console.log('quartz-search:query ' + JSON.stringify({ q: query, kind: kind, offset: page, seq: seq }));
  }

  /** main's answer. Ignored unless it answers the newest question. */
  window.__applySearch = function (answer) {
    if (!answer || typeof answer !== 'object' || answer.seq !== seq) return false;
    if (timer) { clearTimeout(timer); timer = null; }
    last = answer;
    if (answer.ok) paintResults(answer);
    else paintProblem(answer);
    return true;
  };

  /** For the harness: what the page is showing, in plain values. */
  window.__searchState = function () {
    var problem = $('sr-problem');
    return {
      phase: phase, query: query, kind: kind, page: page, seq: seq,
      results: document.querySelectorAll('#sr-results .sr-result:not(.sr-skeleton)').length,
      problem: problem && !problem.hidden ? problem.getAttribute('data-problem') : null,
      problemTitle: problem && !problem.hidden ? $('sr-problem-title').textContent : '',
      problemDetail: problem && !problem.hidden ? $('sr-problem-detail').textContent : '',
      meta: $('sr-meta').textContent,
      cached: !!(last && last.cached),
      theme: document.documentElement.getAttribute('data-theme')
    };
  };

  /* A custom accent is painted per theme (newtab-theme.js): when the chrome
     flips data-theme, paint the same hue over the new base colour. */
  function watchTheme() {
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function () {
      var hue = typeof window.__accentHue === 'function' ? window.__accentHue() : null;
      if (typeof hue === 'number' && isFinite(hue) && typeof window.__applyAccent === 'function') {
        try { window.__applyAccent(hue); } catch (err) { /* keep the authored accent */ }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    /* The tab and pager links carry the look in their URL (pageUrl). They are built when the
       page renders, so a flip after that would leave them pointing at the old look: rebuild them. */
    new MutationObserver(relinkLook)
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
  }

  function relinkLook() {
    var tabs = document.querySelectorAll('.sr-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].href = pageUrl(tabs[i].getAttribute('data-kind'), 0);
    if ($('sr-pager').hidden) return;
    if (!$('sr-prev').hidden && page > 0) $('sr-prev').href = pageUrl(kind, page - 1);
    if (!$('sr-next').hidden) $('sr-next').href = pageUrl(kind, page + 1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    paintFrame();
    watchTheme();
    ask();
  });
})();
