'use strict';
/*
 * tests/watch-tmdb-test.js -- watch/tmdb.js against hand-written fixtures (watch-fixtures/
 * tmdb-*.json), served by a FAKE fetchJson. Never touches the network or a real key.
 * Run by watch-harness.js (moduleTests): module.exports = async function (check).
 */
const fs = require('fs');
const path = require('path');
const Tmdb = require('../watch/tmdb');
const Shape = require('../watch/shape');

const FX = path.join(__dirname, 'watch-fixtures');
const V3 = '0123456789abcdef0123456789abcdef';
const V4 = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmYWtlLXRlc3Qta2V5In0.c2lnX2Zha2VfMTIz-_';

function fixture(name) {
  try { return JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8')); } catch (e) { return null; }
}

/**
 * A fake fetchJson: answers /search/multi with tmdb-search.json and /{type}/{id}/watch/providers
 * with tmdb-providers-{type}-{id}.json (404 when there is none). `over` swaps answers per path
 * kind ('search' | 'providers' | 'auth'). It records every call and the most in flight at once.
 */
function fake(over) {
  const o = over || {};
  const calls = [];
  let inFlight = 0;
  const f = async function (url, headers) {
    calls.push({ url, headers: Object.assign({}, headers || {}) });
    inFlight++;
    f.maxInFlight = Math.max(f.maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const u = new URL(url);
    const p = u.pathname.replace(/^\/3/, '');
    let kind = 'other';
    if (p === '/search/multi') kind = 'search';
    else if (/^\/(movie|tv)\/\d+\/watch\/providers$/.test(p)) kind = 'providers';
    else if (p === '/authentication') kind = 'auth';
    if (typeof o[kind] === 'function') return o[kind](u, p);
    if (kind === 'search') return { status: 200, json: fixture('tmdb-search.json'), error: null };
    if (kind === 'providers') {
      const m = /^\/(movie|tv)\/(\d+)\//.exec(p);
      const j = fixture('tmdb-providers-' + m[1] + '-' + m[2] + '.json');
      return j ? { status: 200, json: j, error: null } : { status: 404, json: { success: false, status_code: 34 }, error: null };
    }
    if (kind === 'auth') return { status: 200, json: { success: true, status_code: 1, status_message: 'Success.' }, error: null };
    return { status: 404, json: null, error: null };
  };
  f.calls = calls;
  f.maxInFlight = 0;
  return f;
}

function byId(res, id) {
  return (res.results || []).find((r) => r.tmdbId === id) || null;
}

function prov(r, name, type) {
  return r ? r.providers.find((p) => p.name === name && (!type || p.type === type)) || null : null;
}

module.exports = async function (check) {
  /* --- keyMode + auth ------------------------------------------------------------------- */
  check(Tmdb.keyMode(V4) === 'v4', 'keyMode: a JWT read token is v4');
  check(Tmdb.keyMode(V3) === 'v3', 'keyMode: a 32-hex key is v3');
  check(Tmdb.keyMode(null) === 'v3' && Tmdb.keyMode(42) === 'v3', 'keyMode: junk is v3, no throw');
  check(Tmdb.API_BASE === 'https://api.themoviedb.org/3', 'API_BASE');

  const f3 = fake();
  const r3 = await Tmdb.search('inside out', V3, f3, { region: 'US', max: 6 });
  const s3 = f3.calls[0] ? new URL(f3.calls[0].url) : null;
  check(r3.state === 'ok', 'v3: search ok', r3.state + ' ' + r3.reason);
  check(s3 && s3.origin + s3.pathname === 'https://api.themoviedb.org/3/search/multi', 'v3: first call is /search/multi', f3.calls[0] && f3.calls[0].url);
  check(s3 && s3.searchParams.get('query') === 'inside out' && s3.searchParams.get('include_adult') === 'false' &&
    s3.searchParams.get('language') === 'en-US' && s3.searchParams.get('page') === '1', 'v3: search query params');
  check(f3.calls.every((c) => new URL(c.url).searchParams.get('api_key') === V3), 'v3: every call carries ?api_key=');
  check(f3.calls.every((c) => !c.headers.Authorization && !c.headers.authorization), 'v3: no Authorization header');

  const f4 = fake();
  const r4 = await Tmdb.search('inside out', V4, f4, { region: 'US', max: 6 });
  check(r4.state === 'ok', 'v4: search ok', r4.state);
  check(f4.calls.length > 1 && f4.calls.every((c) => c.headers.Authorization === 'Bearer ' + V4), 'v4: every call has Authorization: Bearer');
  check(f4.calls.every((c) => c.url.indexOf('api_key') === -1 && c.url.indexOf(V4) === -1), 'v4: the token is never in a URL');

  /* --- results, mapping ------------------------------------------------------------------ */
  const ids = r3.results.map((r) => r.tmdbId);
  check(JSON.stringify(ids) === JSON.stringify([101, 202, 303, 404, 505, 606]), 'search: movie/tv only, in order, top 6 (person dropped)', ids);
  check(f3.calls.length === 7, 'search: one providers read per title (1 + 6 calls)', f3.calls.length);
  check(f3.maxInFlight <= 2, 'search: never more than 2 requests in flight', f3.maxInFlight);
  check(r3.attribution === 'Where-to-watch data from JustWatch, via TMDB', 'search: JustWatch attribution on the answer');

  const io = byId(r3, 101);
  check(io && io.mediaType === 'movie' && io.title === 'Inside Out 2' && io.year === 2024, 'movie: title, type, year', io && [io.title, io.year]);
  check(io && io.image === 'https://image.tmdb.org/t/p/w780/bk101.jpg', 'image: backdrop at w780', io && io.image);
  check(io && io.overview.length <= 240 && io.overview.length > 100, 'overview: capped at 240', io && io.overview.length);
  const bluey = byId(r3, 202);
  check(bluey && bluey.mediaType === 'tv' && bluey.title === 'Bluey' && bluey.year === 2018, 'tv: name -> title, first_air_date -> year');
  check(bluey && bluey.image === 'https://image.tmdb.org/t/p/w780/p202.jpg', 'image: poster when there is no backdrop', bluey && bluey.image);
  check(byId(r3, 303) && byId(r3, 303).image === '', 'image: neither -> empty');

  const dp = prov(io, 'Disney Plus', 'stream');
  check(dp && dp.service === 'disney', 'providers: flatrate -> stream, Disney Plus -> disney', dp);
  check(dp && dp.url === 'https://www.disneyplus.com/search?q=Inside%20Out%202', 'url: a Watch service links to its own search for the title', dp && dp.url);
  check(dp && dp.logo === 'https://image.tmdb.org/t/p/w92/disney.jpg', 'logo: w92', dp && dp.logo);
  const av = prov(io, 'Amazon Video', 'rent');
  check(av && av.service === 'prime' && av.url.indexOf('https://www.primevideo.com/search/') === 0, 'providers: Amazon Video (rent) -> prime');
  const apple = prov(io, 'Apple TV', 'rent');
  check(apple && apple.service === '' && apple.url === io.watchLink, 'url: an unmapped provider links to the TMDB watch page', apple);
  check(io && io.watchLink === 'https://www.themoviedb.org/movie/101-inside-out-2/watch?locale=US', 'watchLink: the US region link', io && io.watchLink);
  check(io && !prov(io, 'Crave'), 'region: US only (no Canadian Crave)');
  check(io && io.providers.filter((p) => p.name === 'YouTube' && p.type === 'buy').length === 1, 'providers: duplicates in one bucket collapse');
  check(io && io.providers.some((p) => p.name === 'Amazon Video' && p.type === 'buy') && io.providers.some((p) => p.name === 'YouTube' && p.type === 'buy' && p.service === 'youtube'), 'providers: buy bucket, YouTube -> youtube');
  const types = io ? io.providers.map((p) => p.type) : [];
  check(types.indexOf('stream') < types.indexOf('rent') && types.indexOf('rent') < types.indexOf('buy'), 'providers: stream, then rent, then buy', types);
  const rentNames = io ? io.providers.filter((p) => p.type === 'rent').map((p) => p.name) : [];
  check(rentNames[0] === 'Amazon Video', 'providers: by display_priority within a bucket', rentNames);

  check(prov(bluey, 'Hulu', 'stream') && prov(bluey, 'Hulu', 'stream').service === 'disney', 'providers: Hulu -> disney (inside Disney+)');
  check(!prov(bluey, 'BBC iPlayer'), 'region: GB data ignored for US');
  const boat = byId(r3, 303);
  check(prov(boat, 'Amazon Prime Video', 'stream') && prov(boat, 'Amazon Prime Video', 'stream').service === 'prime', 'providers: Amazon Prime Video -> prime');
  check(prov(boat, 'Amazon Prime Video with Ads', 'ads') && prov(boat, 'Amazon Prime Video with Ads', 'ads').service === 'prime', 'providers: ads bucket, "with Ads" variant -> prime');
  const notld = byId(r3, 505);
  check(prov(notld, 'YouTube Free', 'free') && prov(notld, 'YouTube Free', 'free').service === 'youtube', 'providers: free bucket, YouTube Free -> youtube');
  check(prov(notld, 'Tubi TV', 'ads') && prov(notld, 'Tubi TV', 'ads').service === '', 'providers: Tubi stays unmapped');
  check(prov(notld, 'YouTube', 'rent') && prov(notld, 'YouTube', 'rent').url === 'https://www.youtube.com/results?search_query=Night%20of%20the%20Living%20Dead', 'url: YouTube search for the title');
  const bear = byId(r3, 404);
  check(bear && bear.watchLink === '', 'watchLink: a non-TMDB link is dropped', bear && bear.watchLink);
  check(bear && bear.providers.length === 2 && prov(bear, 'Odd Logo Network') && prov(bear, 'Odd Logo Network').logo === '', 'providers: junk rows skipped, a bad logo path -> empty', bear && bear.providers);
  check(bear && prov(bear, 'Odd Logo Network').url === '', 'url: unmapped with no watch page -> empty');
  const lk = byId(r3, 606);
  check(lk && lk.providers.length === 0 && lk.watchLink === '', 'region: no US entry -> no providers, no link');

  const fca = fake();
  const rca = await Tmdb.search('inside out', V3, fca, { region: 'CA' });
  const crave = prov(byId(rca, 101), 'Crave', 'stream');
  check(crave && crave.service === '' && byId(rca, 101).watchLink.indexOf('locale=CA') !== -1, 'region: opts.region CA picks the CA entry');
  check(!prov(byId(rca, 101), 'Disney Plus'), 'region: CA drops the US providers');

  /* --- max ------------------------------------------------------------------------------- */
  const f2 = fake();
  const r2 = await Tmdb.search('x', V3, f2, { max: 2 });
  check(r2.results.length === 2 && f2.calls.length === 3, 'max: 2 -> 2 results, 2 providers reads', [r2.results.length, f2.calls.length]);
  const f8 = fake();
  const r8 = await Tmdb.search('x', V3, f8, { max: 8 });
  check(r8.results.length === 8, 'max: 8 -> 8 results', r8.results.length);
  const espn = prov(byId(r8, 707), 'ESPN Plus', 'stream');
  check(espn && espn.service === 'espn' && espn.url.indexOf('https://www.espn.com/search/_/q/') === 0, 'providers: ESPN Plus -> espn');
  check(r8.state === 'ok' && /1 of 8/.test(r8.reason) && byId(r8, 808).providers.length === 0, 'providers: one failed read is named, the rest still show', r8.reason);
  const rdef = await Tmdb.search('x', V3, fake());
  check(rdef.results.length === 6, 'max: default is 6 with no opts');

  /* --- states ---------------------------------------------------------------------------- */
  const r401 = await Tmdb.search('x', V3, fake({ search: () => ({ status: 401, json: { success: false, status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' }, error: null }) }));
  check(r401.state === 'bad-key' && /TMDB rejected the key; check it in Settings > Watch/.test(r401.reason) && r401.results.length === 0, '401 -> bad-key', r401);
  const r429 = await Tmdb.search('x', V3, fake({ search: () => ({ status: 429, json: null, error: null }) }));
  check(r429.state === 'rate-limited' && r429.reason, '429 -> rate-limited', r429);
  const roff = await Tmdb.search('x', V3, fake({ search: () => ({ status: 0, json: null, error: { code: 'offline', detail: 'This PC is offline' } }) }));
  check(roff.state === 'offline' && roff.reason === 'This PC is offline', 'offline -> offline with its detail', roff);
  const rto = await Tmdb.search('x', V3, fake({ search: () => ({ status: 0, json: null, error: { code: 'timeout', detail: 'TMDB did not answer within 10 s' } }) }));
  check(rto.state === 'offline' && /10 s/.test(rto.reason), 'timeout -> offline with its detail', rto);
  const r500 = await Tmdb.search('x', V3, fake({ search: () => ({ status: 500, json: null, error: null }) }));
  check(r500.state === 'error' && /500/.test(r500.reason), '500 -> error naming the status', r500);
  const rempty = await Tmdb.search('zzzz', V3, fake({ search: () => ({ status: 200, json: { page: 1, results: [], total_results: 0 }, error: null }) }));
  check(rempty.state === 'empty' && rempty.results.length === 0, 'no results -> empty', rempty);
  const rpeople = await Tmdb.search('amy', V3, fake({ search: () => ({ status: 200, json: { results: [{ id: 1, media_type: 'person', name: 'A' }] }, error: null }) }));
  check(rpeople.state === 'empty', 'only people -> empty');
  const rp401 = await Tmdb.search('x', V3, fake({ providers: () => ({ status: 401, json: null, error: null }) }));
  check(rp401.state === 'bad-key' && rp401.results.length === 0, '401 on providers -> bad-key');
  const rp429 = await Tmdb.search('x', V3, fake({ providers: () => ({ status: 429, json: null, error: null }) }));
  check(rp429.state === 'ok' && rp429.results.length === 6 && /slow down/.test(rp429.reason), '429 on providers: titles still shown, reason says why', rp429.reason);
  check([r401, r429, roff, r500, rempty, rp429].every((r) => r.attribution), 'every answer carries attribution');

  /* --- the key never leaves -------------------------------------------------------------- */
  const leaky = fake({
    search: () => ({ status: 0, json: null, error: { code: 'offline', detail: 'GET https://api.themoviedb.org/3/search/multi?api_key=' + V3 + ' failed' } }),
  });
  const rleak = await Tmdb.search('x', V3, leaky);
  check(rleak.state === 'offline' && JSON.stringify(rleak).indexOf(V3) === -1, 'key: scrubbed from an error detail that echoed it', rleak.reason);
  const all = [r3, r4, rca, r2, r8, r401, r429, roff, r500, rempty, rp401, rp429];
  check(all.every((r) => JSON.stringify(r).indexOf(V3) === -1 && JSON.stringify(r).indexOf(V4) === -1), 'key: never in any search answer');

  /* --- junk inputs never throw ----------------------------------------------------------- */
  const junk = [
    () => Tmdb.search(null, V3, fake()),
    () => Tmdb.search(42, V3, fake()),
    () => Tmdb.search('   ', V3, fake()),
    () => Tmdb.search('x', null, fake()),
    () => Tmdb.search('x', 'has spaces in it', fake()),
    () => Tmdb.search('x', { k: 1 }, fake()),
    () => Tmdb.search('x', V3, null),
    () => Tmdb.search('x', V3, fake(), 'junk'),
    () => Tmdb.search('x', V3, fake(), { region: 'usa', max: -3 }),
    () => Tmdb.search('x', V3, async () => { throw new Error('boom ' + V3); }),
    () => Tmdb.search('x', V3, async () => undefined),
    () => Tmdb.search('x', V3, async () => ({ status: 'x', json: 'nope' })),
    () => Tmdb.search('x', V3, fake({ search: () => ({ status: 200, json: { results: 'nope' }, error: null }) })),
    () => Tmdb.search('x', V3, fake({ search: () => ({ status: 200, json: { results: [null, 1, 'a', { id: -1, media_type: 'movie', title: 'x' }, { id: 5, media_type: 'tv' }] }, error: null }) })),
    () => Tmdb.search('x', V3, fake({ providers: () => ({ status: 200, json: { results: { US: 'nope' } }, error: null }) })),
    () => Tmdb.search('x', V3, fake({ providers: () => ({ status: 200, json: { results: { US: { flatrate: 'nope', rent: [1, null] } } }, error: null }) })),
  ];
  let threw = 0;
  let shaped = 0;
  const junkOut = [];
  for (const j of junk) {
    try {
      const r = await j();
      junkOut.push(r);
      if (r && typeof r.state === 'string' && Array.isArray(r.results) && r.attribution) shaped++;
    } catch (e) { threw++; }
  }
  check(threw === 0 && shaped === junk.length, 'junk: ' + junk.length + ' bad inputs, no throw, all shaped', { threw, shaped });
  check(junkOut[0].state === 'empty' && junkOut[2].state === 'empty', 'junk: no query -> empty');
  check(junkOut[3].state === 'bad-key' && /Settings > Watch/.test(junkOut[3].reason), 'junk: no key -> bad-key, says where to add one');
  check(junkOut[4].state === 'bad-key', 'junk: a key with spaces -> bad-key, never sent');
  check(junkOut[6].state === 'error' && junkOut[9].state === 'error' && junkOut[9].reason.indexOf(V3) === -1, 'junk: no / throwing fetchJson -> error, key not in reason', junkOut[9].reason);
  check(junkOut[8].results.length === 6, 'junk: bad region/max fall back to US / 6');
  check(junkOut[13].state === 'empty', 'junk: unusable hits -> empty');

  /* --- check() --------------------------------------------------------------------------- */
  const fc = fake();
  const c1 = await Tmdb.check(V4, fc);
  check(c1.ok === true && c1.title && /Read Access Token/.test(c1.detail), 'check: v4 ok', c1);
  check(fc.calls.length === 1 && new URL(fc.calls[0].url).pathname === '/3/authentication' && fc.calls[0].headers.Authorization === 'Bearer ' + V4, 'check: one GET /authentication with Bearer');
  const c2 = await Tmdb.check(V3, fake({ auth: () => ({ status: 401, json: { success: false, status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' }, error: null }) }));
  check(c2.ok === false && c2.title === 'TMDB rejected the key' && /Invalid API key/.test(c2.detail), 'check: 401 -> rejected, with TMDB\'s words', c2);
  const c3 = await Tmdb.check(V3, fake({ auth: () => ({ status: 0, json: null, error: { code: 'offline', detail: 'This PC is offline' } }) }));
  check(c3.ok === false && c3.title === 'Could not reach TMDB', 'check: offline', c3);
  const c4 = await Tmdb.check('', fake());
  check(c4.ok === false && /Paste a key/.test(c4.detail), 'check: no key');
  const c5 = await Tmdb.check(V3, async () => { throw new Error('x ' + V3); });
  const c6 = await Tmdb.check(V3, null);
  const c7 = await Tmdb.check(V3, fake({ auth: () => ({ status: 200, json: { success: false, status_message: 'nope' }, error: null }) }));
  check(c5.ok === false && c6.ok === false && c7.ok === false, 'check: throwing / missing fetchJson / success:false -> not ok, no throw');
  check([c1, c2, c3, c4, c5, c6, c7].every((c) => JSON.stringify(c).indexOf(V3) === -1 && JSON.stringify(c).indexOf(V4) === -1), 'check: key never in the answer');

  /* --- mapping table --------------------------------------------------------------------- */
  const table = [['Disney Plus', 'disney'], ['Hulu', 'disney'], ['Amazon Prime Video', 'prime'], ['Amazon Video', 'prime'],
    ['Amazon Prime Video with Ads', 'prime'], ['Prime Video', 'prime'], ['YouTube', 'youtube'], ['YouTube Premium', 'youtube'],
    ['YouTube Free', 'youtube'], ['ESPN Plus', 'espn'], ['YouTube TV', ''], ['Netflix', ''], ['', ''], [null, '']];
  const wrong = table.filter(([n, s]) => Tmdb.serviceForProvider(n) !== s);
  check(wrong.length === 0, 'mapping: provider names -> Watch services', wrong);
  check(Shape.SERVICE_IDS.indexOf('disney') !== -1, 'shape: services present');
};
