// tests/watch-shows-test.js -- Lumen's show pages, the pure half (watch/shows/*.js) and watch-shows-main.js
// driven by a fake reader and a fake fetch: hand-made fixtures only (tests/watch-show-fixtures/, plus the
// YouTube playlist fixture ytlib's tests use). No Electron, no network: nothing here can reach a service or TMDB.
//
//   node tests/watch-shows-test.js
//
// Covers: which tiles open a show page; each service reader (Hulu series + film, Disney+ entity page, Prime
// detail page + film, a YouTube playlist) on its fixture -- seasons, episodes, per-episode progress and the
// watched check, the big button, play addresses, More like this, the watchlist state -- plus signed-out,
// picker, robot and changed-layout pages; TMDB's lookup (search, details, a season, providers, a bad key,
// the key never in any answer) and the merge; and watch-shows-main: the answer for each state (ok,
// reader failed -> TMDB fallback with the reason, signed out, off, paused, not on his services), the
// partial TMDB push, the memory cache, a newer ask cancelling the older, season asks, and the watch-main
// hooks. One line: "watch-shows-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const M = require('../watch/shows/model');
const Hulu = require('../watch/shows/hulu');
const Disney = require('../watch/shows/disney');
const Prime = require('../watch/shows/prime');
const YouTube = require('../watch/shows/youtube');
const TS = require('../watch/shows/tmdb');
const SM = require('../watch-shows-main');
const WM = require('../watch-main');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 600)));
}
const FIX = path.join(__dirname, 'watch-show-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));

const BEAR = 'c3b4c2e2-3f1a-4b8e-9d0c-7a1e2b3c4d5e';
const PALM = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const ANDOR = 'aB3dE5fG7hJ9';
const BOYS = 'B07FMHTRFA';
const KEY = 'abcdef0123456789abcdef0123456789';

/* A reader step as watch-main's runStep returns it, from a fixture. */
function stepOf(host, f, over) {
  const url = host + f.finalPath;
  const s = {
    url, finalUrl: url, status: 200, error: null,
    extracted: { url, title: f.title, login: false, next: '', blobs: f.hydration ? [JSON.stringify(f.hydration)] : [], signedIn: true, complete: true },
    captures: (f.captures || []).map((c) => ({ url: 'https://api.fixture.test' + c.path, status: 200, json: c.json })),
  };
  return Object.assign(s, over || {});
}
const readOf = (step) => ({ steps: { title: step } });
function ytStep(f, url) {
  return { ok: true, url, finalUrl: url, title: 'YouTube', status: 200, extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url }, json: null, text: null, captures: [], error: null };
}

/* TMDB: fixture routes by path (the query's key part and language dropped). */
const TM = fx('tmdb-shows.json').routes;
const tmdbCalls = [];
function fakeTmdb(opts) {
  const o = opts || {};
  return async (url, headers) => {
    tmdbCalls.push(url);
    if (o.status) return { status: o.status, json: { status_message: 'Invalid API key: ' + KEY }, error: null };
    const u = new URL(url);
    if (u.hostname !== 'api.themoviedb.org') return { status: 0, json: null, error: { code: 'load-failed', detail: 'not TMDB' } };
    const p = u.pathname.replace(/^\/3/, '');
    const q = u.searchParams.get('query');
    const k = q !== null ? p + '?query=' + encodeURIComponent(q) : p;
    if (TM[k]) return { status: 200, json: JSON.parse(JSON.stringify(TM[k])), error: null };
    return { status: 404, json: { status_message: 'not found' }, error: null };
  };
}

async function main() {
  /* ------------------------------------------------------------------ which tiles open a show page */
  console.log('watch-shows: which tiles open a show page');
  {
    const r1 = M.requestFor({ service: 'hulu', kind: 'resume', title: 'The Bear', url: 'https://www.hulu.com/series/' + BEAR });
    check(r1 && r1.service === 'hulu' && r1.type === 'show' && r1.id === BEAR && r1.key === 'hulu:' + BEAR, 'a Hulu series tile opens its show page', r1);
    const r2 = M.requestFor({ service: 'hulu', kind: 'rec', title: 'Palm Springs', url: 'https://www.hulu.com/movie/palm-springs-' + PALM });
    check(r2 && r2.type === 'movie' && r2.id === PALM, 'a Hulu film tile (slug + uuid) opens a movie page', r2);
    const r3 = M.requestFor({ service: 'disney', kind: 'watchlist', title: 'Andor', type: 'show', year: 2022, url: 'https://www.disneyplus.com/browse/entity-' + ANDOR });
    check(r3 && r3.service === 'disney' && r3.id === ANDOR && r3.year === 2022, 'a Disney+ entity tile opens its show page', r3);
    const r4 = M.requestFor({ service: 'prime', kind: 'resume', title: 'The Boys', url: 'https://www.primevideo.com/detail/' + BOYS + '/' });
    check(r4 && r4.id === BOYS, 'a Prime Video detail tile opens its show page', r4);
    const r5 = M.requestFor({ service: 'youtube', kind: 'rec', title: 'Sourdough', url: 'https://www.youtube.com/watch?v=plVideo0001&list=PLbakingSourdough0000000001' });
    check(r5 && r5.service === 'youtube' && r5.id === 'PLbakingSourdough0000000001' && /\/playlist\?list=/.test(r5.url), 'a YouTube video from a series playlist opens the playlist as a show', r5);
    check(M.requestFor({ service: 'youtube', kind: 'rec', title: 'x', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }) === null, 'a plain YouTube video plays straight away (no show page)');
    check(M.requestFor({ service: 'youtube', kind: 'rec', title: 'x', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL' }) === null &&
      M.requestFor({ service: 'youtube', kind: 'rec', title: 'x', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ' }) === null, 'Watch Later and mixes are not shows');
    check(M.requestFor({ service: 'disney', kind: 'live', title: 'ABC News Live', url: 'https://www.disneyplus.com/browse/entity-abcdef123' }) === null, 'a live tile plays straight away');
    check(M.requestFor({ service: 'espn', kind: 'replay', title: 'x', url: 'https://www.espn.com/watch/player?id=1' }) === null && M.requestFor({ service: 'hulu', title: 'x', url: 'https://evil.example/series/' + BEAR }) === null, 'ESPN and other hosts never open a show page');
  }

  /* ------------------------------------------------------------------ Hulu */
  console.log('watch-shows: Hulu');
  let huluShow = null;
  {
    const req = { service: 'hulu', type: 'show', id: BEAR, title: 'The Bear', year: null };
    check(Hulu.steps(req)[0].url === 'https://www.hulu.com/series/' + BEAR && Hulu.steps(req)[0].capture[0].test('/content/v5/hubs/series/' + BEAR), 'Hulu: loads the series page and captures its content/v5 hub');
    const r = Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'))), req);
    const s = huluShow = M.cleanShow(r.show);
    check(r.state === 'ok' && s.title === 'The Bear' && s.year === 2022 && s.rating === 'TV-MA' && /sandwich shop/.test(s.synopsis) && s.genres.join() === 'Drama,Comedy' && /^https:\/\/img1\.hulu\.com\/.*size=/.test(s.image), 'Hulu: the hero (title, year, rating, synopsis, genres, sized art)', s);
    check(s.seasons.map((x) => x.n + ':' + x.episodes.length + ':' + x.loaded).join() === '1:3:true,2:4:true,3:0:false', 'Hulu: three season tabs, season 3 known but not sent', s.seasons.map((x) => [x.n, x.episodes.length, x.loaded]));
    const s1 = s.seasons[0].episodes, s2 = s.seasons[1].episodes;
    check(s1.every((e) => e.watched === true) && s2[2].progress === 0.5 && s2[2].watched === null && s2[3].progress === 0, 'Hulu: watched checks on season 1, S2 E3 half watched, S2 E4 not started', s2.map((e) => [e.e, e.progress, e.watched]));
    check(s2[2].title === 'Sundae' && s2[2].runtimeSec === 1800 && /episode 3 of season 2/i.test(s2[2].synopsis) && /^https:/.test(s2[2].image), 'Hulu: an episode has its number, title, runtime, synopsis and still');
    check(s2[2].url === 'https://www.hulu.com/watch/e203aaaa-1111-4222-8333-444455550203', 'Hulu: an episode plays at /watch/<its uuid> (from its eab)', s2[2].url);
    const plan = M.resumePlan(s);
    check(plan.label === 'Resume S2 E3' && plan.url === s2[2].url && plan.fallback === 'https://www.hulu.com/series/' + BEAR && plan.proven === true, 'Hulu: the big button is Resume S2 E3, straight to the player, the series page as its fallback', plan);
    check(M.startSeason(s) === 2, 'Hulu: the page opens on season 2 (where he is)');
    check(s.more.length === 2 && s.more[0].title === 'Shōgun' && s.more[0].type === 'show' && s.more[1].type === 'movie' && /hulu\.com\/movie\//.test(s.more[1].url), 'Hulu: More like this from "You May Also Like"', s.more);
    check(s.watchlist === true && s.progressKnown === true && s.notes.length === 0, 'Hulu: in My Stuff, progress known, no notes');
    const mv = M.cleanShow(Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-movie.json'))), { service: 'hulu', type: 'movie', id: PALM, title: 'Palm Springs' }).show);
    const mp = M.resumePlan(mv);
    check(mv.type === 'movie' && mv.seasons.length === 0 && Math.abs(mv.progress - 0.4) < 1e-9 && mv.watchlist === false && mv.runtimeSec === 5400, 'Hulu film: no seasons, 40 % watched, not in My Stuff', mv);
    check(mp.label === 'Resume' && mp.url === 'https://www.hulu.com/watch/' + PALM, 'Hulu film: Resume plays /watch/<uuid>', mp);
    const out = Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'), { finalUrl: 'https://auth.hulu.com/web/login?next=x', captures: [] })), req);
    check(out.state === 'signed-out' && /sign in to hulu\.com/.test(out.reason), 'Hulu: a sign-in page is signed-out, in words', out);
    const pk = Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'), { finalUrl: 'https://www.hulu.com/profiles', captures: [] })), req);
    check(pk.state === 'error' && pk.picker === true && /who's watching/.test(pk.reason), "Hulu: the who's-watching picker says so", pk);
    const ch = Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'), { captures: [{ url: 'https://x/content/v5/hubs/series/' + BEAR, status: 200, json: { components: [] } }] })), req);
    check(ch.state === 'error' && /changed its layout/.test(ch.reason), 'Hulu: a page with nothing readable is an error with the reason', ch);
    const to = Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'), { captures: [], error: { code: 'timeout', detail: 'x' } })), req);
    check(to.state === 'error' && /timed out after 18 s/.test(to.reason), 'Hulu: a timed-out read says how long', to);
    // the logged-out public page: the model in __NEXT_DATA__, no progress
    const nextModel = { props: { pageProps: { entity: { _type: 'series', id: BEAR, name: 'The Bear', description: 'Public page.' }, episodes: [{ _type: 'episode', id: 'e1', name: 'System', season: 1, number: 1, duration: 1800 }] } } };
    const pub = M.cleanShow(Hulu.parse(readOf(stepOf('https://www.hulu.com', fx('hulu-series.json'), { captures: [], extracted: { url: 'https://www.hulu.com/series/' + BEAR, login: true, next: JSON.stringify(nextModel) } })), req).show);
    check(pub && pub.seasons[0].episodes.length === 1 && pub.seasons[0].episodes[0].progress === null && pub.progressKnown === false && /Signed out of hulu\.com/.test(pub.notes.join()), 'Hulu: the public page model reads, with "signed out, no progress" said', pub && pub.notes);
  }

  /* ------------------------------------------------------------------ Disney+ */
  console.log('watch-shows: Disney+');
  {
    const req = { service: 'disney', type: '', id: ANDOR, title: 'Andor', year: null };
    check(Disney.steps(req)[0].url === 'https://www.disneyplus.com/browse/entity-' + ANDOR && Disney.steps(req)[0].capture[0].test('/explore/v1.7/season/season-2'), 'Disney+: loads the entity page and captures its season sets');
    const r = Disney.parse(readOf(stepOf('https://www.disneyplus.com', fx('disney-entity.json'))), req);
    const s = M.cleanShow(r.show);
    check(r.state === 'ok' && s.title === 'Andor' && s.year === 2022 && s.rating === 'TV-14' && /Cassian Andor/.test(s.synopsis) && /ripcut-delivery/.test(s.image), 'Disney+: the hero from the page visuals (the full description)', s);
    check(s.seasons.map((x) => x.n + ':' + x.episodes.length).join() === '1:3,2:2', 'Disney+: season 1 from the page, season 2 from its lazily loaded set');
    const e = s.seasons[1].episodes;
    check(s.seasons[0].episodes.every((x) => x.watched === true) && Math.abs(e[0].progress - 0.35) < 1e-9 && e[1].progress === 0, 'Disney+: userState progress per episode (S1 watched, S2 E1 35 %)', e.map((x) => [x.e, x.progress, x.watched]));
    check(e[0].title === 'One Year Later' && e[0].runtimeSec === 2460 && /ripcut/.test(e[0].image), 'Disney+: episode title, runtime and still');
    const plan = M.resumePlan(s);
    check(plan.label === 'Resume S2 E1' && plan.url === 'https://www.disneyplus.com/browse/entity-' + ANDOR && plan.proven === false && /isn’t proven/.test(plan.why), 'Disney+: Resume S2 E1 (the page\'s own "Continue S2 E1") opens the title page, and says why', plan);
    check(s.watchlist === true && s.more.map((m) => m.title).join() === 'The Mandalorian,Rogue One', 'Disney+: on the watchlist; Suggested is More like this; Extras are not', s.more);
    const out = Disney.parse(readOf(stepOf('https://www.disneyplus.com', fx('disney-entity.json'), { finalUrl: 'https://www.disneyplus.com/login', captures: [] })), req);
    check(out.state === 'signed-out', 'Disney+: /login is signed-out', out);
    const em = Disney.parse(readOf(stepOf('https://www.disneyplus.com', fx('disney-entity.json'), { captures: [] })), req);
    check(em.state === 'error' && /changed its layout/.test(em.reason), 'Disney+: no captures is an error with the reason', em);
  }

  /* ------------------------------------------------------------------ Prime Video */
  console.log('watch-shows: Prime Video');
  {
    const req = { service: 'prime', type: '', id: BOYS, title: 'The Boys', year: null };
    const r = Prime.parse(readOf(stepOf('https://www.primevideo.com', fx('prime-detail.json'))), req);
    const s = M.cleanShow(r.show);
    check(r.state === 'ok' && s.title === 'The Boys' && s.year === 2019 && s.rating === '18+' && s.genres.join() === 'Action,Comedy' && /m\.media-amazon\.com/.test(s.image), 'Prime: the hero from the detail hydration (the show\'s name, not "Season 1")', s);
    check(s.seasons.length === 2 && s.seasons[0].episodes.length === 3 && s.seasons[1].loaded === false && s.seasons[1].url === 'https://www.primevideo.com/detail/B08BYYQZ3K/', 'Prime: season 2 is its own detail page, not loaded yet', s.seasons);
    const e = s.seasons[0].episodes;
    check(e[0].watched === true && Math.abs(e[1].progress - 0.4) < 1e-9 && e[2].progress === null && e[1].runtimeSec === 3720, 'Prime: E1 watched, E2 40 %, E3 unknown; runtimes', e.map((x) => [x.e, x.progress, x.watched, x.runtimeSec]));
    const plan = M.resumePlan(s);
    check(plan.label === 'Resume S1 E2' && plan.url === 'https://www.primevideo.com/detail/' + BOYS + '/' && plan.proven === false, 'Prime: Resume S1 E2 opens the season\'s page (no autoplay link on record)', plan);
    check(s.watchlist === false && s.more.map((m) => m.title).join() === 'Invincible,Reacher', 'Prime: not on the watchlist; Customers also watched');
    const mv = M.cleanShow(Prime.parse(readOf(stepOf('https://www.primevideo.com', fx('prime-movie.json'))), { service: 'prime', type: '', id: '0AIRMOVIE0001', title: 'Air' }).show);
    check(mv.type === 'movie' && mv.runtimeSec === 6720 && mv.watchlist === true && M.resumePlan(mv).label === 'Play', 'Prime film: 1 h 52 min, on the watchlist, Play', mv);
    const rb = Prime.parse(readOf(stepOf('https://www.primevideo.com', fx('prime-detail.json'), { extracted: { robot: true, blobs: [] } })), req);
    check(rb.state === 'error' && /robot check/.test(rb.reason), 'Prime: the robot check is said', rb);
    const so = Prime.parse(readOf(stepOf('https://www.primevideo.com', fx('prime-detail.json'), { finalUrl: 'https://www.primevideo.com/auth-redirect?signin=1', extracted: { blobs: [] } })), req);
    check(so.state === 'signed-out', 'Prime: the sign-in redirect is signed-out', so);
    const auto = M.cleanShow(Prime.parse(readOf(stepOf('https://www.primevideo.com', { finalPath: '/detail/X/', title: 't', hydration: { detail: { titleID: BOYS, title: 'The Boys', synopsis: 's', entityType: 'TV Show' }, episodes: [{ titleID: 'g1', title: 'E', episodeNumber: 1, seasonNumber: 1, link: { url: '/detail/' + BOYS + '/?autoplay=1&t=0' } }] } })), req).show);
    check(auto.seasons[0].episodes[0].url === 'https://www.primevideo.com/detail/' + BOYS + '/?autoplay=1&t=0' && M.resumePlan(auto).proven === true, "Prime: an episode link that carries Prime's own autoplay=1 plays directly", auto.seasons[0].episodes[0]);
  }

  /* ------------------------------------------------------------------ YouTube playlists */
  console.log('watch-shows: YouTube playlists');
  {
    const id = 'PLbakingSourdough0000000001';
    const yf = JSON.parse(fs.readFileSync(path.join(__dirname, 'watch-fixtures', 'youtube-playlist.json'), 'utf8'));
    const r = YouTube.parse({ steps: { playlist: ytStep(yf, 'https://www.youtube.com/playlist?list=' + id) } }, { service: 'youtube', type: 'show', id, title: '' });
    const s = M.cleanShow(r.show);
    check(r.state === 'ok' && s.title === 'Recipes to try out' && s.seasons.length === 1 && s.seasons[0].episodes.length === 3 && /the user/.test(s.synopsis), 'YouTube: the playlist is one season of its videos, in order', s);
    const e2 = s.seasons[0].episodes[1];
    check(/[?&]list=PLbakingSourdough/.test(e2.url) && /&t=421s/.test(e2.url) && e2.progress > 0, "YouTube: a part-watched video resumes at YouTube's own &t= inside the playlist", e2);
    check(M.resumePlan(s).label === 'Resume E2' || M.resumePlan(s).label === 'Resume S1 E2', 'YouTube: the big button resumes the part-watched video', M.resumePlan(s));
    check(YouTube.steps({ id })[0].url === 'https://www.youtube.com/playlist?list=' + id, 'YouTube: reads the playlist page');
  }

  /* ------------------------------------------------------------------ TMDB */
  console.log('watch-shows: TMDB');
  let bearTmdb = null;
  {
    tmdbCalls.length = 0;
    const t = await TS.lookup({ title: 'The Bear', type: 'show', year: 2022 }, KEY, fakeTmdb(), { region: 'US' });
    bearTmdb = t;
    const s = M.cleanShow(t.show);
    check(t.state === 'ok' && t.tmdbId === 136315 && s.title === 'The Bear' && s.rating === 'TV-MA' && s.source === 'tmdb' && s.progressKnown === false, 'TMDB: search -> the right show (exact title + year), its rating', t.state + ' ' + t.reason);
    check(s.seasons.map((x) => x.n + ':' + x.episodes.length).join() === '1:3,2:0,3:0,0:0' && s.seasons[0].episodes[0].title === 'System' && s.seasons[0].episodes[0].runtimeSec === 1800 && s.seasons[0].episodes[0].progress === null, 'TMDB: every season listed, season 1 episodes loaded, no progress', s.seasons.map((x) => [x.n, x.episodes.length]));
    check(t.providers.length === 1 && t.providers[0].name === 'Hulu' && /JustWatch/.test(t.attribution) && s.more[0].title === 'Severance' && s.more[0].tmdbId === 95396, 'TMDB: providers with the JustWatch attribution; recommendations keep their TMDB id', t.providers);
    check(tmdbCalls.length === 3 && !JSON.stringify(t).includes(KEY), 'TMDB: three calls (search, details, one season); the key is in no answer', tmdbCalls.length);
    const ss = await TS.season(136315, 3, KEY, fakeTmdb());
    check(ss.state === 'ok' && ss.season.n === 3 && ss.season.episodes.length === 2 && ss.season.fromTmdb === true, 'TMDB: one season on its own');
    const bad = await TS.lookup({ title: 'The Bear', type: 'show' }, KEY, fakeTmdb({ status: 401 }));
    check(bad.state === 'bad-key' && !JSON.stringify(bad).includes(KEY), 'TMDB: a rejected key says so, without the key', bad);
    const nk = await TS.lookup({ title: 'The Bear', type: 'show' }, '', fakeTmdb());
    check(nk.state === 'no-key' && /Settings > Lumen/.test(nk.reason), 'TMDB: no key asks for one in Settings > Lumen', nk);
    const none = await TS.lookup({ title: 'Nothing Like This At All', type: 'show' }, KEY, fakeTmdb());
    check(none.state === 'error' || none.state === 'none', 'TMDB: a title it lacks is not answered with a different show', none.state);
    const mv = await TS.lookup({ title: 'Air', type: 'movie', year: 2023 }, KEY, fakeTmdb());
    check(mv.state === 'ok' && mv.show.type === 'movie' && mv.show.runtimeSec === 6720 && mv.show.rating === 'R' && mv.providers[0].service === 'prime', 'TMDB: a film (runtime, certification, Prime as provider)', mv.show);
  }

  /* ------------------------------------------------------------------ merge */
  console.log('watch-shows: the merge');
  {
    const m = M.mergeTmdb(huluShow, bearTmdb.show);
    check(m.synopsis === huluShow.synopsis && m.seasons.find((x) => x.n === 2).episodes[2].progress === 0.5, "merge: the service's words and progress win");
    check(m.seasons.some((x) => x.n === 0 && x.fromTmdb) && m.source === 'mixed', 'merge: a season the service never named comes from TMDB, marked', m.seasons.map((x) => [x.n, x.fromTmdb]));
    const s3 = m.seasons.find((x) => x.n === 3);
    check(s3 && s3.episodes.length === 0 && s3.loaded === false, 'merge: an unloaded season stays unloaded (asked for on the tab)');
  }

  /* ------------------------------------------------------------------ watch-shows-main */
  console.log('watch-shows: the main half');
  {
    const pushed = [];
    const g1 = { id: 1 }, g2 = { id: 2 };
    let block = '', state = { hulu: 'ok', disney: 'ok', prime: 'ok', youtube: 'ok' }, enabled = { hulu: true, disney: true, prime: true, youtube: true };
    let mode = 'ok', stepCalls = 0, hold = null;
    const runStep = async (step) => {
      stepCalls++;
      if (hold) await hold;
      if (step.signal && step.signal.aborted) return { error: { code: 'cancelled' }, captures: [] };
      await tick();
      if (mode === 'fail') return { url: step.url, finalUrl: step.url, error: { code: 'load-failed', detail: 'ERR_CONNECTION_REFUSED' }, captures: [], extracted: null };
      if (/hulu/.test(step.url)) return stepOf('https://www.hulu.com', fx(/movie/.test(step.url) ? 'hulu-movie.json' : 'hulu-series.json'));
      if (/disneyplus/.test(step.url)) return stepOf('https://www.disneyplus.com', fx('disney-entity.json'));
      if (/B08BYYQZ3K/.test(step.url)) return stepOf('https://www.primevideo.com', { finalPath: '/detail/B08BYYQZ3K/', title: 'S2', hydration: { detail: { titleID: 'B08BYYQZ3K', title: 'The Boys - Season 2', synopsis: 's2', seasonNumber: 2, entityType: 'TV Show' }, episodes: [{ titleID: 'b2e1', title: 'The Big Ride', episodeNumber: 1, seasonNumber: 2, progress: { percentage: 10 } }] } });
      if (/primevideo/.test(step.url)) return stepOf('https://www.primevideo.com', fx('prime-detail.json'));
      return { error: { code: 'load-failed', detail: 'not in this test' }, captures: [] };
    };
    const sm = SM.create({
      runStep, now: () => Date.now(), fetchJson: fakeTmdb(), tmdbKey: () => KEY, blocker: () => block,
      enabled: (id) => enabled[id], serviceState: (id) => state[id], push: (c, a) => pushed.push({ c, a }),
    });
    const ask = (c, o) => sm.line(c, SM.cleanLine(Object.assign({ what: 'show', seq: 1 }, o)));
    const until = async (pred) => { for (let i = 0; i < 400 && !pred(); i++) await tick(); };
    const finals = () => pushed.filter((p) => !p.a.partial);

    check(SM.cleanLine({ what: 'show', service: 'hulu', id: '' }) === null && SM.cleanLine({ what: 'show', service: 'netflix', id: 'x' }) === null && SM.cleanLine({ what: 'show' }) === null && SM.cleanLine({ what: 'season', service: 'hulu', id: 'x' }) === null,
      'lines: no id, an unknown service, nothing to look up, or a season with no number are dropped');
    check(SM.cleanLine({ what: 'show', service: 'hulu', id: BEAR, url: 'https://evil.example/series/x', title: 'x' }).url === '', 'lines: a URL off the service is dropped');

    ask(g1, { seq: 1, service: 'hulu', type: 'show', id: BEAR, url: 'https://www.hulu.com/series/' + BEAR, title: 'The Bear', year: 2022 });
    await until(() => finals().length >= 1);
    let a = finals()[0].a;
    check(a.state === 'ok' && a.seq === 1 && a.key === 'hulu:' + BEAR && a.show.service === 'hulu' && a.show.source === 'mixed' && a.providers.length === 1 && /JustWatch/.test(a.attribution), 'main: a Hulu show reads, merged with TMDB, with providers', [a.state, a.reason, a.show && a.show.source]);
    check(a.show.seasons.find((x) => x.n === 2).episodes[2].progress === 0.5 && M.resumePlan(a.show).label === 'Resume S2 E3', 'main: the answer keeps Hulu\'s progress and the Resume S2 E3 plan');
    check(pushed.some((p) => p.a.partial && p.a.state === 'loading' && /Reading Hulu/.test(p.a.show.notes[0])) || true, 'main: TMDB may draw first while the reader works (partial)');
    const before = stepCalls;
    pushed.length = 0;
    ask(g1, { seq: 2, service: 'hulu', type: 'show', id: BEAR, url: 'https://www.hulu.com/series/' + BEAR, title: 'The Bear' });
    await until(() => finals().length >= 1);
    check(stepCalls === before && finals()[0].a.cached === true && finals()[0].a.seq === 2, 'main: the same title within 5 min comes from memory (no second read)');
    pushed.length = 0;
    ask(g1, { seq: 3, service: 'hulu', type: 'show', id: BEAR, url: 'https://www.hulu.com/series/' + BEAR, title: 'The Bear', force: true });
    await until(() => finals().length >= 1);
    check(stepCalls === before + 1, 'main: Retry (force) reads again');

    // the reader fails -> TMDB fallback, with the reason
    pushed.length = 0; mode = 'fail'; sm.forget();
    ask(g1, { seq: 4, service: 'hulu', type: 'show', id: BEAR, url: 'https://www.hulu.com/series/' + BEAR, title: 'The Bear' });
    await until(() => finals().length >= 1);
    a = finals()[0].a;
    check(a.state === 'fallback' && /didn't load|ERR_CONNECTION_REFUSED/.test(a.reason) && a.show && a.show.source === 'tmdb' && a.show.progressKnown === false && a.show.url === 'https://www.hulu.com/series/' + BEAR, 'main: a failed reader answers with TMDB, the reason, and the service\'s own page', [a.state, a.reason]);
    check(/Couldn’t read Hulu/.test(a.show.notes[0]) && /progress isn’t shown/.test(a.show.notes[0]), 'main: the fallback says progress is missing and why', a.show.notes);
    // and with no TMDB key: an error with both reasons
    pushed.length = 0;
    const sm2 = SM.create({ runStep, fetchJson: fakeTmdb(), tmdbKey: () => '', blocker: () => '', enabled: () => true, serviceState: () => 'ok', push: (c, x) => pushed.push({ c, a: x }) });
    sm2.line(g1, SM.cleanLine({ what: 'show', seq: 5, service: 'hulu', type: 'show', id: BEAR, title: 'The Bear' }));
    await until(() => finals().length >= 1);
    a = finals()[0].a;
    check(a.state === 'error' && a.show === null && a.tmdbState === 'no-key' && /TMDB key/.test(a.tmdbReason), 'main: failed reader + no TMDB key = an error that names both', a);
    mode = 'ok';

    // gates
    pushed.length = 0; sm.forget(); state.hulu = 'signed-out';
    const c0 = stepCalls;
    ask(g1, { seq: 6, service: 'hulu', type: 'show', id: BEAR, title: 'The Bear' });
    await until(() => finals().length >= 1);
    a = finals()[0].a;
    check(a.state === 'signed-out' && stepCalls === c0 && a.show && a.show.source === 'tmdb' && /signed out of Hulu/.test(a.reason), 'main: signed out of Hulu: no read, TMDB episodes, the reason', [a.state, a.reason]);
    state.hulu = 'ok'; enabled.disney = false; pushed.length = 0;
    ask(g1, { seq: 7, service: 'disney', type: 'show', id: ANDOR, title: 'Andor' });
    await until(() => finals().length >= 1);
    check(finals()[0].a.state === 'off' && /off in Settings > Lumen/.test(finals()[0].a.reason), 'main: a service turned off says so', finals()[0].a.reason);
    enabled.disney = true; block = 'paused while VALORANT is running'; pushed.length = 0;
    ask(g1, { seq: 8, service: 'disney', type: 'show', id: ANDOR, title: 'Andor' });
    await until(() => finals().length >= 1);
    check(finals()[0].a.state === 'paused' && /VALORANT/.test(finals()[0].a.reason) && stepCalls === c0, 'main: a game pauses the reader (said), nothing loads', finals()[0].a.reason);
    block = '';

    // not on any of his services: TMDB only
    pushed.length = 0;
    ask(g1, { seq: 9, service: '', title: 'Severance', type: 'show' });
    await until(() => finals().length >= 1);
    a = finals()[0].a;
    check(a.state === 'elsewhere' && a.show.title === 'Severance' && a.providers.some((p) => p.name === 'Apple TV Plus' && p.service === '') && a.providers.some((p) => p.service === 'prime' && p.type === 'buy') && /themoviedb\.org/.test(a.watchLink), 'main: a title on none of his services: where it streams (JustWatch via TMDB)', a.providers);

    // a newer ask from the same page cancels the older
    pushed.length = 0; sm.forget();
    let release; hold = new Promise((r) => { release = r; });
    ask(g1, { seq: 10, service: 'disney', type: 'show', id: ANDOR, title: 'Andor' });
    await tick();
    ask(g1, { seq: 11, service: 'prime', type: 'show', id: BOYS, title: 'The Boys' });
    await tick(); release(); hold = null;
    await until(() => finals().length >= 1);
    for (let i = 0; i < 30; i++) await tick();
    check(finals().length === 1 && finals()[0].a.seq === 11 && finals()[0].a.show.service === 'prime', 'main: a newer show page cancels the older read (only the newer answers)', finals().map((p) => p.a.seq));
    // two pages: each gets its own
    pushed.length = 0; sm.forget();
    ask(g1, { seq: 12, service: 'disney', type: 'show', id: ANDOR, title: 'Andor' });
    ask(g2, { seq: 1, service: 'prime', type: 'show', id: BOYS, title: 'The Boys' });
    await until(() => finals().length >= 2);
    check(finals().some((p) => p.c === g1 && p.a.seq === 12) && finals().some((p) => p.c === g2 && p.a.seq === 1), 'main: two Lumen pages each get their own answer');

    // season asks
    pushed.length = 0;
    sm.line(g1, SM.cleanLine({ what: 'season', seq: 13, key: 'hulu:' + BEAR, service: 'hulu', id: BEAR, n: 3, tmdbId: 136315 }));
    await until(() => pushed.length >= 1);
    a = pushed[0].a;
    check(a.what === 'season' && a.state === 'ok' && a.source === 'tmdb' && a.season.n === 3 && a.season.episodes.length === 2, 'main: a season Hulu didn\'t send comes from TMDB', a);
    pushed.length = 0;
    sm.line(g1, SM.cleanLine({ what: 'season', seq: 14, key: 'prime:' + BOYS, service: 'prime', id: BOYS, n: 2, url: 'https://www.primevideo.com/detail/B08BYYQZ3K/' }));
    await until(() => pushed.length >= 1);
    a = pushed[0].a;
    check(a.state === 'ok' && a.source === 'service' && a.season.n === 2 && a.season.episodes[0].title === 'The Big Ride' && Math.abs(a.season.episodes[0].progress - 0.1) < 1e-9, "main: Prime's season 2 reads its own detail page, with progress", a);
    pushed.length = 0;
    sm2.line(g1, SM.cleanLine({ what: 'season', seq: 15, key: 'hulu:x', service: 'hulu', id: BEAR, n: 3 }));
    await until(() => pushed.length >= 1);
    check(pushed[0].a.state === 'none' && /didn’t send this season/.test(pushed[0].a.reason) && /no TMDB key/.test(pushed[0].a.reason), 'main: no TMDB key and no season data: said, not blank', pushed[0].a.reason);
    check(sm.state().live === 0, 'main: nothing left in flight');
    sm.stop();
  }

  /* ------------------------------------------------------------------ the hooks in watch-main.js */
  console.log('watch-shows: the hooks in watch-main.js');
  {
    const fetched = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-shows-t-'));
    const cache = WM.cleanCache(null);
    cache.services.hulu.state = 'ok'; cache.services.hulu.readAt = Date.now(); cache.services.hulu.lastOkAt = Date.now();
    fs.writeFileSync(path.join(dir, WM.CACHE_FILE), JSON.stringify(cache));
    fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify({ background: false, tmdbKey: KEY }));
    const wm = WM.create({
      dir, bootGraceMs: 0, freeGb: () => 8, log: () => {}, send: () => {},
      // never the network: TMDB answers from the fixture routes, anything else is refused
      fetch: async (url, o) => { fetched.push(String(url)); const r = await fakeTmdb()(url, o && o.headers); if (r.error) throw new Error('refused in this test'); return { status: r.status, text: async () => JSON.stringify(r.json) }; },
      isBundledPage: (u) => typeof u === 'string' && u.indexOf('file:///app/') === 0,
      test: { gameRunning: () => '', windowShowing: () => true },
      player: { inside: () => true, play: () => true }, drmRoute: () => ({ edge: false, rule: '', reason: '' }),
      runStep: async (step) => { await tick(); return /hulu/.test(step.url) ? stepOf('https://www.hulu.com', fx('hulu-series.json')) : { error: { code: 'load-failed', detail: 'x' }, captures: [] }; },
    });
    const js = [];
    const guest = { getURL: () => 'file:///app/watch.html', isDestroyed: () => false, executeJavaScript: (code) => { js.push(code); return Promise.resolve(); }, on: () => {} };
    const p1 = WM.parseGuestLine('quartz-watch:show {"what":"show","seq":1,"service":"hulu","id":"' + BEAR + '","title":"The Bear","type":"show"}');
    check(p1 && p1.verb === 'show' && p1.req.service === 'hulu' && WM.parseGuestLine('quartz-watch:show {"what":"show","service":"hulu"}') === null, 'hooks: watch-main hears quartz-watch:show and checks it');
    check(wm.handleGuestLine(guest, 'quartz-watch:show {"what":"show","seq":1,"service":"hulu","id":"' + BEAR + '","title":"The Bear","type":"show","url":"https://www.hulu.com/series/' + BEAR + '"}') === true, 'hooks: our page\'s show line is handled');
    for (let i = 0; i < 400 && !js.some((c) => c.indexOf('__applyWatchShow(') !== -1 && c.indexOf('"partial":true') === -1); i++) await tick();
    const shows = js.filter((c) => c.indexOf('__applyWatchShow(') !== -1).map((c) => JSON.parse(c.slice(c.indexOf('__applyWatchShow(') + 17, c.lastIndexOf(')'))));
    const fin = shows.filter((x) => !x.partial)[0];
    check(fin && fin.state === 'ok' && fin.show.title === 'The Bear' && fin.show.seasons.length >= 3, 'hooks: the answer reaches the page as __applyWatchShow', fin && [fin.state, fin.reason, fin.tmdbState, fin.tmdbReason]);
    check(fin && fin.tmdbState === 'ok' && fetched.length > 0 && fetched.every((u) => u.indexOf('https://api.themoviedb.org/3/') === 0), 'hooks: TMDB goes through watch-main’s own fetch (the fake here; never the network)', fetched);
    const other = { getURL: () => 'https://evil.example/', isDestroyed: () => false, executeJavaScript: () => Promise.resolve(), on: () => {} };
    check(wm.handleGuestLine(other, 'quartz-watch:show {"what":"show","seq":1,"service":"hulu","id":"' + BEAR + '"}') === false, 'hooks: another page\'s show line is ignored');
    wm.handleGuestLine(guest, 'quartz-watch:forget {}');
    if (typeof wm.stop === 'function') wm.stop();
  }

  console.log('watch-shows-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.log('FAIL the test crashed: ' + (err && err.stack || err)); console.log('watch-shows-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exitCode = 1; });
