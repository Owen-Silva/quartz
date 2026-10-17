// bravesearch.js — Quartz's own search results page, fed by the Brave Search API (main process).
//
// search.html is a bundled, preload-less file:// guest, exactly like the new tab page and the
// Files page. It never sees the key. It asks over ONE console line and is answered by
// executeJavaScript, the same pattern stocks.js uses for the Markets tile:
//
//   in    quartz-search:query {"q":"lunar eclipse","kind":"web"|"news"|"videos","offset":0,"seq":1}
//   out   window.__applySearch(answer)
//
//   answer, ok:   { seq, q, kind, offset, ok: true, results: [...], more, altered, cached, webUrl, rich? }
//                 rich (web only, and only when Brave sent any): infobox, faq, discussions, videos,
//                 news, locations, and layout { main, top, side } from Brave's `mixed` (shapeLayout).
//                 All of it comes in the same single web request: no extra parameter, no extra spend.
//   answer, fail: { seq, q, kind, offset, ok: false, state, title, detail, webUrl, retry, settings }
//
// `state` is one of: 'no-key' | 'bad-key' | 'rate-limited' | 'quota' | 'plan' | 'offline' |
// 'server' | 'bad-answer' | 'bad-request'. Every one of them carries a plain-English `title` and
// a `detail` that says what Brave (or the network) actually answered, and `webUrl` is the plain
// web search (search.brave.com, no key needed) the page offers as the way out. Nothing here ever
// falls back on its own: the page shows the reason and the user picks.
//
// Only a guest whose URL is OUR search.html is heard (checked per message, as stocks.js does,
// because a guest is created before it has navigated): a web page printing the same line is
// ignored, so no site can spend the user's searches.
//
// THE KEY. Pasted in Settings > Search, kept in <userData>/brave-search.json (the same place and
// shape as the Finnhub key in stocks.json: the profile folder, never the repo). It only ever goes
// one way: describe() answers `hasKey` and a mask, there is no channel that returns it, and it is
// never logged. It leaves this process only as the X-Subscription-Token header to Brave.
//
// BRAVE'S TERMS (api-dashboard.search.brave.com/terms-of-service):
//   §3(b)(i)  no storing or caching of Search Results "other than transient storage" needed to
//             run the app. So: an in-memory cache of at most CACHE_MAX answers for CACHE_TTL_MS,
//             so Back / Forward / reload / a theme change do not spend a second search. Never
//             written to disk, dropped when the key changes, gone when Quartz quits.
//   §4(d)     attribution, when shown, is "POWERED BY BRAVE" in a conspicuous place: the page
//             carries it in its header and footer. The results are shown as Brave sent them, in
//             Brave's order, with Brave's own highlighting, never reworded.
//   §3(b)(v)  no getting round rate limits: one request per MIN_GAP_MS from this process
//             (the free plan allows 1 per second), queued, never retried on a loop.
//
// TESTS: create({ apiBase }) points it at a mock server. main.js passes QUARTZ_BRAVE_API only to
// a --test-profile instance, so a live Quartz always talks to Brave itself.
'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.search.brave.com/res/v1';
const ENDPOINTS = { web: '/web/search', news: '/news/search', videos: '/videos/search' };
const KINDS = Object.keys(ENDPOINTS);
const LINE_PREFIX = 'quartz-search:query ';
const PAGE_FILE = 'search.html';
const STORE_FILE = 'brave-search.json';
const SIGNUP_URL = 'https://brave.com/search/api/';

const COUNT = 20;              // results per page (web allows 20; news/videos up to 50)
const MAX_OFFSET = 9;          // Brave's own ceiling on `offset` (pages, not results)
const MAX_QUERY = 400;         // Brave: at most 400 characters
const MIN_GAP_MS = 1100;       // free plan: 1 request per second; a little air on top
const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 30;

/* ---------------------------------------------------------------- pure helpers */

/** Last four characters behind bullets (stocks.js's rule): a short key is all bullets. */
function maskKey(key) {
  const s = String(key == null ? '' : key);
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return '••••' + s.slice(-4);
}

/** A key as pasted, or '' when it cannot be one (whitespace inside, control chars, absurd length). */
function cleanKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 200 || /[\s\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

/** The plain web search for the same question: Brave's own site, which needs no key. */
function webSearchUrl(q, kind) {
  const base = kind === 'news' ? 'https://search.brave.com/news?q='
    : kind === 'videos' ? 'https://search.brave.com/videos?q='
      : 'https://search.brave.com/search?q=';
  return base + encodeURIComponent(String(q == null ? '' : q));
}

/**
 * One console line -> { q, kind, offset, seq }, or null for anything that is not a well-formed
 * query. The whole of the validation: unknown kinds, empty or overlong queries and junk payloads
 * all come back null rather than half-honoured.
 */
function parseGuestLine(line) {
  if (typeof line !== 'string' || line.indexOf(LINE_PREFIX) !== 0) return null;
  let msg;
  try { msg = JSON.parse(line.slice(LINE_PREFIX.length)); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const q = typeof msg.q === 'string' ? msg.q.replace(/\s+/g, ' ').trim() : '';
  if (!q || q.length > MAX_QUERY) return null;
  const kind = KINDS.indexOf(msg.kind) >= 0 ? msg.kind : (msg.kind == null ? 'web' : null);
  if (!kind) return null;
  let offset = Number(msg.offset == null ? 0 : msg.offset);
  if (!Number.isInteger(offset) || offset < 0) return null;
  offset = Math.min(offset, MAX_OFFSET);
  const seq = Number.isFinite(Number(msg.seq)) ? Number(msg.seq) : 0;
  return { q, kind, offset, seq };
}

/** http(s) only, as a normalised href, or ''. A result never links anywhere else. */
function webHref(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

/** Images (favicons, thumbnails) must be https. The page's CSP also allows file:, but only for
 *  its own Brave logo (assets/brave/); a result never gets a file: or any other image URL. */
function imageHref(value) {
  const href = webHref(value);
  return href.indexOf('https:') === 0 ? href : '';
}

function str(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function hostOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * The fields the page draws, and nothing else, from one Brave result. Titles and descriptions
 * keep Brave's <strong> highlighting as TEXT here; the page turns only <strong> into markup and
 * treats everything else as plain text. A result without a usable http(s) link is dropped.
 */
function shapeResult(kind, r) {
  if (!r || typeof r !== 'object') return null;
  const url = webHref(r.url);
  if (!url) return null;
  const meta = r.meta_url && typeof r.meta_url === 'object' ? r.meta_url : {};
  const out = {
    title: str(r.title, 300) || hostOf(url),
    url,
    host: str(meta.hostname, 120).replace(/^www\./, '') || hostOf(url),
    path: str(meta.path, 200),
    description: str(r.description, 1200),
    age: str(r.age, 60),
    favicon: imageHref(meta.favicon),
  };
  if (kind === 'news' || kind === 'videos') {
    out.thumb = imageHref(r.thumbnail && r.thumbnail.src);
  }
  if (kind === 'news') {
    out.source = str((r.profile && r.profile.name) || (r.meta_url && r.meta_url.netloc), 120);
    out.breaking = r.breaking === true;
  }
  if (kind === 'videos') {
    const v = r.video && typeof r.video === 'object' ? r.video : {};
    out.duration = str(v.duration, 20);
    out.creator = str(v.creator, 120);
    out.publisher = str(v.publisher, 120);
    out.views = Number.isFinite(Number(v.views)) && v.views !== null && v.views !== '' ? Number(v.views) : null;
  }
  return out;
}

/* --- the rest of ONE web answer -------------------------------------------------------------
   A web search already carries more than ten blue links: an infobox, FAQ, discussions, video and
   news strips, places, and per-result sitelinks (deep_results.buttons) and clusters. Brave sends
   them in the SAME response, with no extra parameter and no extra request (result_filter, when
   absent, means "all result types where data is available and the plan has them"), so drawing
   them spends nothing. `mixed` is Brave's own layout of the page (main / top / side, in order);
   the page follows it, so Brave's order is kept for the modules too. Every string is Brave's,
   trimmed only for length; every link is http(s) and every image https, as for the results. */

const RICH_MAX = { videos: 8, news: 8, faq: 6, discussions: 6, locations: 6, sitelinks: 6, cluster: 4, attributes: 12, profiles: 8 };

function arr(value, max) { return Array.isArray(value) ? value.slice(0, max) : []; }

/** A Brave `profile` (a site or a social account) -> { name, url, host }, or null without a link. */
function shapeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const url = webHref(p.url);
  if (!url) return null;
  return { name: str(p.long_name || p.name, 120) || hostOf(url), url, host: hostOf(url) };
}

/** deep_results.buttons -> sitelinks [{ title, url }]: Brave's own titles, http(s) links only. */
function shapeSitelinks(r) {
  const deep = r && r.deep_results && typeof r.deep_results === 'object' ? r.deep_results : {};
  const out = [];
  for (const b of arr(deep.buttons, RICH_MAX.sitelinks * 2)) {
    const url = b && webHref(b.url);
    const title = b && str(b.title, 120);
    if (url && title) out.push({ title, url });
    if (out.length >= RICH_MAX.sitelinks) break;
  }
  return out;
}

/** result.cluster -> more results from the same site [{ title, url, description }]. */
function shapeCluster(r) {
  const out = [];
  for (const c of arr(r && r.cluster, RICH_MAX.cluster * 2)) {
    const url = c && webHref(c.url);
    if (!url) continue;
    out.push({ title: str(c.title, 300) || hostOf(url), url, description: str(c.description, 400) });
    if (out.length >= RICH_MAX.cluster) break;
  }
  return out;
}

/** A web result, plus what only web results have. Extra keys appear only when Brave sent them. */
function shapeWebResult(r) {
  const out = shapeResult('web', r);
  if (!out) return null;
  const site = str(r.profile && r.profile.name, 120);
  if (site && site.toLowerCase() !== out.host.toLowerCase()) out.site = site;
  const thumb = imageHref(r.thumbnail && r.thumbnail.src);
  if (thumb) out.thumb = thumb;
  const sitelinks = shapeSitelinks(r);
  if (sitelinks.length) out.sitelinks = sitelinks;
  const cluster = shapeCluster(r);
  if (cluster.length) out.cluster = cluster;
  return out;
}

/** infobox.results[0] -> the knowledge panel, or null. Brave's words; attributes as [label, value]. */
function shapeInfobox(block) {
  const list = block && Array.isArray(block.results) ? block.results : [];
  const ib = list.find((x) => x && typeof x === 'object');
  if (!ib) return null;
  const url = webHref(ib.url);
  const title = str(ib.title, 200);
  if (!title) return null;
  const attributes = [];
  for (const a of arr(ib.attributes, RICH_MAX.attributes * 2)) {
    if (!Array.isArray(a)) continue;
    const k = str(a[0], 80), v = str(a[1] == null ? '' : String(a[1]), 300);
    if (k && v) attributes.push([k, v]);
    if (attributes.length >= RICH_MAX.attributes) break;
  }
  const profiles = [];
  for (const p of arr(ib.profiles, RICH_MAX.profiles * 2)) {
    const shaped = shapeProfile(p);
    if (shaped) profiles.push(shaped);
    if (profiles.length >= RICH_MAX.profiles) break;
  }
  const provider = shapeProfile(ib.profile) || (Array.isArray(ib.providers) ? shapeProfile(ib.providers.find(Boolean)) : null);
  return {
    title,
    url,
    host: url ? hostOf(url) : '',
    label: str(ib.label, 120),
    category: str(ib.category, 120),
    description: str(ib.description, 600),
    longDesc: str(ib.long_desc, 2400),
    thumb: imageHref(ib.thumbnail && (ib.thumbnail.src || ib.thumbnail.original)),
    website: webHref(ib.website_url),
    attributes,
    profiles,
    provider,
  };
}

function shapeFaq(block) {
  const out = [];
  for (const f of arr(block && block.results, RICH_MAX.faq * 2)) {
    if (!f || typeof f !== 'object') continue;
    const url = webHref(f.url);
    const question = str(f.question, 300), answer = str(f.answer, 1200);
    if (!url || !question || !answer) continue;
    const meta = f.meta_url && typeof f.meta_url === 'object' ? f.meta_url : {};
    out.push({ question, answer, title: str(f.title, 300), url, host: str(meta.hostname, 120).replace(/^www\./, '') || hostOf(url), favicon: imageHref(meta.favicon) });
    if (out.length >= RICH_MAX.faq) break;
  }
  return out;
}

function shapeDiscussions(block) {
  const out = [];
  for (const d of arr(block && block.results, RICH_MAX.discussions * 2)) {
    const base = shapeResult('web', d);
    if (!base) continue;
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    const answers = Number(data.num_answers);
    base.forum = str(data.forum_name, 120);
    base.answers = Number.isFinite(answers) && data.num_answers !== null && data.num_answers !== '' ? answers : null;
    base.score = str(data.score == null ? '' : String(data.score), 40);
    base.question = str(data.question, 600);
    base.topComment = str(data.top_comment, 600);
    out.push(base);
    if (out.length >= RICH_MAX.discussions) break;
  }
  return out;
}

function shapeList(kind, block, max) {
  const out = [];
  for (const r of arr(block && block.results, max * 2)) {
    const shaped = shapeResult(kind, r);
    if (shaped) out.push(shaped);
    if (out.length >= max) break;
  }
  return out;
}

function shapeLocations(block) {
  const out = [];
  for (const l of arr(block && block.results, RICH_MAX.locations * 2)) {
    if (!l || typeof l !== 'object') continue;
    const url = webHref(l.url) || webHref(l.provider_url);
    const title = str(l.title, 200);
    if (!url || !title) continue;
    const addr = l.postal_address && typeof l.postal_address === 'object' ? l.postal_address : {};
    const rating = l.rating && typeof l.rating === 'object' ? l.rating : {};
    const value = Number(rating.ratingValue), best = Number(rating.bestRating), count = Number(rating.reviewCount);
    out.push({
      title, url, host: hostOf(url),
      address: str(addr.displayAddress || [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(', '), 240),
      rating: Number.isFinite(value) && value > 0 ? value : null,
      best: Number.isFinite(best) && best > 0 ? best : null,
      reviews: Number.isFinite(count) && count > 0 ? count : null,
      phone: str(l.contact && l.contact.telephone, 40),
      price: str(l.price_range, 20),
      thumb: imageHref(l.thumbnail && l.thumbnail.src),
      description: str(l.description, 400),
    });
    if (out.length >= RICH_MAX.locations) break;
  }
  return out;
}

const MODULES = ['infobox', 'faq', 'discussions', 'videos', 'news', 'locations'];

/**
 * Brave's `mixed` -> { main, top, side }: lists of { t: 'web', i } (i = the index in OUR results,
 * after unusable rows were dropped) and { t: <module> }. A module appears once, where Brave first
 * put it. Web results Brave's layout does not mention are appended in Brave's order, and so are
 * modules with data that the layout leaves out, so nothing Brave sent is lost.
 */
function shapeLayout(mixed, rawToShaped, shapedCount, present) {
  const m = mixed && typeof mixed === 'object' ? mixed : {};
  const seenWeb = new Set(), seenMod = new Set();
  const lane = (refs) => {
    const out = [];
    for (const ref of arr(refs, 200)) {
      if (!ref || typeof ref !== 'object') continue;
      const t = ref.type === 'web' ? 'web' : (MODULES.indexOf(ref.type) >= 0 ? ref.type : null);
      if (!t) continue;
      if (t === 'web') {
        const idx = Number(ref.index);
        const targets = ref.all === true ? Array.from(rawToShaped.keys()) : (Number.isInteger(idx) ? [idx] : []);
        for (const raw of targets) {
          const i = rawToShaped.get(raw);
          if (i == null || seenWeb.has(i)) continue;
          seenWeb.add(i); out.push({ t: 'web', i });
        }
      } else if (present[t] && !seenMod.has(t)) {
        seenMod.add(t); out.push({ t });
      }
    }
    return out;
  };
  const top = lane(m.top), main = lane(m.main), side = lane(m.side);
  for (let i = 0; i < shapedCount; i++) if (!seenWeb.has(i)) main.push({ t: 'web', i });
  let at = Math.min(main.length, 3);
  for (const t of MODULES) {
    if (!present[t] || seenMod.has(t)) continue;
    // Not placed by Brave: the panel goes to the side, a strip after the first results.
    if (t === 'infobox') side.push({ t });
    else { main.splice(at, 0, { t }); at++; }
  }
  return { top, main, side };
}

/** A whole 200 answer -> { results, more, altered } or null when it is not Brave's shape. */
function shapeAnswer(kind, json) {
  if (!json || typeof json !== 'object') return null;
  let list;
  if (kind === 'web') {
    // A web search that matched nothing has no `web` block at all: that is zero results, not
    // a broken answer. Anything without even a `query` block is not Brave's shape.
    if (!json.query && !json.web) return null;
    list = json.web && Array.isArray(json.web.results) ? json.web.results : [];
  } else {
    if (!Array.isArray(json.results)) return null;
    list = json.results;
  }
  const results = [];
  const rawToShaped = new Map();
  for (let i = 0; i < list.length; i++) {
    const shaped = kind === 'web' ? shapeWebResult(list[i]) : shapeResult(kind, list[i]);
    if (shaped) { rawToShaped.set(i, results.length); results.push(shaped); }
  }
  const query = json.query && typeof json.query === 'object' ? json.query : {};
  const out = {
    results,
    more: query.more_results_available === true,
    altered: str(query.altered, MAX_QUERY) || '',
  };
  if (kind === 'web') {
    const rich = {
      infobox: shapeInfobox(json.infobox),
      faq: shapeFaq(json.faq),
      discussions: shapeDiscussions(json.discussions),
      videos: shapeList('videos', json.videos, RICH_MAX.videos),
      news: shapeList('news', json.news, RICH_MAX.news),
      locations: shapeLocations(json.locations),
    };
    const present = {};
    let any = false;
    for (const t of MODULES) {
      present[t] = Array.isArray(rich[t]) ? rich[t].length > 0 : !!rich[t];
      if (present[t]) any = true; else delete rich[t];
    }
    // Only an answer with something beyond the list carries `rich`: a plain one is unchanged.
    if (any) {
      rich.layout = shapeLayout(json.mixed, rawToShaped, results.length, present);
      out.rich = rich;
    }
  }
  return out;
}

/** A header's value whatever the headers object is (fetch Headers, or a plain object in tests). */
function header(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
  } catch { /* fall through */ }
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return String(headers[k]);
  return '';
}

/**
 * Brave's rate headers, "per-second, per-month" pairs:
 *   X-RateLimit-Limit: 1, 2000   X-RateLimit-Remaining: 1, 1987   X-RateLimit-Reset: 1, 1419704
 * -> { limit, remaining, resetSec } for the MONTH, or null when the headers are not there (a plan
 * that reports differently simply shows no usage line, rather than a wrong one).
 */
function monthUsage(headers) {
  const parts = (name) => header(headers, name).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  const lim = parts('X-RateLimit-Limit');
  const rem = parts('X-RateLimit-Remaining');
  const rst = parts('X-RateLimit-Reset');
  if (lim.length < 2 || rem.length < 2) return null;
  return { limit: lim[lim.length - 1], remaining: rem[rem.length - 1], resetSec: rst.length >= 2 ? rst[rst.length - 1] : null };
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/** "in 3 days" / "in 5 hours" / "in 12 minutes", from seconds. */
function inTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec >= 86400) return 'in ' + plural(Math.round(sec / 86400), 'day');
  if (sec >= 3600) return 'in ' + plural(Math.round(sec / 3600), 'hour');
  return 'in ' + plural(Math.max(1, Math.round(sec / 60)), 'minute');
}

/**
 * A non-200 answer -> { state, title, detail, retry, settings }. `code` and `detail` are Brave's
 * own words from its ErrorResponse ({ type: 'ErrorResponse', error: { status, code, detail, meta } }),
 * quoted so the page says what Brave said, not a guess.
 */
function classifyStatus(status, json, headers, keyMask) {
  const err = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : {};
  const code = str(err.code, 80);
  const said = str(err.detail, 300);
  const meta = err.meta && typeof err.meta === 'object' ? err.meta : {};
  const brave = 'Brave answered ' + status + (code ? ' ' + code : '') + (said ? ': ' + said : '') + (/[.!?]$/.test(said) ? '' : '.');
  const tokenProblem = status === 401 || status === 403 || /TOKEN|SUBSCRIPTION|AUTH/i.test(code);

  if (tokenProblem) {
    return {
      state: 'bad-key',
      title: 'Brave rejected the saved key',
      detail: brave + ' The key in Settings > Search' + (keyMask ? ' (' + keyMask + ')' : '') +
        ' is wrong, revoked or for another product. Paste the "Search" key from your Brave API dashboard, then press Try again.',
      retry: true, settings: true,
    };
  }
  if (status === 429) {
    const usage = monthUsage(headers);
    const quotaLimit = Number(meta.quota_limit), quotaNow = Number(meta.quota_current);
    const quota = /QUOTA/i.test(code)
      || (Number.isFinite(quotaLimit) && Number.isFinite(quotaNow) && quotaLimit > 0 && quotaNow >= quotaLimit)
      || (usage && usage.remaining <= 0);
    if (quota) {
      const n = (x) => Number(x).toLocaleString('en-US');
      const used = Number.isFinite(quotaLimit) && quotaLimit > 0
        ? ' ' + n(Number.isFinite(quotaNow) ? quotaNow : quotaLimit) + ' of ' + n(quotaLimit) + ' searches used this month.' : '';
      const reset = usage && usage.resetSec != null ? ' The allowance resets ' + inTime(usage.resetSec) + '.' : '';
      return {
        state: 'quota',
        title: 'This month\'s Brave searches are used up',
        detail: brave + used + reset + ' Until then, use the plain web search below, or raise the limit in your Brave API dashboard.',
        retry: false, settings: true,
      };
    }
    const perSec = Number(meta.rate_limit);
    return {
      state: 'rate-limited',
      title: 'Too many searches at once',
      detail: brave + ' The plan allows ' + (Number.isFinite(perSec) && perSec > 0 ? plural(perSec, 'search') : 'a set number of searches') +
        ' per second. Wait a moment and try again.',
      retry: true, settings: false,
    };
  }
  if (status === 402) {
    return {
      state: 'plan',
      title: 'Brave wants payment for this key',
      detail: brave + ' The plan behind the key has no credit left or needs a payment method. Check the Brave API dashboard.',
      retry: false, settings: true,
    };
  }
  if (status === 400 || status === 422) {
    return {
      state: 'bad-request',
      title: 'Brave could not run this search',
      detail: brave,
      retry: false, settings: false,
    };
  }
  if (status >= 500) {
    return {
      state: 'server',
      title: 'Brave Search had a problem',
      detail: brave + ' That is on Brave\'s side. Try again in a moment.',
      retry: true, settings: false,
    };
  }
  return {
    state: 'server',
    title: 'Brave Search answered unexpectedly',
    detail: brave,
    retry: true, settings: false,
  };
}

/** A connection that dropped under the request (reset / closed pipe), as opposed to refused,
 * unresolvable, timed out or aborted: the one failure worth a second try (on a fresh connection). */
function isDroppedConnection(err) {
  if (!err || err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  const cause = err.cause;
  const code = String((cause && cause.code) || err.code || '');
  const text = String(err.message || '') + ' ' + String((cause && cause.message) || '');
  return /ECONNRESET|EPIPE|UND_ERR_SOCKET|CONNECTION_RESET|other side closed/i.test(code + ' ' + text);
}

/**
 * A request that never got an answer -> the 'offline' state, with the actual reason: no network,
 * a name that does not resolve, a refused connection, or Brave too slow. Covers Node fetch's
 * errors (err.cause.code) and Chromium's net::ERR_* strings, so either transport reads right.
 */
function classifyNetworkError(err) {
  const name = err && err.name;
  const cause = err && err.cause;
  const code = String((cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || (err && err.code) || '');
  const text = String((err && err.message) || '') + ' ' + String((cause && cause.message) || '');
  let why;
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT|ETIMEDOUT|TIMED_OUT/i.test(code + text)) {
    why = 'Brave did not answer within ' + (TIMEOUT_MS / 1000) + ' seconds';
  } else if (/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/i.test(code + text)) {
    why = 'the name api.search.brave.com could not be looked up, so this computer looks offline (' + (code || 'DNS') + ')';
  } else if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(code + text)) {
    why = 'the connection was refused (' + (code || 'refused') + ')';
  } else if (/INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH|NETWORK_CHANGED/i.test(code + text)) {
    why = 'there is no network connection (' + (code || 'offline') + ')';
  } else if (/ECONNRESET|EPIPE|SOCKET/i.test(code + text)) {
    why = 'the connection dropped (' + (code || 'reset') + ')';
  } else if (/CERT|SSL|TLS/i.test(code + text)) {
    why = 'the secure connection failed (' + (code || 'TLS') + ')';
  } else {
    why = 'the request failed (' + (code || str(text, 120) || 'unknown error') + ')';
  }
  return {
    state: 'offline',
    title: 'Can\'t reach Brave Search',
    detail: 'Quartz could not reach Brave: ' + why + '. Check the connection and try again.',
    retry: true, settings: false,
  };
}

/* ---------------------------------------------------------------- the module */

function create(deps) {
  const d = deps || {};
  const electronApp = d.app || null;
  const fetchImpl = typeof d.fetch === 'function' ? d.fetch : (typeof fetch === 'function' ? fetch : null);
  const apiBase = String(d.apiBase || API_BASE).replace(/\/+$/, '');
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const isBundledPage = typeof d.isBundledPage === 'function' ? d.isBundledPage : () => false;
  const log = typeof d.log === 'function' ? d.log : (...a) => console.log('[brave-search]', ...a);
  const storeFile = d.storePath || (() => {
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return path.join(electronApp.getPath('userData'), STORE_FILE); } catch { return ''; }
  });

  let key = '';
  let loaded = false;
  let last = null;          // { state, ok, title, at }: the newest real answer, for Settings
  let usage = null;         // { limit, remaining, resetSec, at } from the newest rate headers
  let nextSlot = 0;         // the rate gate: the earliest moment the next request may leave
  const cache = new Map();  // key -> { at, answer }   (in memory only; see the header)
  const inFlight = new Map();

  function load() {
    if (loaded) return;
    loaded = true;
    const file = storeFile();
    if (!file) return;
    let json = null;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (json && typeof json.key === 'string') key = cleanKey(json.key);
  }

  function save() {
    const file = storeFile();
    if (!file) return false;
    try {
      if (key) fs.writeFileSync(file, JSON.stringify({ key }, null, 2), { encoding: 'utf8', mode: 0o600 });
      else fs.rmSync(file, { force: true });
      return true;
    } catch (err) {
      log('key file write failed:', (err && err.code) || 'unknown');   // never the key itself
      return false;
    }
  }

  function describe() {
    load();
    return {
      hasKey: !!key,
      keyMask: maskKey(key),
      last: last ? Object.assign({}, last) : null,
      usage: usage ? Object.assign({}, usage) : null,
      signupUrl: SIGNUP_URL,
      cacheMinutes: CACHE_TTL_MS / 60000,
    };
  }

  function setKey(raw) {
    load();
    const next = cleanKey(raw);
    const typed = String(raw == null ? '' : raw).trim();
    if (typed && !next) return Object.assign(describe(), { error: 'That does not look like a key: it has spaces or odd characters in it.' });
    if (next === key) return describe();
    key = next;
    last = null;
    usage = null;
    cache.clear();
    if (!save()) return Object.assign(describe(), { error: 'The key could not be written to the profile folder.' });
    return describe();
  }

  /** The gate: resolves when this request may leave. One request per MIN_GAP_MS, in order. */
  async function waitTurn() {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + MIN_GAP_MS;
    if (at > t) await sleep(at - t);
  }

  function fail(req, verdict) {
    return Object.assign({ seq: req.seq, q: req.q, kind: req.kind, offset: req.offset, ok: false, webUrl: webSearchUrl(req.q, req.kind) }, verdict);
  }

  function remember(answer) {
    last = { state: answer.ok ? 'ok' : answer.state, ok: !!answer.ok, title: answer.ok ? 'Searches are working' : answer.title, at: now() };
  }

  async function fetchAnswer(req, count) {
    const params = new URLSearchParams({ q: req.q, count: String(count || COUNT), offset: String(req.offset), safesearch: 'moderate' });
    const url = apiBase + ENDPOINTS[req.kind] + '?' + params.toString();
    if (!fetchImpl) return fail(req, classifyNetworkError(new Error('no fetch in this build')));
    let res;
    // A kept-alive connection that the far end closed while it sat idle fails on reuse with a
    // reset, though a fresh connection would work (or be refused, which is the true answer).
    // Chromium retries that case once; so does this, through the same rate-limit slot.
    for (let attempt = 0; ; attempt++) {
      await waitTurn();
      try {
        const opts = { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key } };
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') opts.signal = AbortSignal.timeout(TIMEOUT_MS);
        res = await fetchImpl(url, opts);
        break;
      } catch (err) {
        if (attempt === 0 && isDroppedConnection(err)) continue;
        return fail(req, classifyNetworkError(err));
      }
    }
    const u = monthUsage(res.headers);
    if (u) usage = Object.assign(u, { at: now() });
    let text = '';
    try { text = await res.text(); } catch (err) { return fail(req, classifyNetworkError(err)); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status !== 200) return fail(req, classifyStatus(res.status, json, res.headers, maskKey(key)));
    const shaped = shapeAnswer(req.kind, json);
    if (!shaped) {
      return fail(req, {
        state: 'bad-answer',
        title: 'Brave\'s answer could not be read',
        detail: 'Brave answered 200, but not with search results Quartz understands' + (json ? ' (no results block)' : ' (not JSON)') + '. Try again, or use the plain web search.',
        retry: true, settings: false,
      });
    }
    return Object.assign({ seq: req.seq, q: req.q, kind: req.kind, offset: req.offset, ok: true, cached: false, webUrl: webSearchUrl(req.q, req.kind) }, shaped);
  }

  function cacheKey(req) { return req.kind + '\n' + req.offset + '\n' + req.q; }

  function prune() {
    const t = now();
    for (const [k, v] of cache) if (t - v.at > CACHE_TTL_MS) cache.delete(k);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** One search, as the page asked for it. Always resolves to an answer; never throws. */
  async function search(input) {
    load();
    const req = { q: input.q, kind: input.kind || 'web', offset: input.offset || 0, seq: input.seq || 0 };
    if (!key) {
      const answer = fail(req, {
        state: 'no-key',
        title: 'No Brave Search key yet',
        detail: 'Quartz draws this page from the Brave Search API, and that needs a key. Get one at brave.com/search/api, paste it in Settings > Search, then press Try again.',
        retry: true, settings: true,
      });
      remember(answer);
      return answer;
    }
    prune();
    const ck = cacheKey(req);
    const hit = cache.get(ck);
    if (hit && now() - hit.at <= CACHE_TTL_MS) {
      return Object.assign({}, hit.answer, { seq: req.seq, cached: true });
    }
    if (inFlight.has(ck)) {
      const shared = await inFlight.get(ck);
      return Object.assign({}, shared, { seq: req.seq });
    }
    const p = fetchAnswer(req).catch((err) => fail(req, classifyNetworkError(err)));
    inFlight.set(ck, p);
    let answer;
    try { answer = await p; } finally { inFlight.delete(ck); }
    remember(answer);
    if (answer.ok) { cache.set(ck, { at: now(), answer }); prune(); }
    if (!answer.ok) log('search failed:', answer.state);   // the state only: never the key, never the query
    return answer;
  }

  /** Settings' "Check key": one real one-result search, bypassing the cache. Spends one search. */
  async function test() {
    load();
    if (!key) return Object.assign(describe(), { check: { ok: false, state: 'no-key', title: 'No key saved', detail: 'Paste a key first.' } });
    const answer = await fetchAnswer({ q: 'Brave Search', kind: 'web', offset: 0, seq: 0 }, 1);
    remember(answer);
    const check = answer.ok
      ? { ok: true, state: 'ok', title: 'The key works', detail: 'Brave answered with results.' }
      : { ok: false, state: answer.state, title: answer.title, detail: answer.detail };
    return Object.assign(describe(), { check });
  }

  /* --- the guest side ---------------------------------------------------------------- */

  function isSearchPage(url) {
    if (!isBundledPage(url)) return false;
    try { return path.basename(new URL(url).pathname).toLowerCase() === PAGE_FILE; } catch { return false; }
  }

  function messageOf(first, args) {
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string') return args[1];
    return '';
  }

  function push(contents, answer) {
    if (!contents || contents.isDestroyed()) return;
    let url = '';
    try { url = contents.getURL(); } catch { return; }
    if (!isSearchPage(url)) return;   // it navigated away while Brave was answering
    let json;
    try { json = JSON.stringify(answer); } catch { return; }
    try {
      const p = contents.executeJavaScript('window.__applySearch && window.__applySearch(' + json + ')');
      if (p && typeof p.catch === 'function') p.catch(() => { /* the page went away */ });
    } catch { /* destroyed mid-call */ }
  }

  /** One console line from one guest. True when it was a search request from our page. */
  function handleGuestLine(contents, line) {
    let url = '';
    try { url = contents.getURL(); } catch { return false; }
    if (!isSearchPage(url)) return false;
    const req = parseGuestLine(line);
    if (!req) return false;
    search(req).then((answer) => push(contents, answer), (err) => push(contents, fail(req, classifyNetworkError(err))));
    return true;
  }

  function watchGuest(contents) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    contents.on('console-message', function (details) {
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('guest line failed:', (err && err.message) || 'error');
      }
    });
  }

  function registerIpc(ipcMain, isChromeSender) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    const gate = typeof isChromeSender === 'function' ? isChromeSender : () => false;
    ipcMain.handle('brave-search:describe', (event) => (gate(event) ? describe() : null));
    ipcMain.handle('brave-search:set-key', (event, k) => (gate(event) ? setKey(k) : null));
    ipcMain.handle('brave-search:test', (event) => (gate(event) ? test() : null));
  }

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try { if (contents && contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
  }
  if (d.ipcMain) registerIpc(d.ipcMain, d.isChromeSender);

  return {
    describe, setKey, search, test, handleGuestLine, watchGuest, registerIpc,
    /** Quit: the transient cache goes with the process anyway; this makes it explicit. */
    stop: () => { cache.clear(); inFlight.clear(); },
    state: () => ({ cacheEntries: cache.size, nextSlot, apiBase }),
  };
}

module.exports = {
  create,
  maskKey,
  cleanKey,
  webSearchUrl,
  parseGuestLine,
  shapeResult,
  shapeAnswer,
  shapeLayout,
  monthUsage,
  classifyStatus,
  classifyNetworkError,
  isDroppedConnection,
  API_BASE,
  SIGNUP_URL,
  LINE_PREFIX,
  MIN_GAP_MS,
  CACHE_TTL_MS,
  CACHE_MAX,
  COUNT,
};
