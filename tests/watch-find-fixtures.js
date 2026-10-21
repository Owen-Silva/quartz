'use strict';
// tests/watch-find-fixtures.js -- hand-written answers for Lumen's one search box (watch-find-harness.js,
// watch-find-e2e.js). Shapes follow the public sources each reader names (watch/search/*.js): Disney+'s
// explore search (data.page.containers[].items[]), hulu.com's discover search (groups[].results[]),
// Prime Video's search-page hydration (containers[].entities[]), TMDB's search/multi + watch/providers.
// None of them was checked against a signed-in account. Never a real title id from a real account.

const UUID = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

/* Disney+ explore search: what /explore/v1.7/search?query=<q> answers. */
const DISNEY = {
  'the bear': [
    { id: 'thebear00001', title: 'The Bear', year: 2022, type: 'series', genres: ['Comedy', 'Drama'], attribution: 'Hulu' },
    { id: 'brotherbear01', title: 'Brother Bear', year: 2003, type: 'movie', genres: ['Animation'] },
    { id: 'bigbluehouse1', title: 'Bear in the Big Blue House', year: 1997, type: 'series', genres: ['Kids'] },
    { id: 'bearlocked001', title: 'The Bear Hunt', year: 2019, type: 'movie', genres: ['Family'], upsell: true },
  ],
  'cocaine bear': [
    { id: 'thebear00001', title: 'The Bear', year: 2022, type: 'series', genres: ['Comedy', 'Drama'], attribution: 'Hulu' },
  ],
};
function disneyItem(t) {
  return {
    id: t.id, type: 'item', programType: t.type,
    visuals: {
      title: t.title,
      metastringParts: { releaseYearRange: { startYear: t.year }, genres: { values: t.genres } },
      networkAttribution: t.attribution || '',
      artwork: { standard: { tile: { '1.78': { imageId: 'IMG' + t.id.toUpperCase() } } } },
    },
    actions: [{ type: 'browse', pageId: 'entity-' + t.id }].concat(t.upsell ? [{ type: 'upsell' }] : []),
  };
}
function disney(q) {
  const list = DISNEY[String(q || '').toLowerCase()] || [];
  return { data: { page: { id: 'search-results', containers: [{ id: 'search-set', type: 'set', style: { name: 'grid' }, visuals: { name: 'Results' }, items: list.map(disneyItem) }] } } };
}
/* What the search page fetches before the query runs: trending, never results. */
function disneyLanding() {
  return { data: { page: { id: 'explore', containers: [{ id: 'trending', type: 'set', visuals: { name: 'Trending' }, items: [disneyItem({ id: 'trending0001', title: 'Trending Decoy', year: 2024, type: 'movie', genres: [] })] }] } } };
}

/* hulu.com discover search: what /content/v5/search/entity?search_query=<q> answers. */
const HULU = {
  'the bear': [
    { n: 1, title: 'The Bear', type: 'series', year: '2022-06-23', genres: ['Comedy', 'Drama'] },
    { n: 2, title: 'Cocaine Bear', type: 'movie', year: '2023-02-24', genres: ['Comedy', 'Thriller'], locked: true },
    { n: 3, title: 'Grizzly Man', type: 'movie', year: '2005-08-12', genres: ['Documentary'] },
  ],
  'cocaine bear': [
    { n: 2, title: 'Cocaine Bear', type: 'movie', year: '2023-02-24', genres: ['Comedy', 'Thriller'], locked: true },
  ],
};
function huluTile(t) {
  return {
    _type: 'view',
    id: UUID(t.n),
    entity_metadata: { entity_type: t.type, name: t.title, premiere_date: t.year, genre_names: t.genres },
    visuals: { headline: t.title, artwork: { horizontal_tile: { image: { path: 'https://img1.hulu.com/user/v3/artwork/' + UUID(t.n) + '?base_image_bucket_name=image_manager&base_image=' + UUID(t.n) } } } },
    actions: Object.assign({ browse: { target_type: t.type, target_id: UUID(t.n), href: 'https://www.hulu.com/' + t.type + '/' + UUID(t.n) } }, t.locked ? { upsell: { type: 'add-on' } } : {}),
    metrics_info: { target_type: t.type, target_id: UUID(t.n), target_name: t.title },
  };
}
function hulu(q) {
  const list = HULU[String(q || '').toLowerCase()] || [];
  return { groups: [{ category: 'top results', results: list.map(huluTile) }] };
}

/* Prime Video's search page: the hydration JSON it embeds, and its store (signed in). */
const PRIME = {
  'the bear': [
    { id: 'B0BEARS1RNT', title: 'The Bear - Season 1', type: 'TV Show', year: '2022', cue: { entitlementType: 'Unentitled', focusMessage: { message: 'Available to rent or buy' } } },
    { id: 'B0PADDINGTN', title: 'Paddington', type: 'Movie', year: '2014', cue: { entitlementType: 'Entitled', focusMessage: { message: 'Included with Prime' } } },
    { id: 'B0COCAINEBR', title: 'Cocaine Bear', type: 'Movie', year: '2023', cue: { entitlementType: 'Unentitled', focusMessage: { message: 'Rent or buy' } } },
  ],
  'cocaine bear': [
    { id: 'B0COCAINEBR', title: 'Cocaine Bear', type: 'Movie', year: '2023', cue: { entitlementType: 'Unentitled', focusMessage: { message: 'Rent or buy' } } },
  ],
};
function primeEntity(t) {
  return {
    titleID: t.id, title: t.title, displayTitle: t.title, entityType: t.type, widgetType: 'TitleCard', releaseYear: t.year,
    link: { url: '/detail/' + t.id + '/ref=atv_sr_def_c_unkc_1_1' },
    images: { cover: { url: 'https://m.media-amazon.com/images/S/pv-target-images/' + t.id + '._UR1920,1080_.jpg' } },
    entitlementCues: t.cue,
  };
}
function prime(q, opts) {
  const o = opts || {};
  const list = PRIME[String(q || '').toLowerCase()] || [];
  const hydration = { init: { path: '/search', preparations: { body: { containers: [{ containerType: 'StandardGrid', title: 'Results', entities: list.map(primeEntity) }] } } } };
  const store = o.signedOut
    ? { RequestContext: { customerID: null, identityContext: '68|UFZJQ1NfVU5BVVRIRU5USUNBVEVE' } }
    : { RequestContext: { customerID: 'A1TESTCUSTOMER', identityContext: '' }, Profile: { ageGroup: 'ADULT', isChild: false } };
  return { hydration, store };
}

/* TMDB search/multi + watch/providers. The Bear: Hulu (= Disney+ here) and Prime (buy); The Bear and the Fox: Netflix only. */
const TMDB = {
  'the bear': [
    { id: 136315, media_type: 'tv', name: 'The Bear', first_air_date: '2022-06-23', backdrop_path: '/bear.jpg' },
    { id: 10009, media_type: 'movie', title: 'Brother Bear', release_date: '2003-10-20', backdrop_path: '/brother.jpg' },
    { id: 346648, media_type: 'movie', title: 'The Bear and the Fox', release_date: '2017-11-09', backdrop_path: '/bearfox.jpg' },
  ],
  'cocaine bear': [{ id: 804150, media_type: 'movie', title: 'Cocaine Bear', release_date: '2023-02-22', backdrop_path: '/cocaine.jpg' }],
};
const PROVIDERS = {
  'tv/136315': { flatrate: [{ provider_name: 'Hulu', display_priority: 1 }], buy: [{ provider_name: 'Amazon Video', display_priority: 3 }] },
  'movie/10009': { flatrate: [{ provider_name: 'Disney Plus', display_priority: 1 }] },
  'movie/346648': { flatrate: [{ provider_name: 'Netflix', display_priority: 1 }] },
  'movie/804150': { flatrate: [{ provider_name: 'Peacock', display_priority: 1 }], rent: [{ provider_name: 'Amazon Video', display_priority: 2 }] },
};
function tmdbSearch(q) {
  return { page: 1, results: TMDB[String(q || '').toLowerCase()] || [], total_pages: 1, total_results: (TMDB[String(q || '').toLowerCase()] || []).length };
}
function tmdbProviders(type, id) {
  const p = PROVIDERS[type + '/' + id] || {};
  return { id: Number(id), results: { US: Object.assign({ link: 'https://www.themoviedb.org/' + type + '/' + id + '/watch?locale=US' }, p) } };
}

/* His own rows: Hulu's Keep Watching has The Bear at 40 %. */
function cache(now, states) {
  const s = states || {};
  const svc = (id, items) => ({ state: s[id] || 'ok', reason: '', items: items || [], profile: '', readAt: now, lastOkAt: now, attemptAt: now, captured: 1, warnings: [], events: [] });
  return {
    v: 1,
    services: {
      youtube: svc('youtube', [{ id: 'youtube:abcdefghijk', service: 'youtube', kind: 'rec', title: 'Kitchen knife skills', url: 'https://www.youtube.com/watch?v=abcdefghijk', subtitle: 'Chef Channel' }]),
      disney: svc('disney', [{ id: 'disney:brotherbear01', service: 'disney', kind: 'watchlist', title: 'Brother Bear', url: 'https://www.disneyplus.com/browse/entity-brotherbear01', subtitle: '' }]),
      hulu: svc('hulu', [{ id: 'hulu:' + UUID(1), service: 'hulu', kind: 'resume', title: 'The Bear', subtitle: 'S2 E4 · Honeydew', progress: 0.4, durationSec: 1800, url: 'https://www.hulu.com/series/' + UUID(1) }]),
      prime: svc('prime', []),
      espn: svc('espn', []),
    },
  };
}

module.exports = { UUID, disney, disneyLanding, hulu, prime, tmdbSearch, tmdbProviders, cache, DISNEY, HULU, PRIME, TMDB };
