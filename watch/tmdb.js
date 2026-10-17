'use strict';
/*
 * watch/tmdb.js -- "where can I watch X" for Watch's search, from TMDB (pure).
 *
 *   search(q, key, fetchJson, opts) -> { state, reason, results, attribution }
 *   check(key, fetchJson)           -> { ok, title, detail }   (Settings > Watch, "Check key")
 *   keyMode(key)                    -> 'v4' | 'v3'
 *
 * fetchJson(url, headers) is watch-main.js's: it resolves { status, json, error } and never
 * rejects. Nothing here touches the network itself, keeps state, or throws.
 *
 * KEYS. A v4 "API Read Access Token" is a JWT (starts eyJ) and goes in an Authorization:
 * Bearer header; anything else is a v3 API key and goes in ?api_key=. The key is never put
 * in any value this module returns: every string that leaves passes through scrub().
 *
 * TERMS (next-week/watch/FEASIBILITY.md section 7). TMDB is free for non-commercial use with
 * the "This product uses the TMDB API but is not endorsed or certified by TMDB" notice
 * (Settings > Watch), and watch-provider data MUST be attributed to JustWatch: every answer
 * carries `attribution` for the page to print beside the providers.
 *
 * READS. One /search/multi (movie and tv only, top opts.max), then one /watch/providers per
 * title, two at a time at most. TMDB has no per-service deep links, so a provider Watch reads
 * (Disney+, Prime, YouTube, ESPN) links to that service's own search for the title; any other
 * provider links to TMDB's watch page for the title (which fronts JustWatch's links).
 */
const Shape = require('./shape');

const API_BASE = 'https://api.themoviedb.org/3';
const IMG_BACKDROP = 'https://image.tmdb.org/t/p/w780';
const IMG_LOGO = 'https://image.tmdb.org/t/p/w92';
const ATTRIBUTION = 'Where-to-watch data from JustWatch, via TMDB';
const OVERVIEW_MAX = 240;
const MAX_DEFAULT = 6;
const MAX_CAP = 20;
const CONCURRENCY = 2;

/* TMDB's buckets, in the order the page shows them. */
const TYPES = [['flatrate', 'stream'], ['free', 'free'], ['ads', 'ads'], ['rent', 'rent'], ['buy', 'buy']];

/* Provider names as TMDB spells them -> the Watch service they open in. Matched after
   lower-casing and dropping everything but letters and digits, so "Disney Plus",
   "Amazon Prime Video with Ads" and "YouTube Free" all land. Hulu is Disney+: Hulu titles
   play inside Disney+ once the Hulu profile is linked there. */
function serviceForProvider(name) {
  const n = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return '';
  if (n === 'disneyplus' || n === 'disney' || n === 'hulu' || n.indexOf('hulu') === 0 || n.indexOf('disneyplus') === 0) return 'disney';
  if (n.indexOf('amazonprimevideo') === 0 || n === 'amazonvideo' || n.indexOf('primevideo') === 0) return 'prime';
  if (n === 'youtube' || n === 'youtubepremium' || n === 'youtubefree') return 'youtube';   // not YouTube TV: another sign-in
  if (n === 'espnplus' || n === 'espn') return 'espn';
  return '';
}

function keyMode(key) {
  return (typeof key === 'string' && key.trim().indexOf('eyJ') === 0) ? 'v4' : 'v3';
}

/** The key as it will be sent, or '' when it cannot be one (empty, spaces, odd characters). */
function usableKey(key) {
  if (typeof key !== 'string') return '';
  const k = key.trim();
  if (!k || k.length > 1024 || !/^[A-Za-z0-9._\-]+$/.test(k)) return '';
  return k;
}

/** Every string that leaves this module: plain text, capped, and never the key. */
function scrub(text, key, max) {
  let s = Shape.cleanText(typeof text === 'string' ? text : String(text == null ? '' : text), max || 240);
  if (key && key.length >= 4) s = s.split(key).join('[key]');
  return s;
}

/** URL + headers for one request, authenticated the way the key's kind needs. */
function request(pathAndQuery, key) {
  let url = API_BASE + pathAndQuery;
  const headers = {};
  if (keyMode(key) === 'v4') headers.Authorization = 'Bearer ' + key;
  else url += (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(key);
  return { url, headers };
}

/** fetchJson, guarded: a missing, throwing or odd fetchJson is an { error }, never a throw. */
async function get(fetchJson, pathAndQuery, key) {
  if (typeof fetchJson !== 'function') return { status: 0, json: null, error: { code: 'load-failed', detail: 'no way to fetch' } };
  const r = request(pathAndQuery, key);
  let res;
  try { res = await fetchJson(r.url, r.headers); } catch (err) {
    return { status: 0, json: null, error: { code: 'load-failed', detail: String((err && err.message) || err) } };
  }
  if (!res || typeof res !== 'object') return { status: 0, json: null, error: { code: 'load-failed', detail: 'no answer' } };
  return {
    status: Number.isFinite(res.status) ? res.status : 0,
    json: res.json && typeof res.json === 'object' ? res.json : null,
    error: res.error && typeof res.error === 'object' ? res.error : null,
  };
}

/** A failed response -> { state, reason } in plain words. null when it did not fail. */
function failure(res, key) {
  if (res.error) {
    const code = String(res.error.code || '');
    const detail = scrub(res.error.detail || '', key, 160);
    if (code === 'offline' || code === 'timeout') return { state: 'offline', reason: detail || (code === 'timeout' ? 'TMDB did not answer in time' : 'This PC looks offline') };
    return { state: 'error', reason: 'Could not reach TMDB' + (detail ? ' (' + detail + ')' : '') };
  }
  if (res.status === 401) return { state: 'bad-key', reason: 'TMDB rejected the key; check it in Settings > Watch' };
  if (res.status === 429) return { state: 'rate-limited', reason: 'TMDB is asking Watch to slow down; try again in a few seconds' };
  if (res.status < 200 || res.status >= 300) return { state: 'error', reason: 'TMDB answered with an error (HTTP ' + (res.status || 'no status') + ')' };
  if (!res.json) return { state: 'error', reason: 'TMDB sent something Watch could not read' };
  return null;
}

/** A TMDB image path ('/abc.jpg') on a size base, or ''. */
function image(base, p) {
  if (typeof p !== 'string' || !/^\/[A-Za-z0-9._\-]+$/.test(p)) return '';
  return Shape.cleanHttps(base + p);
}

function yearOf(d) {
  const m = /^(\d{4})/.exec(typeof d === 'string' ? d : '');
  return m ? Number(m[1]) : 0;
}

/** One /search/multi hit -> a result without providers, or null (people, junk). */
function mapHit(h) {
  if (!h || typeof h !== 'object') return null;
  const mediaType = h.media_type === 'movie' || h.media_type === 'tv' ? h.media_type : '';
  if (!mediaType) return null;
  const id = Number(h.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const title = Shape.cleanText(mediaType === 'movie' ? (h.title || h.original_title) : (h.name || h.original_name), 200);
  if (!title) return null;
  return {
    tmdbId: id,
    mediaType,
    title,
    year: yearOf(mediaType === 'movie' ? h.release_date : h.first_air_date),
    image: image(IMG_BACKDROP, h.backdrop_path) || image(IMG_BACKDROP, h.poster_path),
    overview: Shape.cleanText(h.overview, OVERVIEW_MAX),
    providers: [],
    watchLink: '',
  };
}

/** One title's /watch/providers answer, for one region -> { providers, watchLink }. */
function mapProviders(json, region, title) {
  const out = { providers: [], watchLink: '' };
  const all = json && typeof json.results === 'object' && json.results ? json.results : null;
  const r = all && Object.prototype.hasOwnProperty.call(all, region) ? all[region] : null;
  if (!r || typeof r !== 'object') return out;
  const link = Shape.cleanHttps(r.link);
  out.watchLink = link && /(^|\.)themoviedb\.org$/.test(new URL(link).hostname) ? link : '';
  const seen = {};
  for (const [bucket, type] of TYPES) {
    const list = Array.isArray(r[bucket]) ? r[bucket].slice() : [];
    list.sort((a, b) => (Number(a && a.display_priority) || 999) - (Number(b && b.display_priority) || 999));
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const name = Shape.cleanText(p.provider_name, 60);
      if (!name) continue;
      const k = type + '|' + name.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      const service = serviceForProvider(name);
      const svc = service ? Shape.serviceById(service) : null;
      const url = svc ? Shape.cleanHttps(svc.searchUrl + encodeURIComponent(title)) : out.watchLink;
      out.providers.push({ name, logo: image(IMG_LOGO, p.logo_path), type, service: svc ? service : '', url: url || '' });
    }
  }
  return out;
}

function answer(state, reason, results, key) {
  return { state, reason: scrub(reason || '', key), results: results || [], attribution: ATTRIBUTION };
}

async function search(q, key, fetchJson, opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const region = typeof o.region === 'string' && /^[A-Z]{2}$/.test(o.region) ? o.region : 'US';
    const max = Number.isInteger(o.max) && o.max > 0 ? Math.min(o.max, MAX_CAP) : MAX_DEFAULT;
    const query = Shape.cleanText(typeof q === 'string' ? q : '', 200);
    if (!query) return answer('empty', 'Type a title to search', [], '');
    const k = usableKey(key);
    if (!k) return answer('bad-key', key ? 'That TMDB key has spaces or odd characters in it; check it in Settings > Watch' : 'Add a free TMDB key in Settings > Watch', [], '');

    const res = await get(fetchJson, '/search/multi?query=' + encodeURIComponent(query) + '&include_adult=false&language=en-US&page=1', k);
    const bad = failure(res, k);
    if (bad) return answer(bad.state, bad.reason, [], k);
    const hits = Array.isArray(res.json.results) ? res.json.results : [];
    const results = [];
    for (const h of hits) {
      if (results.length >= max) break;
      const r = mapHit(h);
      if (r && !results.some((x) => x.tmdbId === r.tmdbId && x.mediaType === r.mediaType)) results.push(r);
    }
    if (!results.length) return answer('empty', 'Nothing on TMDB matches “' + query + '”', [], k);

    // Providers, two titles at a time. A 401 here is the key's fault and ends the search;
    // a 429 or a dropped connection stops the remaining reads, and the titles already
    // found are still shown, with the reason.
    let stop = null;
    let missed = 0;
    let next = 0;
    const worker = async () => {
      while (next < results.length) {
        const r = results[next++];
        if (stop) { missed++; continue; }
        const pr = await get(fetchJson, '/' + r.mediaType + '/' + r.tmdbId + '/watch/providers', k);
        const f = failure(pr, k);
        if (f) {
          missed++;
          if (f.state === 'bad-key' || f.state === 'rate-limited' || f.state === 'offline') stop = stop || f;
          continue;
        }
        const m = mapProviders(pr.json, region, r.title);
        r.providers = m.providers;
        r.watchLink = m.watchLink;
      }
    };
    const pool = [];
    for (let i = 0; i < Math.min(CONCURRENCY, results.length); i++) pool.push(worker());
    await Promise.all(pool);

    if (stop && stop.state === 'bad-key') return answer('bad-key', stop.reason, [], k);
    let reason = '';
    if (missed) reason = 'Where to watch could not be read for ' + missed + ' of ' + results.length + ' titles' + (stop ? ': ' + stop.reason : '');
    return answer('ok', reason, results, k);
  } catch (err) {
    return answer('error', 'TMDB search failed (' + String((err && err.message) || err).slice(0, 100) + ')', [], typeof key === 'string' ? key.trim() : '');
  }
}

async function check(key, fetchJson) {
  try {
    const k = usableKey(key);
    if (!k) return { ok: false, title: 'Not a key', detail: key ? 'It has spaces or odd characters in it.' : 'Paste a key first.' };
    const res = await get(fetchJson, '/authentication', k);
    const kind = keyMode(k) === 'v4' ? 'an API Read Access Token' : 'an API key';
    const bad = failure(res, k);
    if (bad) {
      const titles = { 'bad-key': 'TMDB rejected the key', 'rate-limited': 'TMDB is busy', offline: 'Could not reach TMDB', error: 'Check failed' };
      let detail = bad.reason;
      if (bad.state === 'bad-key') {
        const msg = res.json && typeof res.json.status_message === 'string' ? scrub(res.json.status_message, k, 160) : '';
        detail = 'Saved as ' + kind + '.' + (msg ? ' TMDB said: ' + msg : '');
      }
      return { ok: false, title: titles[bad.state] || 'Check failed', detail: scrub(detail, k, 240) };
    }
    if (res.json.success === false) {
      return { ok: false, title: 'TMDB rejected the key', detail: scrub(res.json.status_message || ('Saved as ' + kind + '.'), k, 240) };
    }
    return { ok: true, title: 'TMDB accepted the key', detail: 'Saved as ' + kind + '. Search in Watch now covers every service.' };
  } catch (err) {
    return { ok: false, title: 'Check failed', detail: scrub(String((err && err.message) || err), typeof key === 'string' ? key.trim() : '', 120) };
  }
}

module.exports = {
  API_BASE,
  ATTRIBUTION,
  search,
  check,
  keyMode,
  // exposed for tests
  serviceForProvider,
  mapProviders,
};
