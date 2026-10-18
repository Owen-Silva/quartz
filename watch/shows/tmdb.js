'use strict';
/*
 * watch/shows/tmdb.js -- TMDB's season and episode data for Lumen's show page, when a service's
 * reader failed or a title is on none of the user's services (pure; main passes fetchJson).
 *
 *   lookup(req, key, fetchJson, opts) -> { state, reason, show, providers, watchLink, tmdbId, mediaType, attribution }
 *   season(tmdbId, n, key, fetchJson)  -> { state, reason, season }
 *
 * Reads: one /search/tv|movie (skipped when the TMDB id is known), one details call with
 * recommendations + watch/providers appended, and one /tv/<id>/season/<n> for the season shown.
 * TMDB knows nothing about the user: every episode here has progress null (the page says so). The
 * key never leaves in any value (scrubbed like watch/tmdb.js); provider data carries JustWatch's
 * attribution, as TMDB's terms ask.
 */
const Shape = require('../shape');
const Tmdb = require('../tmdb');

const API_BASE = Tmdb.API_BASE;
const IMG_HERO = 'https://image.tmdb.org/t/p/w1280';
const IMG_TILE = 'https://image.tmdb.org/t/p/w780';
const IMG_STILL = 'https://image.tmdb.org/t/p/w300';
const ATTRIBUTION = Tmdb.ATTRIBUTION;
const MORE_MAX = 12;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function usableKey(key) {
  if (typeof key !== 'string') return '';
  const k = key.trim();
  return k && k.length <= 1024 && /^[A-Za-z0-9._\-]+$/.test(k) ? k : '';
}
function scrub(text, key) {
  let s = String(text == null ? '' : text);
  if (key) s = s.split(key).join('[key]');
  return Shape.cleanText(s, 200);
}
function image(base, p) { return typeof p === 'string' && /^\/[A-Za-z0-9._\-]+$/.test(p) ? Shape.cleanHttps(base + p) : ''; }
function yearOf(d) { const m = /^(\d{4})/.exec(typeof d === 'string' ? d : ''); return m ? Number(m[1]) : null; }
function fold(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }

async function get(fetchJson, pathAndQuery, key) {
  let url = API_BASE + pathAndQuery;
  const headers = {};
  if (Tmdb.keyMode(key) === 'v4') headers.Authorization = 'Bearer ' + key;
  else url += (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(key);
  let res;
  try { res = await fetchJson(url, headers); } catch (err) { return { status: 0, json: null, error: { code: 'load-failed', detail: String((err && err.message) || err) } }; }
  if (!res || typeof res !== 'object') return { status: 0, json: null, error: { code: 'load-failed', detail: 'no answer' } };
  return { status: Number.isFinite(res.status) ? res.status : 0, json: obj(res.json), error: obj(res.error) };
}

function failure(res, key) {
  if (res.error) {
    const code = String(res.error.code || '');
    if (code === 'offline') return { state: 'offline', reason: 'this PC looks offline, so TMDB could not be reached' };
    if (code === 'timeout') return { state: 'error', reason: 'TMDB did not answer in time' };
    return { state: 'error', reason: 'could not reach TMDB (' + scrub(res.error.detail || code, key) + ')' };
  }
  if (res.status === 401) return { state: 'bad-key', reason: 'TMDB rejected the key; check it in Settings > Lumen' };
  if (res.status === 404) return { state: 'none', reason: 'TMDB has no page for this title' };
  if (res.status === 429) return { state: 'error', reason: 'TMDB asked Lumen to slow down; try again in a few seconds' };
  if (res.status < 200 || res.status >= 300) return { state: 'error', reason: 'TMDB answered HTTP ' + (res.status || 'with no status') };
  if (!res.json) return { state: 'error', reason: 'TMDB sent something Lumen could not read' };
  return null;
}

/** The search hit the title means: exact title (and year, when known) first. */
function pick(results, title, year, media) {
  const want = fold(title);
  const hits = (Array.isArray(results) ? results : []).filter(obj).map((h) => {
    const mt = media || (h.media_type === 'tv' || h.media_type === 'movie' ? h.media_type : '');
    if (!mt || !Number.isInteger(Number(h.id))) return null;
    const t = mt === 'tv' ? (h.name || h.original_name) : (h.title || h.original_title);
    const y = yearOf(mt === 'tv' ? h.first_air_date : h.release_date);
    let score = 0;
    const ft = fold(t);
    if (ft === want) score += 4;
    else if (want.length >= 4 && ft.length >= 4 && (ft.indexOf(want) !== -1 || want.indexOf(ft) !== -1)) score += 3;
    if (year && y === year) score += 2;
    else if (year && y && Math.abs(y - year) === 1) score += 1;
    return { id: Number(h.id), mediaType: mt, score };
  }).filter(Boolean);
  if (!hits.length) return null;
  const best = hits.slice().sort((a, b) => b.score - a.score)[0];
  return best.score >= 3 ? best : null;   // never a different title that merely came first
}

function ratingOf(d, mediaType) {
  if (mediaType === 'tv') {
    const list = obj(d.content_ratings) && Array.isArray(d.content_ratings.results) ? d.content_ratings.results : [];
    const us = list.filter((x) => obj(x) && x.iso_3166_1 === 'US')[0];
    return us ? Shape.cleanText(us.rating, 12) : '';
  }
  const rl = obj(d.release_dates) && Array.isArray(d.release_dates.results) ? d.release_dates.results : [];
  const us = rl.filter((x) => obj(x) && x.iso_3166_1 === 'US')[0];
  const c = us && Array.isArray(us.release_dates) ? us.release_dates.map((x) => obj(x) && x.certification).filter(Boolean)[0] : '';
  return Shape.cleanText(c || '', 12);
}

function mapSeason(json, n) {
  const eps = (Array.isArray(json && json.episodes) ? json.episodes : []).filter(obj).map((e) => ({
    id: 'tmdb:' + (Number(e.id) || ''), s: Number.isInteger(e.season_number) ? e.season_number : n, e: Number.isInteger(e.episode_number) ? e.episode_number : null,
    title: Shape.cleanText(e.name, 200), synopsis: Shape.cleanText(e.overview, 400),
    runtimeSec: Number(e.runtime) > 0 ? Math.round(Number(e.runtime) * 60) : null, image: image(IMG_STILL, e.still_path),
    progress: null, watched: null, url: ''
  }));
  return { n, label: Shape.cleanText(json && json.name, 60) || (n === 0 ? 'Specials' : 'Season ' + n), episodes: eps, loaded: true, fromTmdb: true };
}

async function season(tmdbId, n, key, fetchJson) {
  const k = usableKey(key);
  if (!k) return { state: 'no-key', reason: 'no TMDB key', season: null };
  if (!Number.isInteger(tmdbId) || !Number.isInteger(n) || n < 0) return { state: 'error', reason: 'not a season TMDB knows', season: null };
  const res = await get(fetchJson, '/tv/' + tmdbId + '/season/' + n + '?language=en-US', k);
  const bad = failure(res, k);
  if (bad) return Object.assign(bad, { season: null });
  return { state: 'ok', reason: '', season: mapSeason(res.json, n) };
}

async function lookup(req, key, fetchJson, opts) {
  const o = opts || {};
  const k = usableKey(key);
  const out = { state: 'error', reason: '', show: null, providers: [], watchLink: '', tmdbId: 0, mediaType: '', attribution: ATTRIBUTION };
  try {
    if (!k) return Object.assign(out, { state: 'no-key', reason: key ? 'that TMDB key has odd characters in it; check it in Settings > Lumen' : 'add the free TMDB key in Settings > Lumen to see episodes from TMDB' });
    if (typeof fetchJson !== 'function') return Object.assign(out, { reason: 'this build has no way to reach TMDB' });
    const title = Shape.cleanText(req && req.title, 200);
    let id = Number(req && req.tmdbId) || 0;
    let media = req && (req.tmdbType === 'tv' || req.tmdbType === 'movie') ? req.tmdbType : req && req.type === 'show' ? 'tv' : req && req.type === 'movie' ? 'movie' : '';
    if (!id) {
      if (!title) return Object.assign(out, { state: 'none', reason: 'no title to look up' });
      const y = Number(req.year) || 0;
      const q = encodeURIComponent(title);
      const path = media === 'tv' ? '/search/tv?query=' + q + (y ? '&first_air_date_year=' + y : '')
        : media === 'movie' ? '/search/movie?query=' + q + (y ? '&year=' + y : '') : '/search/multi?query=' + q;
      let res = await get(fetchJson, path + '&include_adult=false&language=en-US&page=1', k);
      let bad = failure(res, k);
      if (bad) return Object.assign(out, bad);
      let hit = pick(res.json.results, title, y, media);
      if (!hit && y) {   // the year can be the season's, not the show's
        res = await get(fetchJson, path.replace(/&(first_air_date_year|year)=\d+/, '') + '&include_adult=false&language=en-US&page=1', k);
        bad = failure(res, k);
        if (bad) return Object.assign(out, bad);
        hit = pick(res.json.results, title, 0, media);
      }
      if (!hit) return Object.assign(out, { state: 'none', reason: 'TMDB has nothing called “' + title + '”' });
      id = hit.id;
      media = hit.mediaType;
    }
    const append = media === 'tv' ? 'recommendations,watch/providers,content_ratings' : 'recommendations,watch/providers,release_dates';
    const dr = await get(fetchJson, '/' + media + '/' + id + '?append_to_response=' + append + '&language=en-US', k);
    const dbad = failure(dr, k);
    if (dbad) return Object.assign(out, dbad);
    const d = dr.json;
    const name = Shape.cleanText(media === 'tv' ? (d.name || d.original_name) : (d.title || d.original_title), 200) || title;
    const prov = Tmdb.mapProviders(d['watch/providers'], o.region || 'US', name);
    const more = (obj(d.recommendations) && Array.isArray(d.recommendations.results) ? d.recommendations.results : []).filter(obj).slice(0, MORE_MAX).map((m) => {
      const mt = m.media_type === 'tv' || m.media_type === 'movie' ? m.media_type : media;
      return { title: Shape.cleanText(mt === 'tv' ? m.name : m.title, 200), image: image(IMG_TILE, m.backdrop_path), url: '', service: '', year: yearOf(mt === 'tv' ? m.first_air_date : m.release_date), type: mt === 'tv' ? 'show' : 'movie', tmdbId: Number(m.id) || 0, tmdbType: mt };
    }).filter((m) => m.title);
    const show = {
      service: '', type: media === 'tv' ? 'show' : 'movie', id: 'tmdb:' + id, url: '', title: name,
      year: yearOf(media === 'tv' ? d.first_air_date : d.release_date), rating: ratingOf(d, media),
      synopsis: Shape.cleanText(d.overview, 600), genres: (Array.isArray(d.genres) ? d.genres : []).map((g) => obj(g) && g.name).filter(Boolean),
      image: image(IMG_HERO, d.backdrop_path), runtimeSec: media === 'movie' && Number(d.runtime) > 0 ? Number(d.runtime) * 60 : null,
      seasons: [], resume: null, progress: null, watched: null, playUrl: '', more, watchlist: null, progressKnown: false, source: 'tmdb', notes: []
    };
    if (media === 'tv') {
      const list = (Array.isArray(d.seasons) ? d.seasons : []).filter((s) => obj(s) && Number.isInteger(s.season_number) && (s.episode_count || 0) > 0);
      show.seasons = list.map((s) => ({ n: s.season_number, label: Shape.cleanText(s.name, 60), episodes: [], loaded: false, fromTmdb: true }));
      const want = Number.isInteger(o.season) && list.some((s) => s.season_number === o.season) ? o.season
        : (list.filter((s) => s.season_number >= 1)[0] || list[0] || {}).season_number;
      if (Number.isInteger(want)) {
        const sr = await season(id, want, k, fetchJson);
        if (sr.state === 'ok') show.seasons = show.seasons.map((s) => (s.n === want ? sr.season : s));
        else show.notes.push('TMDB’s episode list for season ' + want + ' did not load: ' + sr.reason);
      }
    }
    return Object.assign(out, { state: 'ok', reason: '', show, providers: prov.providers, watchLink: prov.watchLink, tmdbId: id, mediaType: media });
  } catch (err) {
    return Object.assign(out, { state: 'error', reason: 'the TMDB lookup failed (' + scrub((err && err.message) || err, k) + ')' });
  }
}

module.exports = { lookup, season, ATTRIBUTION, _internal: { pick, mapSeason, usableKey } };
