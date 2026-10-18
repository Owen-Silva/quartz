'use strict';
// watch-find-harness.js -- Lumen's one search box without Electron: the merge and ranking
// (watch/find.js), the three search readers against their fixtures (watch/search/*.js), the main
// half driven by fakes (watch-find-main.js: one reader at a time, signed-in first, the cache,
// cancel, failures said, Retry), and the hooks in watch-main.js (the find verb, YouTube channels,
// TMDB's where-to-watch page in the layer). Fixtures only: no network, no account.
//   node watch-find-harness.js      ->  "watch-find: N passed, M failed"
const fs = require('fs');
const os = require('os');
const path = require('path');
const Find = require('./watch/find');
const FindMain = require('./watch-find-main');
const WM = require('./watch-main');
const FX = require('./tests/watch-find-fixtures');
const D = require('./watch/search/disney');
const H = require('./watch/search/hulu');
const P = require('./watch/search/prime');
const YtCh = require('./watch/search/youtube');

let passed = 0, failed = 0;
function check(ok, name, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 20); i++) await tick(); }

/* ---- a read answered from the fixtures, as runStep would ---- */
function stepFor(svc, q, mode) {
  const m = mode || 'ok';
  if (m === 'down') return { ok: false, url: '', finalUrl: '', captures: [], error: { code: 'offline', detail: 'net::ERR_INTERNET_DISCONNECTED' } };
  if (svc === 'disney') {
    if (m === 'signed-out') return { ok: true, finalUrl: 'https://www.disneyplus.com/login', extracted: { url: 'https://www.disneyplus.com/login', login: true }, captures: [] };
    return { ok: true, finalUrl: D.searchUrl(q), extracted: { url: D.searchUrl(q), login: false }, captures: [
      { url: 'https://disney.api.edge.bamgrid.com/explore/v1.7/search', status: 200, json: FX.disneyLanding() },
      { url: 'https://disney.api.edge.bamgrid.com/explore/v1.7/search?query=' + encodeURIComponent(q), status: 200, json: FX.disney(q) }] };
  }
  if (svc === 'hulu') {
    if (m === 'signed-out') return { ok: true, finalUrl: 'https://auth.hulu.com/web/login?next=%2Fsearch', extracted: { url: '', login: true }, captures: [] };
    if (m === 'moved') return { ok: true, finalUrl: 'https://www.disneyplus.com/browse/hulu', extracted: {}, captures: [] };
    return { ok: true, finalUrl: H.searchUrl(q), extracted: { url: H.searchUrl(q), login: false }, captures: [
      { url: 'https://discover.hulu.com/content/v5/search/entity?search_query=' + encodeURIComponent(q), status: 200, json: FX.hulu(q) }] };
  }
  const pr = FX.prime(q, { signedOut: m === 'signed-out' });
  if (m === 'robot') return { ok: true, finalUrl: 'https://www.primevideo.com/errors/validateCaptcha', extracted: { robot: true }, captures: [] };
  return { ok: true, finalUrl: P.searchUrl(q), extracted: { url: P.searchUrl(q), hydration: JSON.stringify(pr.hydration), store: JSON.stringify(pr.store), complete: true }, captures: [] };
}
const svcOfUrl = (u) => (/disneyplus/.test(u) ? 'disney' : /hulu/.test(u) ? 'hulu' : /primevideo/.test(u) ? 'prime' : '?');
const qOfUrl = (u) => { const m = /[?&](?:q|phrase)=([^&]*)/.exec(u); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; };

(async () => {
  console.log('watch-find: merge and ranking');
  {
    const q = 'the bear';
    const read = (svc) => (svc === 'disney' ? D : svc === 'hulu' ? H : P).parse({ steps: { search: stepFor(svc, q) } });
    const services = { disney: read('disney'), hulu: read('hulu'), prime: read('prime') };
    const tmdbAns = await require('./watch/tmdb').search(q, 'k3y', async (u) => {
      if (/search\/multi/.test(u)) return { status: 200, json: FX.tmdbSearch(q), error: null };
      const m = /\/(movie|tv)\/(\d+)\/watch\/providers/.exec(u);
      return { status: 200, json: FX.tmdbProviders(m[1], m[2]), error: null };
    }, { region: 'US' });
    check(tmdbAns.state === 'ok' && tmdbAns.results.length === 3, 'fixture: TMDB answers 3 titles for "the bear"', tmdbAns.state);
    const local = FX.cache(1).services.hulu.items.concat(FX.cache(1).services.disney.items);
    const ytHtml = fs.readFileSync(path.join(__dirname, 'tests', 'watch-fixtures', 'youtube-search.html'), 'utf8');
    const yt = { state: 'ok', items: require('./watch/shape').cleanItems(require('./watch/adapters/youtube').parseSearch(ytHtml), 20), channels: YtCh.parseChannels(ytHtml) };
    const signedIn = { disney: true, hulu: true };
    const m = Find.merge({ q, services, youtube: yt, tmdb: tmdbAns, local, signedIn });
    const bear = m.best[0];
    check(bear && bear.title === 'The Bear', 'rank: the exact title is the best match', m.best.map((g) => g.title));
    check(bear && bear.chips.map((c) => c.service).join() === 'hulu,disney,prime', 'chips: one per service; signed-in first, the one with his progress leading', bear && bear.chips.map((c) => c.service + ':' + c.offer));
    check(bear && bear.resume && bear.progress === 0.4 && bear.chips[0].url === local[0].url, 'Resume: his Hulu Keep Watching (40 %) is on the tile and its chip opens his episode', bear && { resume: bear.resume, p: bear.progress, url: bear.chips[0].url });
    check(bear && bear.chips.find((c) => c.service === 'prime').offer === 'rent', "offer: Prime's own word (rent or buy) beats TMDB's", bear && bear.chips.find((c) => c.service === 'prime'));
    check(m.best.filter((g) => g.title === 'The Bear').length === 1, 'group: a title on three services is ONE tile');
    const pad2 = m.best.find((g) => g.title === 'The Bear and the Fox');
    check(pad2 && pad2.chips.length === 0 && pad2.elsewhere.join() === 'Netflix' && /themoviedb\.org\/movie\/346648\/watch/.test(pad2.watchLink), "TMDB: a title none of his services returned shows where it is (Netflix) and TMDB's where-to-watch link", pad2);
    const brother = m.best.find((g) => g.title === 'Brother Bear');
    check(brother && brother.chips.length === 1 && brother.chips[0].source === 'service', "TMDB's Disney+ for Brother Bear folds into Disney+'s own chip", brother && brother.chips);
    const hunt = m.rows[0].tiles.find((t) => t.title === 'The Bear Hunt');
    check(hunt && hunt.offer === 'upgrade' && Find.offerWord(hunt.offer) === 'Not in your plan', "offer: a Disney+ upsell tile says 'Not in your plan'", hunt);
    check(m.rows.map((r) => r.service).join() === 'disney,hulu,prime' && m.rows[0].tiles.map((t) => t.title).join('|') === FX.DISNEY['the bear'].map((t) => t.title).join('|'), "rows: each service's own results, in its own order, verbatim");
    check(m.rows.find((r) => r.service === 'hulu').tiles[0].resume === true, "row: Hulu's own The Bear tile says Resume");
    check(m.youtube.state === 'ok' && m.youtube.videos.length >= 3 && m.youtube.channels.length === 1, 'YouTube: videos and a channel', { v: m.youtube.videos.length, c: m.youtube.channels.length });
    check(m.pending === 0, 'nothing pending once every part answered');
    const idx = (t) => m.best.findIndex((g) => g.title === t);
    check(idx('The Bear') < idx('Brother Bear') && idx('Brother Bear') !== -1, 'rank: "The Bear" before "Brother Bear"', m.best.map((g) => g.title));
    // partial: only Hulu has answered so far
    const part = Find.merge({ q, services: { hulu: services.hulu, disney: { state: 'loading' }, prime: { state: 'queued' } }, youtube: { state: 'loading' }, local, signedIn });
    check(part.best.length >= 1 && part.best[0].title === 'The Bear' && part.pending === 3, 'speed: the first answer draws at once; three parts still pending', { best: part.best.map((g) => g.title), pending: part.pending });
    const failRow = Find.merge({ q, services: { disney: services.disney, hulu: { state: 'error', reason: 'timed out after 15 s' }, prime: { state: 'signed-out', reason: 'sign in' } } });
    check(failRow.rows[1].state === 'error' && failRow.rows[1].reason === 'timed out after 15 s' && failRow.rows[2].state === 'signed-out' && failRow.rows[0].tiles.length === 4, 'one service failing and one signed out: their rows say so, the others still show');
    const remake = Find.merge({ q: 'dune', services: { disney: { state: 'ok', items: [{ id: 'disney:d1', service: 'disney', title: 'Dune', url: 'https://www.disneyplus.com/browse/entity-dune1984x', year: 1984 }] }, prime: { state: 'ok', items: [{ id: 'prime:d2', service: 'prime', title: 'Dune', url: 'https://www.primevideo.com/detail/B0DUNE2021/', year: 2021, offer: 'rent' }] } } });
    check(remake.best.length === 2, 'group: two titles with one name, 37 years apart, stay two tiles', remake.best.map((g) => g.title + ' ' + g.year));
    check(Find.titleKey('The Bear (2022)') === Find.titleKey('Bear, The'.replace(/, The$/, '')) && Find.matchScore('The Bear', 'the bear') === 100 && Find.matchScore('Grizzly Man', 'the bear') === 0, 'matchScore / titleKey basics');
    const r1 = Find.remember(['Bluey', 'the bear', 'x'], 'The Bear', 3);
    check(r1.join('|') === 'The Bear|Bluey|x', 'recent searches: newest first, no repeats, capped', r1);
    const empty = Find.merge({ q: 'zzz', services: { disney: { state: 'ok', items: [] } }, youtube: { state: 'ok', items: [], channels: [] } });
    check(empty.rows[0].state === 'empty' && empty.youtube.state === 'empty' && empty.best.length === 0, 'empty answers are "empty", not errors');
  }

  console.log('watch-find: the search readers');
  {
    const p = (R, step) => R.parse({ steps: { search: step } });
    check(p(D, stepFor('disney', 'the bear')).items.every((i) => i.title !== 'Trending Decoy'), "Disney+: the search page's own trending landing is never taken for results");
    check(p(D, stepFor('disney', 'x', 'signed-out')).state === 'signed-out', 'Disney+: a /login landing is signed out');
    check(p(D, Object.assign(stepFor('disney', 'the bear'), { captures: [{ url: 'https://x/explore/v1.7/search?query=a', status: 401, json: {} }] })).state === 'signed-out', 'Disney+: a 401 search answer is signed out');
    const off = p(D, stepFor('disney', 'x', 'down'));
    check(off.state === 'error' && /offline/.test(off.reason), 'Disney+: offline says so', off.reason);
    check(p(D, stepFor('disney', 'nothing here')).state === 'empty', 'Disney+: a query with no results is empty');
    check(p(H, stepFor('hulu', 'x', 'signed-out')).state === 'signed-out', 'Hulu: auth.hulu.com is signed out');
    check(/inside Disney\+/.test(p(H, stepFor('hulu', 'x', 'moved')).reason), 'Hulu: sent to Disney+ says Hulu plays inside Disney+');
    check(p(P, stepFor('prime', 'the bear', 'signed-out')).state === 'signed-out', 'Prime Video: a signed-out store is "sign in to search"');
    check(/robot check/.test(p(P, stepFor('prime', 'x', 'robot')).reason), 'Prime Video: the robot check is said');
    const steps = [D.steps('the bear')[0], H.steps('the bear')[0], P.steps('the bear')[0]];
    check(steps.every((s) => s.type === 'view' && s.name === 'search' && s.budgetMs <= 15000) && /disneyplus\.com\/search\?q=the%20bear$/.test(steps[0].url) && /hulu\.com\/search\?q=the%20bear$/.test(steps[1].url) && /phrase=the%20bear/.test(steps[2].url), 'each reader loads its service\'s own search page, in the hidden reader, 15 s at most', steps.map((s) => s.url));
    const ch = YtCh.parseChannels('<script>var ytInitialData = {"contents":[{"channelRenderer":{"channelId":"UCabcdefghijklmnopqrstuv","title":{"simpleText":"Chef"},"navigationEndpoint":{"browseEndpoint":{"canonicalBaseUrl":"/@chef"}},"thumbnail":{"thumbnails":[{"url":"//yt3.ggpht.com/abc=s88"}]},"videoCountText":{"simpleText":"1.2M subscribers"}}}]};</script>');
    check(ch.length === 1 && ch[0].url === 'https://www.youtube.com/@chef' && ch[0].subs === '1.2M subscribers' && ch[0].image === 'https://yt3.ggpht.com/abc=s88', 'YouTube channels: handle URL, avatar, the field that says subscribers', ch);
  }

  console.log('watch-find: the main half, with fakes');
  {
    let t = 1000000;
    const calls = [];
    const logs = [];
    let concurrent = 0, maxConcurrent = 0;
    const mode = { disney: 'ok', hulu: 'ok', prime: 'ok' };
    const holds = [];
    let hold = false;
    const states = { disney: 'ok', hulu: 'ok', prime: 'never' };
    const enabledMap = { disney: true, hulu: true, prime: true };
    let block = '';
    const yt = []; const tm = [];
    const pushed = [];
    const make = () => FindMain.create({
      now: () => t, log: (l) => logs.push(l), gapMs: 0, sleep: () => tick(),
      push: (c, part) => pushed.push(Object.assign({ to: c }, JSON.parse(JSON.stringify(part)))),
      enabled: (id) => enabledMap[id], serviceState: (id) => states[id], blocker: () => block, epoch: () => 0,
      youtube: async (q) => { yt.push(q); return { ok: true, state: 'ok', items: [{ id: 'youtube:v', service: 'youtube', kind: 'search', title: 'A video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }], channels: [] }; },
      tmdb: async (q) => { tm.push(q); return { state: 'no-key', reason: 'Add a free TMDB key', results: [] }; },
      runStep: async (step) => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        const svc = svcOfUrl(step.url);
        calls.push(svc + ':' + qOfUrl(step.url));
        if (hold) await new Promise((r) => { holds.push(r); if (step.signal) step.signal.addEventListener('abort', r, { once: true }); });
        await tick();
        concurrent--;
        if (step.signal && step.signal.aborted) return { error: { code: 'cancelled', detail: 'cancelled' }, captures: [] };
        return stepFor(svc, qOfUrl(step.url), mode[svc]);
      },
    });
    let fm = make();
    const g1 = { id: 'g1' }, g2 = { id: 'g2' };
    await fm.run('the bear', 1, g1);
    const mine = pushed.filter((p) => p.to === g1 && p.seq === 1);
    const start = mine[0];
    check(start && start.kind === 'start' && start.order.join() === 'disney,hulu,prime', 'order: the services he is signed into read first', start && start.order);
    check(calls.join() === 'disney:the bear,hulu:the bear,prime:the bear', 'one read per service per search, each with what he typed', calls);
    check(maxConcurrent === 1, 'one hidden reader at a time', maxConcurrent);
    const kinds = mine.map((p) => p.kind + (p.service ? ':' + p.service + ':' + p.answer.state : ''));
    check(kinds.indexOf('youtube') !== -1 && kinds.indexOf('youtube') < kinds.indexOf('service:prime:ok') && kinds[kinds.length - 1] === 'done', 'speed: YouTube answers before the last reader, every part on its own push, then done', kinds);
    check(mine.filter((p) => p.kind === 'service' && p.answer.state === 'ok').length === 3 && mine.find((p) => p.service === 'prime' && p.answer.state === 'ok').answer.items[0].offer === 'rent', 'each service answer carries its items and their offers');
    // the cache
    calls.length = 0; pushed.length = 0;
    t += 4 * 60 * 1000;
    await fm.run('The Bear ', 2, g1);
    const c2 = pushed.find((p) => p.kind === 'start');
    check(calls.length === 0 && ['disney', 'hulu', 'prime'].every((id) => c2.services[id].cached === true && c2.services[id].state === 'ok'), 'cache: the same search within 5 min reads no service again', { calls, s: c2 && c2.services });
    t += 2 * 60 * 1000;
    await fm.run('the bear', 3, g1);
    check(calls.length === 3, 'cache: after 5 min each service is read again', calls);
    // signed out / off: not read
    calls.length = 0; pushed.length = 0;
    states.hulu = 'signed-out'; enabledMap.prime = false;
    await fm.run('bluey', 4, g1);
    const s4 = pushed.find((p) => p.kind === 'start');
    check(calls.join() === 'disney:bluey' && s4.services.hulu.state === 'signed-out' && s4.services.prime.state === 'off', 'a signed-out service is not read (it says sign in); an off one is not read', { calls, s: s4.services });
    states.hulu = 'ok'; enabledMap.prime = true;
    // one failing, the others still answer; the log never names the query
    calls.length = 0; pushed.length = 0; mode.prime = 'down';
    await fm.run('cocaine bear', 5, g1);
    const pr = pushed.filter((p) => p.service === 'prime').pop();
    check(pr.answer.state === 'error' && /offline/.test(pr.answer.reason) && pushed.filter((p) => p.kind === 'service' && p.answer.state === 'ok').length === 2, 'one service failing says why; the others still answer', pr.answer);
    check(logs.some((l) => /search on Prime Video failed/.test(l)) && !logs.some((l) => /cocaine/i.test(l)), 'a failure is logged, never with what he searched for', logs);
    mode.prime = 'ok';
    // Retry one service
    calls.length = 0; pushed.length = 0; yt.length = 0;
    await fm.run('cocaine bear', 5, g1, { only: 'prime', force: true });
    check(calls.join() === 'prime:cocaine bear' && yt.length === 0 && pushed.filter((p) => p.service === 'prime').pop().answer.state === 'ok', 'Retry reads that one service again, nothing else', { calls, yt });
    // a newer search cancels the one in flight
    calls.length = 0; pushed.length = 0; hold = true;
    const first = fm.run('alpha', 6, g1);
    await settle(5);
    const second = fm.run('beta', 7, g1);
    await settle(5);
    hold = false; holds.splice(0).forEach((r) => r());
    await Promise.all([first, second]);
    await settle(10);
    check(!pushed.some((p) => p.seq === 6 && (p.kind === 'service' && p.answer.state !== 'loading')) && pushed.some((p) => p.seq === 7 && p.kind === 'done'), 'a newer search cancels the one in flight: no late answer for it', pushed.filter((p) => p.seq === 6).map((p) => p.kind + ':' + (p.answer ? p.answer.state : '')));
    check(calls[0] === 'disney:alpha' && calls.filter((c) => /alpha/.test(c)).length === 1, 'the cancelled search read no further service', calls);
    // two pages: still one reader at a time
    calls.length = 0; maxConcurrent = 0;
    await Promise.all([fm.run('gamma', 8, g1), fm.run('delta', 9, g2)]);
    check(maxConcurrent === 1 && calls.length === 6, 'two Lumen pages searching: still one hidden reader at a time', { maxConcurrent, calls });
    // paused
    calls.length = 0; pushed.length = 0; block = 'paused while VALORANT is running';
    await fm.run('epsilon', 10, g1);
    check(calls.length === 0 && pushed.filter((p) => p.kind === 'service' && p.answer.state === 'paused' && /VALORANT/.test(p.answer.reason)).length === 3 && pushed.some((p) => p.kind === 'youtube'), 'a game pauses the hidden readers (said, with why); YouTube still answers');
    block = '';
    fm.forget();
    check(fm.state().cache === 0, 'Forget empties the search cache');
    fm.stop();
  }

  console.log('watch-find: the hooks in watch-main.js');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-find-h-'));
    fs.writeFileSync(path.join(dir, WM.CACHE_FILE), JSON.stringify(FX.cache(Date.now())));
    fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify({ background: false }));
    const ytHtml = fs.readFileSync(path.join(__dirname, 'tests', 'watch-fixtures', 'youtube-search.html'), 'utf8');
    const sent = [], logs = [], plays = [];
    const wm = WM.create({
      dir, bootGraceMs: 0, freeGb: () => 8, log: (l) => logs.push(l), send: (ch, p) => sent.push([ch, p]),
      isBundledPage: (u) => typeof u === 'string' && u.indexOf('file:///app/') === 0,
      test: { gameRunning: () => '', windowShowing: () => true, findGapMs: 0 },
      player: { inside: () => true, play: (o) => { plays.push(o); return true; } },
      drmRoute: () => ({ edge: false, rule: '', reason: '' }),
      runStep: async (step) => {
        await tick();
        if (step.type === 'fetch') return { ok: true, url: step.url, status: 200, text: ytHtml, captures: [] };
        if (step.name === 'search') return stepFor(svcOfUrl(step.url), qOfUrl(step.url));
        return { ok: false, error: { code: 'load-failed', detail: 'not in this test' }, captures: [] };
      },
    });
    const pushedJs = [];
    const guest = { getURL: () => 'file:///app/watch.html', isDestroyed: () => false, executeJavaScript: (code) => { pushedJs.push(code); return Promise.resolve(); }, on: () => {} };
    check(WM.parseGuestLine('quartz-watch:find {"q":"the bear","seq":2}').verb === 'find' && WM.parseGuestLine('quartz-watch:find {"q":"","seq":2}') === null && WM.parseGuestLine('quartz-watch:find {"q":"x","seq":1,"only":"evil"}').only === '', 'the find verb is validated (no empty query, only a known service)');
    wm.handleGuestLine(guest, 'quartz-watch:find {"q":"the bear","seq":2}');
    for (let i = 0; i < 200 && !pushedJs.some((c) => /"kind":"done"/.test(c)); i++) await tick();
    const finds = pushedJs.filter((c) => c.indexOf('__applyWatchFind(') !== -1).map((c) => JSON.parse(c.slice(c.indexOf('__applyWatchFind(') + 17, -1)));
    const ytPart = finds.find((p) => p.kind === 'youtube');
    check(finds.length >= 8 && finds[finds.length - 1].kind === 'done', 'watch-main answers a find with one push per part, then done', finds.map((p) => p.kind + (p.service ? ':' + p.service : '')));
    check(ytPart && ytPart.answer.ok && ytPart.answer.channels.length === 1, "YouTube's answer carries the channels from the same results page", ytPart && ytPart.answer.channels);
    check(finds.filter((p) => p.kind === 'service' && p.answer.state === 'ok').length === 3, 'all three services answered from their search readers');
    check(wm.state().find && wm.state().find.cache === 3, 'their answers are in the 5-minute memory cache', wm.state().find);
    wm.handleGuestLine(guest, 'quartz-watch:open {"url":"https://www.themoviedb.org/movie/346648/watch?locale=US"}');
    await settle(10);
    check(plays.length === 1 && /themoviedb\.org\/movie\/346648\/watch/.test(plays[0].url) && !sent.some((s) => s[0] === 'open-url'), "TMDB's where-to-watch page opens in the Lumen layer, not a tab", { plays, sent: sent.map((s) => s[0]) });
    check(logs.some((l) => /^Lumen: a TMDB where-to-watch page opened in the player layer: /.test(l)), 'quartz.log: the TMDB open has its line');
    wm.handleGuestLine(guest, 'quartz-watch:forget {}');
    check(wm.state().find.cache === 0, 'Forget empties the find cache too');
    wm.stop && wm.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }

  console.log('watch-find: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.log('watch-find: harness crashed: ' + (err && err.stack || err)); console.log('watch-find: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
