'use strict';
// tests/watch-merge-test.js -- watch/merge.js: one tile per title across services (mergeSame), the
// rows by intent, and the dense fixture (tests/watch-snapshot.js dense) at the user's real counts.
// Run by watch-harness.js (section 4) with its check(); alone: node tests/watch-merge-test.js
const Shape = require('../watch/shape');
const Merge = require('../watch/merge');
const F = require('./watch-snapshot');

function item(service, kind, title, subtitle, extra) {
  const host = { youtube: 'https://www.youtube.com/watch?v=', disney: 'https://www.disneyplus.com/browse/entity-', prime: 'https://www.primevideo.com/detail/', espn: 'https://www.espn.com/watch/player/_/id/' }[service];
  const id = (title + '-' + (subtitle || '')).replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 30);
  return Shape.cleanItem(Object.assign({ service, kind, title, subtitle: subtitle || '', url: host + id, id: service + ':' + kind + id }, extra || {}));
}
function rowsOf(list) {
  const services = {};
  for (const id of Shape.SERVICE_IDS) services[id] = { enabled: true, state: 'ok', items: list.filter((it) => it.service === id) };
  return Merge.buildRows(services);
}

module.exports = async function (check) {
  // 1. the key: same folded title AND the same year, Disney+ and Prime only
  check(Merge.sameKey(item('prime', 'rec', 'The Martian', '2015 · PG-13')) === 'the martian|2015', 'sameKey: title and year');
  check(Merge.sameKey(item('prime', 'rec', 'Bluey', '3 seasons')) === '', 'sameKey: no year, no key (a match would be a guess)');
  check(Merge.sameKey(item('youtube', 'rec', 'The Martian', 'Trailers 2015')) === '', 'sameKey: a year inside a channel name is not a release year');
  check(Merge.sameKey(item('prime', 'rec', 'X', 'S20151 E2')) === '', 'sameKey: digits inside a word are not a year');
  check(Merge.sameKey({ service: 'hulu', kind: 'rec', title: 'Shogun', subtitle: 'Drama', year: 2024, url: 'https://www.hulu.com/series/shogun' }) === 'shogun|2024', 'sameKey: any service, and the service\'s own year first');
  check(Merge.sameKey(Object.assign(item('disney', 'rec', 'Up', '2009 · PG'), { year: '2010' })) === 'up|2010', 'sameKey: item.year wins over the subtitle');

  // a film and a show of one name and year stay apart when both say what they are
  const film = Object.assign(item('disney', 'rec', 'Fargo', '1996'), { type: 'movie' });
  const show = Object.assign(item('prime', 'rec', 'Fargo', '1996'), { type: 'show' });
  const kept = Merge.mergeSame([film, show]);
  check(kept.length === 2 && !kept[0].also, 'mergeSame: a film and a show of the same name and year are two tiles', kept.map((x) => x.type));
  const film2 = Object.assign(item('prime', 'rec', 'Fargo', '1996 · R'), { type: 'movie' });
  const one = Merge.mergeSame([film, film2]);
  check(one.length === 1 && one[0].also && one[0].also[0].service === 'prime', 'mergeSame: two services, same film (type and year agree): one tile', one);

  // 2. Continue watching: the one he is watching keeps the tile, the other service is a mark
  const watching = item('prime', 'resume', 'The Martian', '2015 · PG-13', { progress: 0.4 });
  const offered = item('disney', 'rec', 'The Martian', '2015 · PG-13');
  let rows = rowsOf([watching, offered]);
  const cont = rows.find((r) => r.id === 'continue');
  check(cont && cont.items.length === 1 && cont.items[0].service === 'prime' && cont.items[0].url === watching.url, 'continue: the tile opens Prime, where he is watching it', cont && cont.items);
  check(cont && JSON.stringify(cont.items[0].also) === JSON.stringify([{ service: 'disney', url: offered.url }]), 'continue: Disney+ rides along as a mark', cont && cont.items[0].also);
  check(!rows.some((r) => r.id === 'foryou' && r.items.some((it) => it.title === 'The Martian')), 'for you: a title in Continue watching is not offered again');
  check(watching.also === undefined && offered.also === undefined, 'merge: the cache items are never changed (copies carry also)');

  // 3. For you: two services recommending the same film = one tile, both marks
  const a = item('disney', 'rec', 'Oppenheimer', '2023 · R'), b = item('prime', 'rec', 'Oppenheimer', '2023 · R');
  rows = rowsOf([a, b, item('prime', 'rec', 'Something else', '2020')]);
  const fy = rows.find((r) => r.id === 'foryou');
  const opp = fy ? fy.items.filter((it) => it.title === 'Oppenheimer') : [];
  check(opp.length === 1 && opp[0].service === 'disney' && opp[0].also.length === 1 && opp[0].also[0].service === 'prime', 'for you: one Oppenheimer tile with both marks', opp);

  // 4. Different years are different titles; no year = the old title de-dupe, no marks
  rows = rowsOf([item('prime', 'rec', 'Dune', '1984 · PG-13'), item('disney', 'rec', 'Dune', '2021 · PG-13')]);
  const dunes = rows.find((r) => r.id === 'foryou').items.filter((it) => it.title === 'Dune');
  check(dunes.length === 2 && dunes.every((it) => !it.also), 'for you: Dune 1984 and Dune 2021 stay two tiles', dunes.map((d) => d.subtitle));
  rows = rowsOf([item('prime', 'rec', 'Bluey', ''), item('disney', 'rec', 'Bluey', '')]);
  const blueys = rows.find((r) => r.id === 'foryou').items.filter((it) => it.title === 'Bluey');
  check(blueys.length === 1 && !blueys[0].also, 'for you: same title, no years: one tile as before, and no claim it is on both', blueys);

  // 5. Your list: one list across the services
  rows = rowsOf([item('youtube', 'watchlist', 'A talk', 'Channel'), item('prime', 'watchlist', 'A film', '2019')]);
  const wl = rows.find((r) => r.id === 'watchlist');
  check(wl && wl.title === 'Your list' && wl.items.length === 2, 'your list: YouTube Watch later and the watchlists in one row', wl);

  // 6. The dense fixture: the user's real counts, and the one deliberate cross-service title
  const d = F.dense(Date.now());
  const n = {};
  for (const it of d.items) n[it.service + ':' + it.kind] = (n[it.service + ':' + it.kind] || 0) + 1;
  check(n['youtube:resume'] === 3 && n['youtube:rec'] === 40 && n['youtube:watchlist'] === 17, 'dense: YouTube 3 resume, 40 picks, 17 watch later', n);
  check(n['disney:resume'] === 15 && n['disney:rec'] === 15 && n['prime:resume'] === 11 && n['prime:rec'] === 77, 'dense: Disney+ 15 + 15, Prime 11 + 77', n);
  check(d.sports.live.length === 2 && d.sports.soon.length === 11 && d.sports.done.length === 12, 'dense: ESPN 2 live, 11 upcoming, 12 finals', [d.sports.live.length, d.sports.soon.length, d.sports.done.length]);
  const merged = [];
  for (const r of d.rows) for (const it of r.items) if (it.also) merged.push(r.id + ':' + it.title + '+' + it.also.map((x) => x.service).join('+'));
  check(merged.length === 1 && merged[0] === 'continue:The Martian+disney', 'dense: exactly one merged tile, The Martian in Continue watching', merged);
};

if (require.main === module) {
  let p = 0, f = 0;
  module.exports((c, label, detail) => { if (c) p++; else { f++; console.log('FAIL ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } })
    .then(() => { console.log('watch-merge-test: ' + p + ' passed, ' + f + ' failed'); process.exit(f ? 1 : 0); });
}
