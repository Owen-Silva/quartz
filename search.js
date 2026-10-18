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
            ok:   { seq, ok: true, results, more, altered, cached, webUrl,
                    rich? }      rich: infobox / faq / discussions /
                                 videos / news / locations + layout,
                                 all from the SAME web request
            fail: { seq, ok: false, state, title, detail, webUrl,
                    retry, settings }
   and with the chrome (app.js):
     out  console line  quartz-search:settings {}   opens Settings > Search
   Claude's answer at the top of All is search-answer.js's (its own
   contract is at the top of that file); this file only says when.

   LAYOUT. Brave's own `mixed` layout decides where everything goes:
   `main` in order down the left column (results with the video,
   news, FAQ and discussion modules between them where Brave put
   them), `side` in the right column (the knowledge panel), `top`
   above both. Brave's order is kept; nothing is reworded. Snippets
   may be clamped to three lines, never edited.

   KEYS. / focuses the search box. j / k (or the arrow keys) move
   through results and cards; Enter opens the one that is selected.
   Escape leaves the box or clears the selection.

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
  var MAX_QUERY = 400;

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

  /** This page again with a different kind, page or query, keeping the look it is wearing now. */
  function pageUrl(nextKind, nextPage, nextQuery) {
    var p = new URLSearchParams();
    p.set('q', nextQuery != null ? nextQuery : query);
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

  function img(src, onFail) {
    var i = document.createElement('img');
    i.alt = '';
    i.loading = 'lazy';
    i.decoding = 'async';
    i.referrerPolicy = 'no-referrer';
    if (onFail) i.onerror = onFail;
    i.src = src;
    return i;
  }

  /** A favicon in its well; the host's first letter when there is none or it fails. */
  function favicon(r, cls) {
    var well = el('span', 'sr-fav' + (cls ? ' ' + cls : ''));
    var letter = el('span', 'sr-fav-letter', (r.host || '?').charAt(0).toUpperCase());
    well.appendChild(letter);
    if (r.favicon) {
      var i = img(r.favicon, function () { i.remove(); });
      i.width = 16; i.height = 16;
      i.onload = function () { well.classList.add('has-img'); };
      well.appendChild(i);
    }
    return well;
  }

  function thumb(r, cls) {
    var box = el('span', cls);
    if (r.thumb) {
      var i = img(r.thumb, function () { box.classList.add('is-empty'); i.remove(); });
      i.onload = function () { box.classList.add('has-img'); };
      box.appendChild(i);
    } else {
      box.classList.add('is-empty');
    }
    return box;
  }

  function link(href, cls) {
    var a = el('a', cls);
    a.href = href;
    return a;
  }

  /** Marks the element j / k land on, and the link Enter opens. */
  function navItem(node, primary) {
    node.classList.add('sr-nav');
    if (primary) primary.classList.add('sr-nav-link');
    return node;
  }

  /* ---------------------------------------------------------- results */

  function siteLine(r, extra) {
    var line = el('div', 'sr-site');
    line.appendChild(favicon(r));
    var words = el('span', 'sr-site-words');
    if (r.site) words.appendChild(el('span', 'sr-site-name', r.site));
    var crumb = el('span', 'sr-crumb');
    crumb.appendChild(el('span', 'sr-host', r.host || ''));
    if (r.path) crumb.appendChild(el('span', 'sr-path', ' ' + r.path));
    if (extra) crumb.appendChild(el('span', 'sr-path', ' · ' + extra));
    words.appendChild(crumb);
    line.appendChild(words);
    if (r.site) line.classList.add('has-name');
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

  function sitelinks(r) {
    var ul = el('ul', 'sr-sitelinks');
    ul.setAttribute('aria-label', 'Pages on ' + (r.host || 'this site'));
    for (var i = 0; i < r.sitelinks.length; i++) {
      var li = el('li');
      var a = link(r.sitelinks[i].url, 'sr-sitelink');
      a.title = r.sitelinks[i].url;
      a.textContent = r.sitelinks[i].title;
      li.appendChild(a);
      ul.appendChild(li);
    }
    return ul;
  }

  function cluster(r) {
    var ul = el('ul', 'sr-cluster');
    ul.setAttribute('aria-label', 'More from ' + (r.host || 'this site'));
    for (var i = 0; i < r.cluster.length; i++) {
      var c = r.cluster[i];
      var li = el('li', 'sr-cluster-item');
      var a = link(c.url, 'sr-cluster-title');
      a.title = c.url;
      appendMarked(a, c.title);
      li.appendChild(a);
      if (c.description) { var p = el('p', 'sr-cluster-desc'); appendMarked(p, c.description); li.appendChild(p); }
      ul.appendChild(li);
    }
    return ul;
  }

  function webItem(r) {
    var li = el('li', 'sr-result sr-web');
    var body = el('div', 'sr-body');
    body.appendChild(siteLine(r));
    var t = titleLink(r);
    body.appendChild(t);
    if (r.description) body.appendChild(snippet(r));
    if (Array.isArray(r.sitelinks) && r.sitelinks.length) body.appendChild(sitelinks(r));
    if (Array.isArray(r.cluster) && r.cluster.length) body.appendChild(cluster(r));
    li.appendChild(body);
    if (r.thumb) {
      var tl = link(r.url, 'sr-thumb-link sr-web-thumb');
      tl.tabIndex = -1;
      tl.setAttribute('aria-hidden', 'true');
      tl.appendChild(thumb(r, 'sr-thumb sr-thumb-sq'));
      li.appendChild(tl);
      li.classList.add('has-thumb');
    }
    return navItem(li, t);
  }

  function newsItem(r) {
    var li = el('li', 'sr-result sr-news');
    var body = el('div', 'sr-body');
    body.appendChild(siteLine(r, r.source && r.source !== r.host ? r.source : ''));
    var t = titleLink(r);
    body.appendChild(t);
    if (r.description) body.appendChild(snippet(r));
    li.appendChild(body);
    var tl = link(r.url, 'sr-thumb-link');
    tl.tabIndex = -1;
    tl.setAttribute('aria-hidden', 'true');
    tl.appendChild(thumb(r, 'sr-thumb'));
    li.appendChild(tl);
    return navItem(li, t);
  }

  function videoItem(r) {
    var li = el('li', 'sr-result sr-video');
    var tl = link(r.url, 'sr-thumb-link');
    tl.tabIndex = -1;
    tl.setAttribute('aria-hidden', 'true');
    var box = thumb(r, 'sr-thumb sr-thumb-wide');
    if (r.duration) box.appendChild(el('span', 'sr-duration', r.duration));
    tl.appendChild(box);
    li.appendChild(tl);
    var body = el('div', 'sr-body');
    var t = titleLink(r);
    body.appendChild(t);
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
    return navItem(li, t);
  }

  /* ---------------------------------------------------------- Brave's modules (All only) */

  function moduleHead(title, moreKind, moreText) {
    var head = el('div', 'sr-mod-head');
    head.appendChild(el('h2', 'sr-mod-title', title));
    if (moreKind) {
      var more = link(pageUrl(moreKind, 0), 'sr-mod-more');
      more.setAttribute('data-kind-link', moreKind);
      more.appendChild(document.createTextNode(moreText + ' '));
      more.appendChild(el('span', 'sr-glyph', ''));
      head.appendChild(more);
    }
    return head;
  }

  function stripScroller(cards) {
    var wrap = el('div', 'sr-strip-wrap');
    var strip = el('div', 'sr-strip');
    for (var i = 0; i < cards.length; i++) strip.appendChild(cards[i]);
    wrap.appendChild(strip);
    // Arrows only when the strip is wider than the column; scrolled by one card's width.
    var prev = el('button', 'sr-strip-btn sr-strip-prev', '');
    var next = el('button', 'sr-strip-btn sr-strip-next', '');
    prev.type = next.type = 'button';
    prev.tabIndex = next.tabIndex = -1;
    prev.setAttribute('aria-label', 'Scroll back');
    next.setAttribute('aria-label', 'Scroll on');
    var step = function (dir) {
      var card = strip.firstElementChild;
      var w = card ? card.getBoundingClientRect().width + 12 : 200;
      strip.scrollBy({ left: dir * w * 2, behavior: 'auto' });
    };
    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    var sync = function () {
      var max = strip.scrollWidth - strip.clientWidth;
      wrap.classList.toggle('can-prev', strip.scrollLeft > 4);
      wrap.classList.toggle('can-next', strip.scrollLeft < max - 4);
    };
    strip.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    setTimeout(sync, 0);
    wrap.appendChild(prev);
    wrap.appendChild(next);
    return wrap;
  }

  function videoCard(r) {
    var a = link(r.url, 'sr-card sr-vcard');
    a.title = plain(r.title);
    var box = thumb(r, 'sr-thumb sr-card-thumb');
    if (r.duration) box.appendChild(el('span', 'sr-duration', r.duration));
    a.appendChild(box);
    var t = el('span', 'sr-card-title');
    appendMarked(t, r.title);
    a.appendChild(t);
    var meta = el('span', 'sr-card-meta');
    meta.appendChild(favicon(r, 'sr-fav-s'));
    meta.appendChild(el('span', 'sr-card-meta-words', [r.creator || r.publisher || r.host, r.age].filter(Boolean).join(' · ')));
    a.appendChild(meta);
    return navItem(a, a);
  }

  function newsCard(r) {
    var a = link(r.url, 'sr-card sr-ncard');
    a.title = plain(r.title);
    a.appendChild(thumb(r, 'sr-thumb sr-card-thumb'));
    var meta = el('span', 'sr-card-meta');
    meta.appendChild(favicon(r, 'sr-fav-s'));
    meta.appendChild(el('span', 'sr-card-meta-words', r.source || r.host));
    a.appendChild(meta);
    var t = el('span', 'sr-card-title');
    appendMarked(t, r.title);
    a.appendChild(t);
    var foot = el('span', 'sr-card-foot');
    if (r.breaking) foot.appendChild(el('span', 'sr-badge', 'Breaking'));
    if (r.age) foot.appendChild(el('span', 'sr-card-age', r.age));
    a.appendChild(foot);
    return navItem(a, a);
  }

  function videosModule(list) {
    var box = el('section', 'sr-mod sr-mod-videos');
    box.appendChild(moduleHead('Videos', 'videos', 'More videos'));
    box.appendChild(stripScroller(list.map(videoCard)));
    return box;
  }

  function newsModule(list) {
    var box = el('section', 'sr-mod sr-mod-news');
    box.appendChild(moduleHead('News', 'news', 'More news'));
    box.appendChild(stripScroller(list.map(newsCard)));
    return box;
  }

  function faqModule(list) {
    var box = el('section', 'sr-mod sr-mod-faq');
    box.appendChild(moduleHead('Questions and answers'));
    var ul = el('div', 'sr-faq');
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var d = el('details', 'sr-faq-item');
      var s = el('summary', 'sr-faq-q');
      appendMarked(s, f.question);
      s.appendChild(el('span', 'sr-faq-chev', ''));
      d.appendChild(s);
      var ans = el('div', 'sr-faq-a');
      var p = el('p', 'sr-faq-text');
      appendMarked(p, f.answer);
      ans.appendChild(p);
      var src = link(f.url, 'sr-faq-src');
      src.title = f.url;
      src.appendChild(favicon(f, 'sr-fav-s'));
      var words = el('span', 'sr-faq-src-words');
      words.appendChild(el('span', 'sr-faq-src-title', plain(f.title) || f.host));
      words.appendChild(el('span', 'sr-host', f.host));
      src.appendChild(words);
      ans.appendChild(src);
      d.appendChild(ans);
      ul.appendChild(navItem(d, s));
    }
    box.appendChild(ul);
    return box;
  }

  function discussionsModule(list) {
    var box = el('section', 'sr-mod sr-mod-discussions');
    box.appendChild(moduleHead('Discussions'));
    var ol = el('ol', 'sr-disc');
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var li = el('li', 'sr-disc-item');
      var top = el('div', 'sr-site');
      top.appendChild(favicon(d));
      var words = el('span', 'sr-site-words');
      words.appendChild(el('span', 'sr-site-name', d.forum || d.host));
      var crumb = el('span', 'sr-crumb');
      crumb.appendChild(el('span', 'sr-host', d.host));
      words.appendChild(crumb);
      top.appendChild(words);
      top.classList.add('has-name');
      li.appendChild(top);
      var t = titleLink(d);
      li.appendChild(t);
      var bits = [];
      if (d.answers != null) bits.push(d.answers + (d.answers === 1 ? ' answer' : ' answers'));
      if (d.score) bits.push(d.score + ' points');
      if (d.age) bits.push(d.age);
      if (bits.length) li.appendChild(el('div', 'sr-disc-meta', bits.join(' · ')));
      var said = d.topComment || d.question || d.description;
      if (said) { var p = el('p', 'sr-desc sr-disc-said'); appendMarked(p, said); li.appendChild(p); }
      ol.appendChild(navItem(li, t));
    }
    box.appendChild(ol);
    return box;
  }

  function stars(value, best) {
    var out = el('span', 'sr-stars');
    var b = best || 5;
    out.appendChild(el('span', 'sr-stars-n', String(Math.round(value * 10) / 10)));
    out.appendChild(el('span', 'sr-stars-of', '/' + b));
    return out;
  }

  function locationsModule(list) {
    var box = el('section', 'sr-mod sr-mod-locations');
    box.appendChild(moduleHead('Places'));
    var ol = el('ol', 'sr-places');
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      var li = el('li', 'sr-place');
      var t = link(l.url, 'sr-title sr-place-title');
      t.title = l.url;
      t.textContent = l.title;
      li.appendChild(t);
      var meta = el('div', 'sr-place-meta');
      if (l.rating != null) meta.appendChild(stars(l.rating, l.best));
      if (l.reviews != null) meta.appendChild(el('span', null, l.reviews.toLocaleString('en-US') + ' reviews'));
      if (l.price) meta.appendChild(el('span', null, l.price));
      if (meta.childNodes.length) li.appendChild(meta);
      if (l.address) li.appendChild(el('div', 'sr-place-addr', l.address));
      if (l.phone) li.appendChild(el('div', 'sr-place-addr', l.phone));
      ol.appendChild(navItem(li, t));
    }
    box.appendChild(ol);
    return box;
  }

  /** Brave's knowledge panel: an entity, in Brave's words, with its facts and its profiles. */
  function infoboxModule(ib) {
    var box = el('section', 'sr-mod sr-ib');
    box.setAttribute('aria-label', 'About ' + ib.title);
    var head = el('div', 'sr-ib-head');
    if (ib.thumb) head.appendChild(thumb({ thumb: ib.thumb }, 'sr-thumb sr-ib-img'));
    var words = el('div', 'sr-ib-words');
    var title = ib.url ? link(ib.url, 'sr-ib-title') : el('span', 'sr-ib-title');
    title.textContent = ib.title;
    if (ib.url) title.title = ib.url;
    words.appendChild(title);
    var kindLine = [ib.category, ib.label && ib.label !== ib.category ? ib.label : ''].filter(Boolean).join(' · ');
    if (kindLine || ib.description) words.appendChild(el('div', 'sr-ib-kind', kindLine || ib.description));
    head.appendChild(words);
    box.appendChild(head);
    var about = ib.longDesc || (kindLine ? ib.description : '');
    if (about) {
      var p = el('p', 'sr-ib-about', about);
      box.appendChild(p);
      if (about.length > 360) {
        var more = el('button', 'sr-ib-more', 'More');
        more.type = 'button';
        more.addEventListener('click', function () {
          var open = box.classList.toggle('is-open');
          more.textContent = open ? 'Less' : 'More';
        });
        box.appendChild(more);
      }
    }
    if (ib.url || ib.provider) {
      var src = el('div', 'sr-ib-src');
      var a = link(ib.url || ib.provider.url, 'sr-ib-src-link');
      a.textContent = (ib.provider && ib.provider.name) || ib.host || (ib.provider && ib.provider.host) || 'Source';
      src.appendChild(document.createTextNode('Source: '));
      src.appendChild(a);
      box.appendChild(src);
    }
    if (ib.attributes && ib.attributes.length) {
      var dl = el('dl', 'sr-ib-facts');
      for (var i = 0; i < ib.attributes.length; i++) {
        var row = el('div', 'sr-ib-fact');
        row.appendChild(el('dt', null, ib.attributes[i][0]));
        row.appendChild(el('dd', null, ib.attributes[i][1]));
        dl.appendChild(row);
      }
      box.appendChild(dl);
    }
    var chips = [];
    if (ib.website) chips.push({ name: 'Website', url: ib.website, host: '' });
    for (var k = 0; k < (ib.profiles || []).length; k++) chips.push(ib.profiles[k]);
    if (chips.length) {
      var row2 = el('div', 'sr-ib-profiles');
      for (var j = 0; j < chips.length; j++) {
        var c = link(chips[j].url, 'sr-chip');
        c.title = chips[j].url;
        c.textContent = chips[j].name;
        row2.appendChild(c);
      }
      box.appendChild(row2);
    }
    return navItem(box, title.tagName === 'A' ? title : null);
  }

  function makeModule(t, rich) {
    if (t === 'videos' && rich.videos) return videosModule(rich.videos);
    if (t === 'news' && rich.news) return newsModule(rich.news);
    if (t === 'faq' && rich.faq) return faqModule(rich.faq);
    if (t === 'discussions' && rich.discussions) return discussionsModule(rich.discussions);
    if (t === 'locations' && rich.locations) return locationsModule(rich.locations);
    if (t === 'infobox' && rich.infobox) return infoboxModule(rich.infobox);
    return null;
  }

  /* ---------------------------------------------------------- the frame */

  function paintFrame() {
    $('sr-query').textContent = query || 'Search';
    $('sr-query').title = query;
    $('sr-q').value = query;
    document.title = query ? query + ' – Search' : 'Search';
    document.body.setAttribute('data-kind', kind);
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
    $('sr-top').textContent = '';
    $('sr-top').hidden = true;
    $('sr-side').textContent = '';
    $('sr-side').hidden = true;
    document.body.removeAttribute('data-state');
    document.body.classList.remove('has-side');
    selected = -1;
  }

  function skeletonItem(withThumb) {
    var li = el('li', 'sr-result sr-skeleton' + (withThumb ? ' has-thumb' : ''));
    var body = el('div', 'sr-body');
    var site = el('div', 'sr-sk-siterow');
    site.appendChild(el('span', 'sr-sk sr-sk-fav'));
    site.appendChild(el('span', 'sr-sk sr-sk-site'));
    body.appendChild(site);
    body.appendChild(el('span', 'sr-sk sr-sk-title'));
    body.appendChild(el('span', 'sr-sk sr-sk-line'));
    body.appendChild(el('span', 'sr-sk sr-sk-line sr-sk-short'));
    li.appendChild(body);
    if (withThumb) li.appendChild(el('span', 'sr-sk sr-sk-thumb'));
    return li;
  }

  function paintLoading() {
    clearBody();
    document.body.setAttribute('data-state', 'loading');
    setMeta('Searching Brave…');
    var list = $('sr-results');
    list.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 5; i++) list.appendChild(skeletonItem(kind !== 'web'));
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
    var rich = kind === 'web' && a.rich && typeof a.rich === 'object' ? a.rich : null;
    if (!results.length && !rich) {
      paintProblem({
        state: 'empty',
        title: 'Brave found nothing for “' + query + '”' + (kind === 'web' ? '' : ' in ' + KIND_NAME[kind]),
        detail: page > 0 ? 'There are no more results past this page.' : 'Try other words, another tab, or the plain web search.',
        retry: false, settings: false, webUrl: a.webUrl
      });
      return;
    }
    var make = kind === 'news' ? newsItem : kind === 'videos' ? videoItem : webItem;
    var layout = rich && rich.layout ? rich.layout : null;
    var mainOrder = layout && Array.isArray(layout.main) ? layout.main : results.map(function (_, i) { return { t: 'web', i: i }; });
    var placed = 0;
    var put = function (ref, into, asLi) {
      if (!ref) return;
      if (ref.t === 'web') {
        var r = results[ref.i];
        if (!r) return;
        into.appendChild(make(r));
        placed++;
        return;
      }
      var mod = rich ? makeModule(ref.t, rich) : null;
      if (!mod) return;
      mod.setAttribute('data-module', ref.t);
      if (asLi) {
        var li = el('li', 'sr-module');
        li.setAttribute('data-module', ref.t);
        li.appendChild(mod);
        into.appendChild(li);
      } else {
        into.appendChild(mod);
      }
    };
    for (var i = 0; i < mainOrder.length; i++) put(mainOrder[i], list, true);
    // Anything the layout missed still shows, in Brave's order.
    if (placed < results.length && !layout) for (var j = placed; j < results.length; j++) list.appendChild(make(results[j]));
    if (layout && Array.isArray(layout.top) && layout.top.length) {
      for (var t = 0; t < layout.top.length; t++) put(layout.top[t], $('sr-top'), false);
      $('sr-top').hidden = !$('sr-top').childNodes.length;
    }
    if (layout && Array.isArray(layout.side) && layout.side.length) {
      var side = $('sr-side');
      for (var s = 0; s < layout.side.length; s++) {
        var ref = layout.side[s];
        if (ref.t === 'web') { var rr = results[ref.i]; if (rr) side.appendChild(webItem(rr)); continue; }
        put(ref, side, false);
      }
      side.hidden = !side.childNodes.length;
      document.body.classList.toggle('has-side', !side.hidden);
    }
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
      paintProblem({ state: 'no-query', title: 'Nothing to search for', detail: 'Type a search in the box above, or in the address bar.', retry: false, settings: false });
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
    var mods = document.querySelectorAll('#sr-results > .sr-module');
    var side = document.querySelectorAll('#sr-side > [data-module]');
    var mapMod = function (list) { var out = []; for (var i = 0; i < list.length; i++) out.push(list[i].getAttribute('data-module')); return out; };
    return {
      phase: phase, query: query, kind: kind, page: page, seq: seq,
      results: document.querySelectorAll('#sr-results .sr-result:not(.sr-skeleton)').length,
      modules: mapMod(mods),
      side: mapMod(side),
      sitelinks: document.querySelectorAll('.sr-sitelink').length,
      selected: selected,
      problem: problem && !problem.hidden ? problem.getAttribute('data-problem') : null,
      problemTitle: problem && !problem.hidden ? $('sr-problem-title').textContent : '',
      problemDetail: problem && !problem.hidden ? $('sr-problem-detail').textContent : '',
      meta: $('sr-meta').textContent,
      cached: !!(last && last.cached),
      theme: document.documentElement.getAttribute('data-theme')
    };
  };

  /* ---------------------------------------------------------- keys */

  var selected = -1;

  function navItems() {
    var all = document.querySelectorAll('#sr-col .sr-nav, #sr-side .sr-nav');
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].getClientRects().length) out.push(all[i]);
    return out;
  }

  function primaryOf(item) {
    if (!item) return null;
    if (item.classList.contains('sr-nav-link')) return item;
    return item.querySelector('.sr-nav-link');
  }

  function select(index) {
    var items = navItems();
    if (!items.length) return;
    var prev = document.querySelector('.sr-nav.is-sel');
    if (prev) prev.classList.remove('is-sel');
    selected = Math.max(0, Math.min(items.length - 1, index));
    var item = items[selected];
    item.classList.add('is-sel');
    var target = primaryOf(item);
    if (target) { try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); } }
    item.scrollIntoView({ block: 'nearest' });
  }

  /** The first item whose top is below the header: where j starts from a fresh scroll. */
  function firstInView() {
    var items = navItems();
    var headH = document.querySelector('.sr-head').getBoundingClientRect().height;
    for (var i = 0; i < items.length; i++) if (items[i].getBoundingClientRect().bottom > headH + 8) return i;
    return 0;
  }

  function move(dir) {
    var items = navItems();
    if (!items.length) return;
    var cur = document.querySelector('.sr-nav.is-sel');
    var at = cur ? items.indexOf(cur) : -1;
    if (at < 0) select(dir > 0 ? firstInView() : Math.max(0, firstInView() - 1));
    else select(at + dir);
  }

  function clearSelection() {
    var cur = document.querySelector('.sr-nav.is-sel');
    if (cur) cur.classList.remove('is-sel');
    selected = -1;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function typing(t) {
    if (!t) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (typing(t)) return;
    var k = e.key;
    if (k === '/') { e.preventDefault(); var q = $('sr-q'); q.focus(); q.select(); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (k === 'Escape') { clearSelection(); return; }
    if (k === 'Enter') {
      var cur = document.querySelector('.sr-nav.is-sel');
      var target = primaryOf(cur);
      // A focused link or summary opens / toggles itself; only an unfocused selection needs a push.
      if (target && document.activeElement !== target) { e.preventDefault(); target.click(); }
    }
  }

  /** Clicking or tabbing into a result makes it the selection, so j / k carry on from there. */
  function onFocusIn(e) {
    var item = e.target && e.target.closest ? e.target.closest('.sr-nav') : null;
    var prev = document.querySelector('.sr-nav.is-sel');
    if (prev && prev !== item) prev.classList.remove('is-sel');
    if (!item) { selected = -1; return; }
    item.classList.add('is-sel');
    selected = navItems().indexOf(item);
  }

  /* ---------------------------------------------------------- the search box */

  function wireBox() {
    var q = $('sr-q');
    var clear = $('sr-clear');
    var sync = function () { document.body.classList.toggle('has-typed', !!q.value); };
    q.addEventListener('input', sync);
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        var text = String(q.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
        if (!text) return;
        if (text === query && phase !== 'problem') { q.blur(); return; }
        // A new search is a new page: pagehide stops any answer still streaming.
        document.body.classList.add('is-leaving');
        window.location.href = pageUrl(kind, 0, text);
      } else if (e.key === 'Escape') {
        q.value = query;
        sync();
        q.blur();
      }
    });
    clear.addEventListener('click', function () { q.value = ''; sync(); q.focus(); });
    sync();
  }

  /* Tabs and the pager are page loads; the old page dims at once so the switch reads as instant. */
  function wireLeaving() {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.sr-tab, #sr-prev, #sr-next, .sr-mod-more') : null;
      if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (a.classList.contains('sr-tab')) {
        var on = document.querySelector('.sr-tab.is-on');
        if (on) on.classList.remove('is-on');
        a.classList.add('is-on');
      }
      document.body.classList.add('is-leaving');
    });
    window.addEventListener('pageshow', function () { document.body.classList.remove('is-leaving'); });
  }

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
    var more = document.querySelectorAll('[data-kind-link]');
    for (var m = 0; m < more.length; m++) more[m].href = pageUrl(more[m].getAttribute('data-kind-link'), 0);
    if ($('sr-pager').hidden) return;
    if (!$('sr-prev').hidden && page > 0) $('sr-prev').href = pageUrl(kind, page - 1);
    if (!$('sr-next').hidden) $('sr-next').href = pageUrl(kind, page + 1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    paintFrame();
    watchTheme();
    wireBox();
    wireLeaving();
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    ask();
    // Claude's answer: All, first page, a real query. Elsewhere the panel stays out of the way.
    var A = window.QuartzAnswer;
    if (A) {
      if (kind === 'web' && page === 0 && query) A.begin(query);
      else A.hide();
    }
  });
})();
