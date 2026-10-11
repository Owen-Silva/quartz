/*
 * keywords.js — search keywords for the address bar.
 *
 * WHAT IT IS. Type a short keyword, a space, then a search, and the search
 * goes to that one site instead of the default engine:
 *
 *   gh helm      -> GitHub's search for "helm"
 *   yt lofi      -> YouTube's results for "lofi"
 *   rh nvda      -> Robinhood's NVDA page (the ticker is upper-cased)
 *   ddg foo      -> one DuckDuckGo search, whatever the default engine is
 *
 * THE CONTRACT. window.Keywords = { match(text), list(), ... }.
 *
 *   match(text) -> null | { key, name, query, url }
 *
 * app.js's toNavigationUrl() asks match() after its URL / domain / localhost
 * checks and before the plain search fallback; history.js's omnibox dropdown
 * asks it too, to label its default row "Search <name> for <query>". Both
 * depend on that exact name and shape, so neither may change.
 *
 * THE RULES match() keeps:
 *   - The first whitespace-separated token must equal a keyword, compared
 *     without case, AND something non-blank must follow it. A keyword alone
 *     ("yt") is not a match: it falls through to whatever the address bar
 *     did before (a search for "yt").
 *   - Every %s in the template becomes encodeURIComponent(query). A keyword
 *     marked upper:true upper-cases the query first (tickers: rh nvda -> NVDA).
 *   - A keyword never shadows an address. A key may only be letters, digits,
 *     - and _ (no dot, colon or slash), and match() needs a space after it, so
 *     "gh.com", "localhost:3000" and "https://x" can never start with one.
 *     app.js asks only after its own address checks have already passed on
 *     the text, so this is belt and braces.
 *   - An invalid row (bad key, duplicate key, a template that is not http(s)
 *     or has no %s) never matches. Settings stores it with disabled:true and
 *     prints why beside the row — check() below is the one place both the
 *     editor and match() get that verdict from, so they cannot disagree.
 *
 * WHERE THE LIST LIVES. Settings' 'keywords' key: null means "never touched"
 * and reads as DEFAULTS below (the same convention as the new tab chips);
 * an array is the user's own list. With settings.js missing, the defaults
 * still work, so the address bar never loses keywords to a load failure.
 *
 * Classic script, no require/import: index.html loads it right after
 * settings.js. Nothing here touches the DOM.
 */
(function () {
  'use strict';

  /* The built-in list. Keys are short and none is a word a search would
     plausibly start with. Each template was checked against the site's own
     search URL format:
       Google       /search?q=
       DuckDuckGo   /?q=
       Brave        search.brave.com/search?q=
       GitHub       /search?q=   (all types; GitHub picks the best tab)
       YouTube      /results?search_query=
       Wikipedia    Special:Search?search=  (jumps straight to an exact title)
       Google Maps  /maps/search/<query>
       Robinhood    /stocks/<TICKER>
       npm          npmjs.com/search?q=
       MDN          /en-US/search?q=
       Reddit       /search/?q=                                              */
  var DEFAULTS = [
    { key: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { key: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { key: 'b', name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
    { key: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
    { key: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
    { key: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' },
    { key: 'maps', name: 'Google Maps', url: 'https://www.google.com/maps/search/%s' },
    { key: 'rh', name: 'Robinhood', url: 'https://robinhood.com/stocks/%s', upper: true },
    { key: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q=%s' },
    { key: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q=%s' },
    { key: 'r', name: 'Reddit', url: 'https://www.reddit.com/search/?q=%s' }
  ];

  /* A key may only be these characters: nothing that could make the text
     read as an address (no . : / @ ?) and nothing a query would contain. */
  var KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i;

  /* Words searches routinely start with. A key from this list would quietly
     turn "how to tie a tie" into a search on some other site, so the editor
     refuses it with that reason rather than letting it eat normal searches. */
  var COMMON_WORDS = [
    'a', 'an', 'the', 'i', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on',
    'at', 'for', 'and', 'or', 'not', 'no', 'yes', 'it', 'my', 'me', 'we',
    'you', 'how', 'what', 'why', 'who', 'when', 'where', 'which', 'can',
    'do', 'does', 'did', 'best', 'top', 'new', 'free', 'buy', 'get', 'make',
    'with', 'without', 'vs', 'near', 'this', 'that', 'should', 'will',
    'if', 'by', 'from', 'about', 'all', 'one', 'cheap'
  ];

  function copyDefaults() {
    return DEFAULTS.map(function (k) {
      var out = { key: k.key, name: k.name, url: k.url };
      if (k.upper) out.upper = true;
      return out;
    });
  }

  /** The stored list, or the defaults when it was never touched (or settings is absent). */
  function stored() {
    var settings = window.Settings;
    if (!settings || typeof settings.get !== 'function') return copyDefaults();
    var raw;
    try { raw = settings.get('keywords'); } catch (err) { return copyDefaults(); }
    if (!Array.isArray(raw)) return copyDefaults();
    return raw;
  }

  /** One row as plain strings, whatever the file held. */
  function clean(entry) {
    var e = entry && typeof entry === 'object' ? entry : {};
    var out = {
      key: String(e.key == null ? '' : e.key).trim(),
      name: String(e.name == null ? '' : e.name).trim(),
      url: String(e.url == null ? '' : e.url).trim()
    };
    if (e.upper === true) out.upper = true;
    return out;
  }

  /**
   * Why one row cannot be used, in the words the editor prints beside it, or
   * '' when it is fine. `seen` holds the lower-cased keys of the rows above,
   * so the first of two equal keys keeps working and the second says why not.
   */
  function reasonFor(entry, seen) {
    var key = entry.key;
    if (!key) return 'Needs a keyword.';
    if (/\s/.test(key)) return 'The keyword must be one word, with no spaces.';
    if (!KEY_RE.test(key)) {
      return 'The keyword can only use letters, digits, - and _, so it never looks like an address.';
    }
    var lower = key.toLowerCase();
    if (COMMON_WORDS.indexOf(lower) >= 0) {
      return '“' + key + '” is a common word, so it would catch ordinary searches.';
    }
    if (seen[lower]) return 'The keyword “' + key + '” is already used by a row above.';

    var url = entry.url;
    if (!url) return 'Needs an address with %s where the search goes.';
    if (!/^https?:\/\//i.test(url)) return 'The address must start with http:// or https://.';
    if (url.indexOf('%s') < 0) return 'The address needs %s where the search goes.';
    try {
      // A sample query, so a template broken anywhere but at %s fails here.
      var probe = new URL(url.split('%s').join('test'));
      if (probe.protocol !== 'http:' && probe.protocol !== 'https:') {
        return 'The address must start with http:// or https://.';
      }
    } catch (err) {
      return 'That address is not a valid web address.';
    }
    return '';
  }

  /**
   * The whole list with a verdict on every row:
   *   [{ key, name, url, upper?, ok, reason }]
   * `ok:false` rows are what settings stores as disabled and match() skips.
   */
  function check(list) {
    var seen = {};
    var source = Array.isArray(list) ? list : [];
    return source.map(function (raw) {
      var entry = clean(raw);
      var reason = reasonFor(entry, seen);
      if (!reason) seen[entry.key.toLowerCase()] = true;
      entry.ok = !reason;
      entry.reason = reason;
      return entry;
    });
  }

  /** The list the address bar is using right now, each row with its verdict. */
  function list() {
    return check(stored());
  }

  function hostOf(url) {
    try { return new URL(url.split('%s').join('x')).hostname.replace(/^www\./, ''); } catch (err) { return ''; }
  }

  /**
   * The keyword a typed line starts with, or null. See the header for the
   * rules; the return shape is a contract with app.js and history.js.
   */
  function match(text) {
    var trimmed = String(text == null ? '' : text).trim();
    var gap = trimmed.search(/\s/);
    if (gap <= 0) return null;                       // one token: no query
    var token = trimmed.slice(0, gap);
    var query = trimmed.slice(gap).trim();
    if (!query) return null;
    if (/[.:\/@?#]/.test(token)) return null;        // never an address
    var lower = token.toLowerCase();

    var rows = list();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row.ok || row.key.toLowerCase() !== lower) continue;
      var q = row.upper ? query.toUpperCase() : query;
      return {
        key: row.key,
        name: row.name || hostOf(row.url) || row.key,
        query: q,
        url: row.url.split('%s').join(encodeURIComponent(q))
      };
    }
    return null;
  }

  window.Keywords = {
    match: match,
    list: list,
    /* For the settings editor: the built-in list (a fresh copy) and the
       verdict on any list, so it validates with exactly match()'s rules. */
    defaults: copyDefaults,
    check: check
  };
})();
