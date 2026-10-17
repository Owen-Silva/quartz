'use strict';
/*
 * tests/watch-adapter-espn.js -- fixture tests for watch/adapters/espn.js.
 * Pure node; required by tests/watch-harness.js:
 *   module.exports = async function (check) { ... }   check(cond, label, detail)
 */
var fs = require('fs');
var path = require('path');
var espn = require('../watch/adapters/espn');
var shape = require('../watch/shape');

var FX = path.join(__dirname, 'watch-fixtures');
function fx(name) { return JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8')); }

var NOW = Date.parse('2026-10-17T01:30:00Z');       // Fri 16 Oct, 6:30 PM PDT
var CTX = { now: NOW, tz: 'America/Los_Angeles', leagues: ['nhl', 'nfl'] };

function okStep(json, url) {
  return { ok: true, url: url || 'https://site.api.espn.com/x', finalUrl: url || 'https://site.api.espn.com/x', title: '', status: 200,
    extracted: null, json: json, text: null, captures: [], error: null };
}
function errStep(code, detail, status) {
  return { ok: false, url: 'https://site.api.espn.com/x', finalUrl: '', title: '', status: status || 0,
    extracted: null, json: null, text: null, captures: [], error: { code: code, detail: detail || '' } };
}
function fullRead() {
  return { now: NOW, steps: { nhl: okStep(fx('espn-nhl.json')), nfl: okStep(fx('espn-nfl.json')), watch: okStep(fx('espn-watch.json')) } };
}
function ids(list) { return list.map(function (x) { return x.id; }); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

module.exports = async function (check) {
  // ------------------------------------------------------------ fixtures
  ['espn-nhl.json', 'espn-nfl.json', 'espn-watch.json', 'espn-empty.json'].forEach(function (n) {
    var j = fx(n);
    check(typeof j._fixture === 'string' && j._fixture.indexOf('public JSON, shape from') === 0, 'espn fixture ' + n + ' has a _fixture note', j._fixture);
  });

  // ------------------------------------------------------------ steps
  var st = espn.steps(CTX);
  check(espn.id === 'espn', 'espn: adapter id');
  check(same(st.map(function (s) { return s.name; }), ['nhl', 'nfl', 'watch']), 'espn steps: one per league in ctx order, then watch', st.map(function (s) { return s.name; }));
  check(st[0].url === 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard', 'espn steps: NHL scoreboard url', st[0].url);
  check(st[1].url === 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', 'espn steps: NFL scoreboard url', st[1].url);
  check(st.every(function (s) { return s.type === 'fetch' && s.as === 'json' && s.optional === true; }), 'espn steps: all optional json fetches');
  check(st[2].url === 'https://watch.product.api.espn.com/api/product/v3/watchespn/web/home?lang=en&countryCode=US&tz=America%2FLos_Angeles',
    'espn steps: watch url carries the tz', st[2].url);
  var stDefault = espn.steps({ now: NOW });
  check(same(stDefault.map(function (s) { return s.name; }), shape.DEFAULT_LEAGUES.concat(['watch'])), 'espn steps: default leagues when ctx has none');
  var stBad = espn.steps({ leagues: ['nhl', 'curling', 'nhl', 7], tz: 'x"; drop' });
  check(same(stBad.map(function (s) { return s.name; }), ['nhl', 'watch']), 'espn steps: unknown + duplicate leagues dropped');
  check(/tz=America%2FLos_Angeles$/.test(stBad[1].url), 'espn steps: a junk tz falls back to Los Angeles', stBad[1].url);
  var stNone = espn.steps(null);
  check(Array.isArray(stNone) && stNone.length === shape.DEFAULT_LEAGUES.length + 1, 'espn steps(null) does not throw');

  // ------------------------------------------------------------ full parse
  var r = espn.parse(fullRead(), CTX);
  check(r.state === 'ok' && r.reason === '', 'espn full: state ok', r.reason);
  var evIds = ids(r.events);
  check(same(evIds, ['espn:401892517', 'espn:401772900', 'espn:401892518', 'espn:401892520', 'espn:401772902', 'espn:401772901',
    'espn:401892519', 'espn:401892516', 'espn:401772899']),
  'espn full: events ordered live, upcoming, final; NHL first in a tier; finals newest first', evIds);
  check(r.events.length === 9, 'espn full: 9 events (5 NHL + 4 NFL)', r.events.length);

  var bos = r.events[0];
  check(bos.state === 'in' && bos.league === 'nhl' && bos.leagueName === 'NHL', 'espn BOS@SEA: live NHL');
  check(bos.home.name === 'Seattle Kraken' && bos.home.abbr === 'SEA' && bos.away.name === 'Boston Bruins', 'espn BOS@SEA: home/away from homeAway', bos.home.name + ' / ' + bos.away.name);
  check(bos.home.score === '2' && bos.away.score === '1', 'espn BOS@SEA: scores', bos.home.score + '-' + bos.away.score);
  check(bos.home.record === '3-1-0' && bos.home.logo === 'https://a.espncdn.com/i/teamlogos/nhl/500/scoreboard/sea.png', 'espn BOS@SEA: record + logo');
  check(bos.detail === '12:31 - 2nd', 'espn BOS@SEA: detail from shortDetail', bos.detail);
  check(bos.startsAt === Date.parse('2026-10-17T01:00:00Z'), 'espn BOS@SEA: startsAt parses "2026-10-17T01:00Z"', bos.startsAt);
  check(same(bos.broadcasts, ['ESPN+', 'Hulu', 'KONG']), 'espn BOS@SEA: broadcasts + geoBroadcasts, de-duplicated', bos.broadcasts);
  check(bos.watchUrl === 'https://www.espn.com/watch/player?id=7f3e2a10-5c1d-4b9e-9a61-0d2c3b4a5e01', 'espn BOS@SEA: watchUrl joined by numeric eventId', bos.watchUrl);
  check(bos.locked === true && bos.edge === true, 'espn BOS@SEA: locked from isLocked, player opens in Edge');
  check(bos.gamecastUrl === 'https://www.espn.com/nhl/game/_/gameId/401892517/bruins-kraken', 'espn BOS@SEA: gamecast from the summary link', bos.gamecastUrl);

  var kc = r.events[1];
  check(kc.id === 'espn:401772900' && kc.home.name === 'Denver Broncos' && kc.away.name === 'Kansas City Chiefs', 'espn KC@DEN: homeAway honoured when away is listed first');
  check(kc.watchUrl === '' && kc.locked === null && kc.edge === false, 'espn KC@DEN: no airing -> no watchUrl, locked null');

  var van = r.events[2];
  check(van.state === 'pre' && van.home.score === '' && van.away.score === '', 'espn VAN@LA: scores blank before the game', van.home.score);
  check(van.watchUrl === 'https://www.espn.com/watch/player?id=1b9c4d22-8e7f-4a10-b3c2-7d6e5f4a3b02' && van.locked === false, 'espn VAN@LA: joined by string eventId, unlocked');

  var chi = r.events[3];
  check(chi.gamecastUrl === 'https://www.espn.com/nhl/game/_/gameId/401892520', 'espn CHI@DAL: no links -> gamecast built from the id', chi.gamecastUrl);
  check(chi.home.logo === 'https://a.espncdn.com/i/teamlogos/nhl/500/dal.png', 'espn CHI@DAL: logo from team.logos[0]', chi.home.logo);
  check(same(chi.broadcasts, []), 'espn CHI@DAL: empty broadcasts');

  var nyr = r.events[6];
  check(nyr.state === 'post' && nyr.detail === 'Final/OT' && nyr.home.score === '4', 'espn NYR@TOR: final with score');
  check(nyr.watchUrl === 'https://www.espn.com/watch/player?id=9a8b7c6d-5e4f-4321-a0b1-c2d3e4f5a604', 'espn NYR@TOR: final joins its replay airing', nyr.watchUrl);
  var edm = r.events[7];
  check(edm.gamecastUrl === 'https://www.espn.com/nhl/game/_/gameId/401892516', 'espn EDM@CGY: http gamecast refused, https one built', edm.gamecastUrl);

  // items
  var itIds = r.items.map(function (i) { return i.kind + ' ' + i.id; });
  check(same(itIds, [
    'live espn:401892517', 'live espn:401772900',
    'upcoming espn:401892518', 'upcoming espn:401772902',
    'replay espn:9a8b7c6d-5e4f-4321-a0b1-c2d3e4f5a604', 'replay espn:0d1e2f3a-4b5c-4d6e-8f70-81920a1b2c05', 'replay espn:5c4b3a29-1807-4f6e-9d5c-4b3a29180706'
  ]), 'espn items: live, upcoming within 36 h (boundary included), replays', itIds);
  var i0 = r.items[0];
  check(i0.title === 'Boston Bruins at Seattle Kraken', 'espn item: title "Away at Home"', i0.title);
  check(i0.subtitle === 'NHL · ESPN+, Hulu, KONG', 'espn item: subtitle league + broadcasts', i0.subtitle);
  check(i0.url === bos.watchUrl && i0.edge === true, 'espn item: live url = watchUrl (Edge)');
  check(i0.image === 'https://artwork.espncdn.com/events/401892517/16x9/1280x720_20261017010000.jpg', 'espn item: image from the watch listing', i0.image);
  check(i0.badge === 'Live' && i0.startsAt === bos.startsAt && i0.service === 'espn', 'espn item: Live badge, startsAt');
  var i1 = r.items[1];
  check(i1.url === 'https://www.espn.com/nfl/game/_/gameId/401772900/chiefs-broncos' && i1.edge === false && i1.image === '', 'espn item: no airing -> gamecast url, no image, plays in Quartz', i1.url);
  var i3 = r.items[3];
  check(i3.title === 'Jacksonville Jaguars at Los Angeles Rams' && i3.badge === 'NFL Net', 'espn item: upcoming badge is the first broadcast', i3.badge);
  check(!r.items.some(function (i) { return i.id === 'espn:401892520' || i.id === 'espn:401772901'; }), 'espn items: games beyond 36 h are events only');
  var rp = r.items[4];
  check(rp.title === 'New York Rangers at Toronto Maple Leafs' && rp.subtitle === 'NHL · ESPN+' && rp.badge === 'Replay', 'espn replay: joined title + subtitle', rp.title + ' | ' + rp.subtitle);
  check(r.items[5].image === 'https://artwork.espncdn.com/events/401772899/16x9/1280x720.jpg', 'espn replay: image from images[]', r.items[5].image);
  check(r.items[6].title === 'SportsCenter' && r.items[6].subtitle === 'Thursday night edition · ESPN', 'espn replay: unjoined listing keeps its own name', r.items[6].subtitle);
  check(!r.items.some(function (i) { return /c0ffee00/.test(i.id) || /^espn:(nhl|nfl)$/.test(i.id); }), 'espn items: unknown-event upcoming airings and league cards are not items');
  check(r.counts && r.counts.live === 2 && r.counts.final === 3 && r.counts.replays === 3, 'espn counts', r.counts);
  check(same(r.warnings, []), 'espn full: no warnings', r.warnings);
  var cleaned = shape.cleanResult(r);
  check(cleaned.state === 'ok' && cleaned.items.length === r.items.length && cleaned.events.length === r.events.length, 'espn full: survives shape.cleanResult unchanged in size');

  // NFL first when ctx says so
  var r2 = espn.parse(fullRead(), { now: NOW, leagues: ['nfl', 'nhl'] });
  check(r2.events[0].id === 'espn:401772900' && r2.items[0].id === 'espn:401772900', 'espn order follows ctx.leagues (NFL first when asked)', ids(r2.events).slice(0, 2));

  // leagues inferred from the read when ctx is missing
  var r3 = espn.parse(fullRead());
  check(r3.state === 'ok' && r3.events.length === 9, 'espn parse without ctx infers leagues and uses read.now', r3.events.length);

  // ------------------------------------------------------------ partial failures
  var rd = fullRead();
  rd.steps.nfl = errStep('timeout');
  var p1 = espn.parse(rd, CTX);
  check(p1.state === 'ok' && p1.events.length === 5, 'espn: one league failing still ok with the others', p1.events.length);
  check(p1.warnings.length === 1 && p1.warnings[0] === 'NFL: timed out after 20 s', 'espn: the failed league is named in warnings', p1.warnings);
  check(same(p1.counts.leaguesFailed, ['nfl']), 'espn: counts.leaguesFailed');

  rd = fullRead();
  rd.steps.watch = errStep('http', 'Service Unavailable', 503);
  var p2 = espn.parse(rd, CTX);
  check(p2.state === 'ok' && p2.events[0].watchUrl === '' && p2.items[0].url === 'https://www.espn.com/nhl/game/_/gameId/401892517/bruins-kraken',
    'espn: watch API down -> gamecast links', p2.items[0].url);
  check(p2.items.every(function (i) { return i.kind !== 'replay'; }), 'espn: watch API down -> no replays');
  check(p2.warnings.some(function (w) { return /ESPN Watch didn't answer \(HTTP 503\)/.test(w); }), 'espn: watch failure named', p2.warnings);

  rd = fullRead();
  delete rd.steps.watch;
  var p3 = espn.parse(rd, CTX);
  check(p3.state === 'ok' && p3.events.length === 9 && same(p3.warnings, []), 'espn: missing watch step is quiet');

  rd = fullRead();
  rd.steps.nhl = okStep({ sports: [], weird: true });
  var p4 = espn.parse(rd, CTX);
  check(p4.state === 'ok' && p4.events.length === 4 && /NHL: it came back in a shape/.test(p4.warnings[0]), 'espn: a league with no events array is a shape failure', p4.warnings);

  // empty day
  var e1 = espn.parse({ now: NOW, steps: { mlb: okStep(fx('espn-empty.json')) } }, { now: NOW, leagues: ['mlb'] });
  check(e1.state === 'ok' && e1.events.length === 0 && e1.items.length === 0 && e1.reason === '', 'espn: league with no games today is ok + empty');
  var e2 = espn.parse({ now: NOW, steps: { nhl: okStep(fx('espn-nhl.json')), mlb: okStep(fx('espn-empty.json')) } }, { now: NOW, leagues: ['nhl', 'mlb'] });
  check(e2.state === 'ok' && e2.events.length === 5, 'espn: empty league next to a busy one');

  // ------------------------------------------------------------ total failures
  var f1 = espn.parse({ now: NOW, steps: { nhl: errStep('offline'), nfl: errStep('offline'), watch: errStep('offline') } }, CTX);
  check(f1.state === 'error' && f1.reason === "you're offline", 'espn: all offline -> "you\'re offline"', f1.reason);
  var f2 = espn.parse({ now: NOW, steps: { nhl: errStep('timeout'), nfl: errStep('timeout') } }, CTX);
  check(f2.state === 'error' && f2.reason === "ESPN's scoreboard didn't answer (timed out after 20 s)", 'espn: all timed out', f2.reason);
  var f3 = espn.parse({ now: NOW, steps: { nhl: errStep('http', '', 500), nfl: errStep('timeout') } }, CTX);
  check(f3.state === 'error' && f3.reason === "ESPN's scoreboard didn't answer (NHL: HTTP 500; NFL: timed out after 20 s)", 'espn: mixed failures named per league', f3.reason);
  var f4 = espn.parse({ now: NOW, steps: {} }, CTX);
  check(f4.state === 'error' && f4.reason === "the reader didn't fetch any ESPN scoreboard", 'espn: no steps at all', f4.reason);
  var f5 = espn.parse({ now: NOW, steps: { nhl: okStep({ nope: 1 }), nfl: okStep([]) } }, CTX);
  check(f5.state === 'error' && /changed its API\?/.test(f5.reason), 'espn: every league in an unknown shape -> "changed its API?"', f5.reason);
  var f6 = espn.parse({ now: NOW, steps: { nhl: errStep('bad-json'), nfl: errStep('bad-json') } }, CTX);
  check(f6.state === 'error' && /not JSON/.test(f6.reason), 'espn: bad-json reason', f6.reason);
  check(Array.isArray(f1.items) && Array.isArray(f1.events), 'espn: error results still carry empty lists');
  check(shape.cleanResult(f2).reason === f2.reason, 'espn: error reason survives cleanResult');

  // ------------------------------------------------------------ junk never throws
  var junk = [undefined, null, 0, 'x', [], {}, { steps: null }, { steps: [] }, { steps: 'nhl' }, { steps: { nhl: 5, nfl: 'x', watch: [] } },
    { steps: { nhl: { ok: true, json: { events: [null, 1, 'x', {}, { competitions: 'no' }, { id: 1, competitions: [{ competitors: [null, {}] }] }] } } } },
    { steps: { nhl: { ok: true, json: { events: [{ id: '9', date: 'never', status: { type: { state: 'in' } }, competitions: [{ competitors: [{ homeAway: 'home', team: { displayName: 'A' } }, { homeAway: 'away', team: { displayName: 'B' } }] }] }] } },
      watch: { ok: true, json: { page: { buckets: [{ contents: [{ id: 'bad id with spaces', eventId: 9, status: 'live' }, { id: { x: 1 } }, null] }] } } } } }];
  var threw = 0;
  var allShaped = true;
  junk.forEach(function (j) {
    try {
      var out = espn.parse(j, j === undefined ? undefined : CTX);
      if (!out || ['ok', 'error'].indexOf(out.state) === -1 || !Array.isArray(out.items)) allShaped = false;
    } catch (err) { threw++; }
  });
  check(threw === 0, 'espn: junk inputs never throw', threw);
  check(allShaped, 'espn: junk inputs always give a state and items');
  var big = { now: NOW, steps: { nhl: okStep({ events: [] }), watch: okStep(deep(5000)) } };
  var bigOut;
  try { bigOut = espn.parse(big, CTX); } catch (err) { bigOut = null; }
  check(bigOut && bigOut.state === 'ok', 'espn: a 5000-deep watch payload does not throw');
  var cyclic = { events: [] }; cyclic.self = cyclic;
  var cy;
  try { cy = espn.parse({ now: NOW, steps: { nhl: okStep(cyclic), watch: okStep(cyclic) } }, CTX); } catch (err) { cy = null; }
  check(cy && cy.state === 'ok', 'espn: a cyclic payload does not hang or throw');
  var noDate = espn.parse(junk[11], CTX);
  check(noDate.state === 'ok' && noDate.events.length === 0, 'espn: an event with no parseable date is dropped by cleanEvent');
};

function deep(n) {
  var root = {};
  var cur = root;
  for (var i = 0; i < n; i++) { cur.next = { id: 'n' + i }; cur = cur.next; }
  return root;
}
