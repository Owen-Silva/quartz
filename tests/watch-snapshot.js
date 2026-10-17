'use strict';
/*
 * tests/watch-snapshot.js -- fixture snapshots for the Watch page, shaped
 * EXACTLY like watch-main.js snapshot() and search() hand them to watch.html.
 * The page tests, the design harness and the screenshot walks load these
 * instead of standing up the readers.
 *
 * Every item goes through Shape.cleanItem and every event through
 * Shape.cleanEvent (so `edge` and the caps come from the real rules), and the
 * rows / sports strip come from the real Merge.buildRows / Merge.buildSports.
 * A fixture entry that fails to clean THROWS: a typo can never silently drop
 * a card from a screenshot.
 *
 *   full(now)            all four services read fine, real-looking rows
 *   firstRun(now)        nothing read yet: YouTube reading, the rest queued
 *   mixedFailures(now)   Disney+ error (cached items kept), Prime signed out,
 *                        YouTube paused for memory, ESPN fine with 2 live games
 *   allPaused(now)       like full, every service paused (a game is running)
 *   empty(now)           all signed in and read, nothing in any account
 *   searchAnswer(q, seq) / searchAnswerFailed(q, seq) / searchAnswerTmdb(q, seq)
 *
 * Plain CommonJS; no dependencies beyond ../watch/shape and ../watch/merge.
 */
const Shape = require('../watch/shape');
const Merge = require('../watch/merge');

const MIN = 60e3;
const HOUR = 3600e3;
const LEAGUES = ['nhl', 'nba', 'nfl', 'mlb'];

/* --- stable fake ids, derived from a seed string (FNV-1a, repeated) ------------------ */

function hex(seed, n) {
  let out = '';
  let round = 0;
  while (out.length < n) {
    let h = 0x811c9dc5;
    const s = seed + '#' + round++;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
}

function uuid(seed) {
  const h = hex(seed, 32);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function alnum(seed, n) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const h = hex(seed, n * 2);
  let out = '';
  for (let i = 0; i < n; i++) out += abc[parseInt(h.slice(i * 2, i * 2 + 2), 16) % abc.length];
  return out;
}

function clock(len) {
  const parts = len.split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/* --- cleaning, with a loud failure ---------------------------------------------------- */

function cleanAll(raws, label) {
  const seen = {};
  return raws.map((raw) => {
    const it = Shape.cleanItem(raw);
    if (!it) throw new Error('watch-snapshot: ' + label + ' item failed Shape.cleanItem: ' + JSON.stringify(raw));
    const key = it.kind + '|' + it.id;
    if (seen[key]) throw new Error('watch-snapshot: ' + label + ' item duplicates ' + key);
    seen[key] = true;
    return it;
  });
}

function cleanEventsLoud(raws) {
  return raws.map((raw) => {
    const ev = Shape.cleanEvent(raw);
    if (!ev) throw new Error('watch-snapshot: event failed Shape.cleanEvent: ' + JSON.stringify(raw));
    return ev;
  });
}

/* --- YouTube --------------------------------------------------------------------------- */

const YT_VIDEOS = [
  ['R6MlUcmOul8', 'Tears of Steel - Blender VFX Open Movie', 'Blender', '12:14'],
  ['PVGeM40dABA', 'Coffee Run - Blender Open Movie', 'Blender Studio', '3:04'],
  ['mN0zPOpADL4', 'Agent 327: Operation Barbershop', 'Blender Studio', '3:51'],
  ['aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', 'Blender', '10:35'],
  ['h6fcK_fRYaI', 'The Egg - A Short Story', 'Kurzgesagt - In a Nutshell', '7:54'],
  ['wbSwFU6tY1c', 'Falcon Heavy Test Flight', 'SpaceX', '39:48'],
  ['WhWc3b3KhnY', 'Spring - Blender Open Movie', 'Blender Studio', '7:44'],
  ['UXqq0ZvbOnk', 'CHARGE - Blender Open Movie', 'Blender Studio', '3:56'],
  ['eRsGyueVLvQ', 'Sintel - Open Movie by Blender Foundation', 'Blender', '14:48'],
  ['SkVqJ1SGeL0', 'Caminandes 3: Llamigos', 'Blender', '2:30'],
  ['TLkA0RELQ1g', 'Elephants Dream', 'Blender', '10:54'],
  ['UF8uR6Z6KLc', "Steve Jobs' 2005 Stanford Commencement Address", 'Stanford', '15:05']
];

/* Which shelf each video sits on in the user's account. */
const YT_KIND = {
  R6MlUcmOul8: ['resume', 0.42],
  h6fcK_fRYaI: ['resume', 0.18],
  wbSwFU6tY1c: ['resume', 0.77],
  UF8uR6Z6KLc: ['watchlist', null],
  TLkA0RELQ1g: ['watchlist', null]
};

function ytRaw(v, kind, progress) {
  return {
    id: 'youtube:' + v[0],
    service: 'youtube',
    kind,
    title: v[1],
    subtitle: v[2],
    image: 'https://i.ytimg.com/vi/' + v[0] + '/hqdefault.jpg',
    progress: progress === undefined ? null : progress,
    url: 'https://www.youtube.com/watch?v=' + v[0],
    startsAt: null,
    durationSec: clock(v[3]),
    badge: '',
    group: ''
  };
}

function youtubeItems() {
  const order = ['resume', 'rec', 'watchlist'];
  const raws = YT_VIDEOS.map((v) => {
    const k = YT_KIND[v[0]] || ['rec', null];
    return ytRaw(v, k[0], k[1]);
  });
  raws.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return cleanAll(raws, 'youtube');
}

/* --- Disney+ (with Hulu) --------------------------------------------------------------- */

const NO_IMAGE = { 'Solar Opposites': true, Up: true };   // exactly two Disney+ tiles draw the no-image tile

function disneyImage(title) {
  if (NO_IMAGE[title]) return '';
  return 'https://disney.images.edge.bamgrid.com/ripcut-delivery/v1/variant/disney/' + uuid('disney-img:' + title) +
    '/compose?aspectRatio=1.78&format=jpeg&width=800';
}

function disneyRaw(kind, title, opts) {
  const o = opts || {};
  const id = uuid('disney:' + title);
  let url;
  if (o.hulu) url = 'https://www.hulu.com/watch/' + id;
  else if (kind === 'resume') url = 'https://www.disneyplus.com/play/' + id;
  else url = 'https://www.disneyplus.com/browse/entity-' + id;
  return {
    id: 'disney:' + id,
    service: 'disney',
    kind,
    title,
    subtitle: o.subtitle || '',
    image: disneyImage(title),
    progress: o.progress === undefined ? null : o.progress,
    url,
    startsAt: null,
    durationSec: o.durationSec || null,
    badge: o.badge || '',
    group: o.group || ''
  };
}

function disneyItems() {
  const g1 = 'Because you watched Andor';
  const g2 = 'Hulu Originals';
  return cleanAll([
    disneyRaw('resume', 'Andor', { subtitle: 'S2 E9', durationSec: 2640, progress: 0.31 }),
    disneyRaw('resume', 'The Bear', { subtitle: 'S4 E3', durationSec: 1860, progress: 0.2, badge: 'Hulu', hulu: true }),
    disneyRaw('resume', 'Shogun', { subtitle: 'S1 E7', durationSec: 3480, progress: 0.66, badge: 'Hulu' }),

    disneyRaw('rec', 'The Mandalorian', { group: g1, subtitle: '3 seasons' }),
    disneyRaw('rec', 'Loki', { group: g1, subtitle: '2 seasons' }),
    disneyRaw('rec', 'Rogue One: A Star Wars Story', { group: g1, subtitle: '2016 · PG-13' }),
    disneyRaw('rec', 'Ahsoka', { group: g1, subtitle: '1 season' }),
    disneyRaw('rec', 'Star Wars: Skeleton Crew', { group: g1, subtitle: '1 season' }),

    disneyRaw('rec', 'Only Murders in the Building', { group: g2, badge: 'Hulu' }),
    disneyRaw('rec', "The Handmaid's Tale", { group: g2, badge: 'Hulu' }),
    disneyRaw('rec', 'Abbott Elementary', { group: g2, badge: 'Hulu' }),
    disneyRaw('rec', 'Solar Opposites', { group: g2, badge: 'Hulu' }),
    disneyRaw('rec', 'Futurama', { group: g2, badge: 'Hulu' }),

    disneyRaw('rec', 'Avatar: The Way of Water', { subtitle: '2022 · PG-13' }),
    disneyRaw('rec', 'Up', { subtitle: '2009 · PG' }),

    disneyRaw('watchlist', 'Toy Story', { subtitle: '1995 · G' }),
    disneyRaw('watchlist', 'Finding Nemo', { subtitle: '2003 · G' }),
    disneyRaw('watchlist', 'Moana', { subtitle: '2016 · PG' })
  ], 'disney');
}

/* --- Prime Video ----------------------------------------------------------------------- */

function primeRaw(kind, title, opts) {
  const o = opts || {};
  const asin = 'B0' + alnum('prime:' + title, 8);
  return {
    id: 'prime:' + asin,
    service: 'prime',
    kind,
    title,
    subtitle: o.subtitle || '',
    image: 'https://m.media-amazon.com/images/S/pv-target-images/' + hex('prime-img:' + title, 64) + '.jpg',
    progress: o.progress === undefined ? null : o.progress,
    url: 'https://www.primevideo.com/detail/' + asin + '/',
    startsAt: null,
    durationSec: o.durationSec || null,
    badge: o.badge || '',
    group: o.group || ''
  };
}

function primeItems() {
  const g = 'Top movies on Prime';
  return cleanAll([
    primeRaw('resume', 'Reacher', { subtitle: 'S3 E2', durationSec: 3300, progress: 0.48 }),
    primeRaw('resume', 'Fallout', { subtitle: 'S1 E5', durationSec: 3660, progress: 0.12 }),
    primeRaw('rec', 'Interstellar', { group: g, badge: 'Rent', subtitle: '2014 · PG-13' }),
    primeRaw('rec', 'The Boys', { group: g, subtitle: 'Prime original' }),
    primeRaw('rec', 'The Lord of the Rings: The Rings of Power', { group: g, subtitle: 'Prime original' }),
    primeRaw('rec', 'Mr. & Mrs. Smith', { group: g, subtitle: 'Prime original' }),
    primeRaw('rec', 'Road House', { group: g, subtitle: '2024 · R' }),
    primeRaw('watchlist', 'The Summer I Turned Pretty', { subtitle: '3 seasons' }),
    primeRaw('watchlist', 'Invincible', { subtitle: '3 seasons' })
  ], 'prime');
}

/* --- ESPN ------------------------------------------------------------------------------ */

function logo(league, abbr) {
  return 'https://a.espncdn.com/i/teamlogos/' + league + '/500/' + abbr.toLowerCase() + '.png';
}

function team(league, name, abbr, score, record, noLogo) {
  return { name, abbr, logo: noLogo ? '' : logo(league, abbr), score, record };
}

function espnEvents(now) {
  return cleanEventsLoud([
    {
      id: '401802517', league: 'nhl', state: 'in', startsAt: now - 70 * MIN, detail: '2nd 08:41',
      away: team('nhl', 'Montreal Canadiens', 'MTL', 1, '3-3-1'),
      home: team('nhl', 'Toronto Maple Leafs', 'TOR', 2, '4-2-1'),
      broadcasts: ['ESPN+'],
      watchUrl: 'https://www.espn.com/watch/player/_/id/' + uuid('espn-watch:401802517'),
      gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401802517',
      locked: true
    },
    {
      id: '401810231', league: 'nba', state: 'in', startsAt: now - 135 * MIN, detail: '4th 3:12',
      away: team('nba', 'Boston Celtics', 'BOS', 88, '3-1'),
      home: team('nba', 'New York Knicks', 'NY', 91, '2-2'),
      broadcasts: ['ESPN'],
      watchUrl: 'https://www.espn.com/watch/player/_/id/' + uuid('espn-watch:401810231'),
      gamecastUrl: 'https://www.espn.com/nba/game/_/gameId/401810231',
      locked: false
    },
    {
      id: '401802533', league: 'nhl', state: 'pre', startsAt: now + 3 * HOUR, detail: '10:00 PM EDT',
      away: team('nhl', 'Edmonton Oilers', 'EDM', '', '5-2-1'),
      home: team('nhl', 'Vancouver Canucks', 'VAN', '', '4-3-0', true),   // no logo: the fallback badge
      broadcasts: ['ESPN+', 'SN'],
      watchUrl: 'https://www.espn.com/watch/player/_/id/' + uuid('espn-watch:401802533'),
      gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401802533',
      locked: null
    },
    {
      id: '401772938', league: 'nfl', state: 'pre', startsAt: now + 20 * HOUR, detail: 'Sun 4:25 PM EDT',
      away: team('nfl', 'Kansas City Chiefs', 'KC', '', '4-2'),
      home: team('nfl', 'Buffalo Bills', 'BUF', '', '5-1'),
      broadcasts: ['CBS'],
      watchUrl: '',
      gamecastUrl: 'https://www.espn.com/nfl/game/_/gameId/401772938',
      locked: null
    },
    {
      id: '401802498', league: 'nhl', state: 'post', startsAt: now - 5 * HOUR, detail: 'Final/OT',
      away: team('nhl', 'Boston Bruins', 'BOS', 3, '4-3-1'),
      home: team('nhl', 'Florida Panthers', 'FLA', 4, '5-2-0'),
      broadcasts: ['TNT'],
      watchUrl: '',
      gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401802498',
      locked: null
    }
  ]);
}

/* The ESPN adapter also emits live / upcoming ITEMs from the events (adapters/espn.js). */
function espnItems(events, now) {
  const raws = [];
  for (const e of events) {
    const kind = e.state === 'in' ? 'live' : (e.state === 'pre' && e.startsAt - now <= 36 * HOUR ? 'upcoming' : '');
    if (!kind) continue;
    raws.push({
      id: e.id,
      service: 'espn',
      kind,
      title: (e.away.name || e.away.abbr) + ' at ' + (e.home.name || e.home.abbr),
      subtitle: e.leagueName + (e.broadcasts.length ? ' · ' + e.broadcasts.join(', ') : ''),
      image: '',
      progress: null,
      url: e.watchUrl || e.gamecastUrl,
      startsAt: e.startsAt,
      durationSec: null,
      badge: kind === 'live' ? 'Live' : (e.broadcasts[0] || ''),
      group: kind === 'live' ? 'Live now' : 'Starting soon'
    });
  }
  return cleanAll(raws, 'espn');
}

/* --- the snapshot, built like watch-main.js snapshot() --------------------------------- */

function everyMs(id, events, now) {
  const svc = Shape.serviceById(id);
  if (!svc) return HOUR;
  if (id === 'espn' && svc.liveEveryMin && Merge.sportsHot(events || [], now)) return svc.liveEveryMin * MIN;
  return svc.everyMin * MIN;
}

/*
 * `cache[id]` = { enabled, state, reason, readAt, lastOkAt, attemptAt, profile, items,
 * events (espn), queued, paused }. Mirrors serviceView() field for field.
 */
function serviceView(id, s, readingId, now) {
  const svc = Shape.serviceById(id);
  const counts = { resume: 0, rec: 0, watchlist: 0, live: 0, upcoming: 0 };
  for (const it of s.items) if (counts[it.kind] !== undefined) counts[it.kind]++;
  return {
    id, name: svc.name, short: svc.short, covers: svc.covers, edge: svc.edge, needsSignIn: svc.needsSignIn,
    enabled: !!s.enabled,
    state: s.enabled ? s.state : 'off',
    reason: s.reason,
    warnings: (s.warnings || []).slice(),
    readAt: s.readAt, lastOkAt: s.lastOkAt, profile: s.profile,
    reading: readingId === id, queued: !!s.queued,
    paused: s.enabled ? (s.paused || '') : '',
    next: s.enabled ? (s.attemptAt || 0) + everyMs(id, s.events, now) : 0,
    counts,
    home: svc.home, signIn: svc.signIn,
    hasReader: true
  };
}

function build(now, cache, readingId) {
  // A service a fixture doesn't name (Hulu joined after these fixtures were written) is off:
  // the fixture's own services keep their exact counts.
  cache = Object.assign({}, cache);
  for (const id of Shape.SERVICE_IDS) if (!cache[id]) {
    cache[id] = { enabled: false, state: 'off', reason: '', readAt: 0, lastOkAt: 0, attemptAt: 0, profile: '', items: [], queued: false, paused: '', warnings: [] };
  }
  const services = {};
  for (const id of Shape.SERVICE_IDS) services[id] = { enabled: cache[id].enabled, items: cache[id].items, state: cache[id].state };
  const events = cache.espn.enabled ? (cache.espn.events || []) : [];
  const items = [];
  for (const id of Shape.SERVICE_IDS) if (cache[id].enabled) for (const it of cache[id].items) items.push(it);
  return {
    v: 1,
    now,
    services: Shape.SERVICE_IDS.map((id) => serviceView(id, cache[id], readingId, now)),
    rows: Merge.buildRows(services),
    sports: Merge.buildSports(events, now, LEAGUES),
    leagues: LEAGUES.slice(),
    items,
    tmdb: { hasKey: false },
    reading: readingId || null
  };
}

function okEntry(now, agoMin, profile, items, extra) {
  const readAt = now - agoMin * MIN;
  return Object.assign({
    enabled: true, state: 'ok', reason: '', readAt, lastOkAt: readAt, attemptAt: readAt,
    profile, items, events: undefined, queued: false, paused: '', warnings: []
  }, extra || {});
}

function fullCache(now) {
  const events = espnEvents(now);
  return {
    youtube: okEntry(now, 3, 'the user', youtubeItems()),
    disney: okEntry(now, 12, 'the user', disneyItems()),
    prime: okEntry(now, 41, 'the user', primeItems()),
    espn: okEntry(now, 1, '', espnItems(events, now), { events })
  };
}

function full(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const c = fullCache(t);
  c.prime.warnings = ['watch history is off'];   // read OK, one part missing: state stays ok
  return build(t, c, null);
}

function firstRun(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const never = (queued) => ({
    enabled: true, state: 'never', reason: '', readAt: 0, lastOkAt: 0, attemptAt: 0,
    profile: '', items: [], events: [], queued, paused: '', warnings: []
  });
  return build(t, { youtube: never(false), disney: never(true), prime: never(true), espn: never(true) }, 'youtube');
}

function mixedFailures(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const c = fullCache(t);
  c.youtube.paused = 'paused: only 1.2 GB of memory free (Watch reads with at least 1.5 GB)';
  c.youtube.warnings = ['Continue watching: timed out after 20 s'];
  c.disney = Object.assign(c.disney, {
    state: 'error',
    reason: 'the page loaded but no Continue Watching data matched (Disney+ changed its layout?)',
    readAt: t - 2 * MIN, attemptAt: t - 2 * MIN, lastOkAt: t - 3 * HOUR
  });
  c.prime = Object.assign(c.prime, {
    state: 'signed-out', reason: 'Prime Video asked you to sign in again', items: [], profile: ''
  });
  return build(t, c, null);
}

function allPaused(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const c = fullCache(t);
  for (const id of Shape.SERVICE_IDS) if (c[id] && c[id].enabled) c[id].paused = 'paused while VALORANT is running';
  return build(t, c, null);
}

function empty(now) {
  const t = typeof now === 'number' ? now : Date.now();
  return build(t, {
    youtube: okEntry(t, 3, 'the user', []),
    disney: okEntry(t, 12, 'the user', []),
    prime: okEntry(t, 41, 'the user', []),
    espn: okEntry(t, 1, '', [], { events: [] })
  }, null);
}

/* --- search, shaped like watch-main.js search() ---------------------------------------- */

function youtubeSearchItems(q) {
  const words = Merge.fold(q).split(' ').filter(Boolean);
  const hits = YT_VIDEOS.filter((v) => {
    const hay = Merge.fold(v[1] + ' ' + v[2]);
    return words.some((w) => hay.indexOf(w) !== -1);
  });
  let pick;
  if (hits.length >= 4) pick = hits.slice(0, 6);
  else {
    pick = hits.slice();
    for (const v of YT_VIDEOS) if (pick.length < 5 && pick.indexOf(v) === -1) pick.push(v);
  }
  return cleanAll(pick.map((v) => ytRaw(v, 'search', null)), 'youtube search');
}

function query(q) {
  return typeof q === 'string' && q.trim() ? q.trim() : 'blender';
}

function searchAnswer(q, seq) {
  const qq = query(q);
  return {
    seq: typeof seq === 'number' ? seq : 1,
    q: qq,
    links: Merge.searchLinks(qq),
    tmdb: { state: 'no-key', reason: 'Add a free TMDB key in Settings to search every service', results: [] },
    youtube: { ok: true, state: 'ok', reason: '', items: youtubeSearchItems(qq) }
  };
}

function searchAnswerFailed(q, seq) {
  const a = searchAnswer(q, seq);
  a.youtube = {
    ok: false, state: 'error',
    reason: "YouTube's results page had nothing Watch could read (YouTube changed its layout?)",
    items: []
  };
  return a;
}

function tmdbImage(seed) {
  return 'https://image.tmdb.org/t/p/w780/' + alnum('tmdb-img:' + seed, 27).toLowerCase() + '.jpg';
}

function searchAnswerTmdb(q, seq) {
  const a = searchAnswer(q, seq);
  // Like watch/tmdb.js mapProviders(): a service provider links to that service's own search
  // for the title; any other provider links to the TMDB watch page. tmdb.js sends no `price`.
  const searchOn = (service, title) => Shape.cleanHttps(Shape.serviceById(service).searchUrl + encodeURIComponent(title));
  const andorUrl = searchOn('disney', 'Andor');
  const bearUrl = searchOn('disney', 'The Bear');
  const interstellarUrl = searchOn('prime', 'Interstellar');
  a.tmdb = {
    state: 'ok',
    results: [
      {
        tmdbId: 83867, mediaType: 'tv', title: 'Andor', year: 2022, image: tmdbImage('andor'),
        overview: 'The tale of the burgeoning rebellion against the Empire and how people and planets became involved.',
        providers: [{ name: 'Disney Plus', logo: '', type: 'stream', service: 'disney', url: andorUrl }],
        watchLink: 'https://www.themoviedb.org/tv/83867/watch'
      },
      {
        tmdbId: 157336, mediaType: 'movie', title: 'Interstellar', year: 2014, image: tmdbImage('interstellar'),
        overview: 'A team of explorers travels through a wormhole in space in an attempt to ensure humanity\'s survival.',
        providers: [
          { name: 'Paramount Plus', logo: '', type: 'stream', service: '', url: 'https://www.themoviedb.org/movie/157336/watch' },
          { name: 'Amazon Video', logo: '', type: 'rent', service: 'prime', url: interstellarUrl },
          { name: 'Amazon Video', logo: '', type: 'buy', service: 'prime', url: interstellarUrl }
        ],
        watchLink: 'https://www.themoviedb.org/movie/157336/watch'
      },
      {
        tmdbId: 136315, mediaType: 'tv', title: 'The Bear', year: 2022, image: tmdbImage('the bear'),
        overview: 'A young chef from the fine dining world returns to Chicago to run his family\'s sandwich shop.',
        providers: [{ name: 'Hulu', logo: '', type: 'stream', service: 'disney', url: bearUrl }],
        watchLink: 'https://www.themoviedb.org/tv/136315/watch'
      }
    ],
    attribution: 'Where-to-watch data from JustWatch, via TMDB'
  };
  return a;
}

module.exports = {
  full, firstRun, mixedFailures, searchAnswer, searchAnswerFailed, searchAnswerTmdb, allPaused, empty
};
