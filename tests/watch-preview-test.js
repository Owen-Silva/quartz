'use strict';
/*
 * tests/watch-preview-test.js -- the hover preview's pure parts: watch/preview.js (which video a
 * title previews, the embed URL, the player's messages, the Referer rule main.js applies) and
 * watch/tmdb.js trailer() against a FAKE fetchJson. Never touches the network or a real key.
 * Run by watch-harness.js (moduleTests): module.exports = async function (check).
 */
const Pv = require('../watch/preview');
const Tmdb = require('../watch/tmdb');

const KEY = '0123456789abcdef0123456789abcdef';
const T2 = { id: 280, media_type: 'movie', title: 'Terminator 2: Judgment Day', release_date: '1991-07-03' };

/** A fake fetchJson: `routes` maps a path test (RegExp) to { status, json } or an error. */
function fake(routes) {
  const calls = [];
  const f = async function (url) {
    calls.push(url);
    for (const [re, ans] of routes) if (re.test(url)) return typeof ans === 'function' ? ans(url) : ans;
    return { status: 404, json: { status_message: 'not found' }, error: null };
  };
  f.calls = calls;
  return f;
}

module.exports = async function (check) {
  // --- which video a title previews
  const yt = { id: 'youtube:dQw4w9WgXcQ', service: 'youtube', kind: 'rec', title: 'Song', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  let s = Pv.sourceFor(yt, {});
  check(s.type === 'youtube' && s.videoId === 'dQw4w9WgXcQ' && s.start === 0, 'sourceFor: a YouTube title previews itself', s);
  s = Pv.sourceFor(Object.assign({}, yt, { kind: 'resume', progress: 0.5, durationSec: 600 }), {});
  check(s.type === 'youtube' && s.start === 298, 'sourceFor: a YouTube resume starts where the user left off', s);
  check(Pv.sourceFor(Object.assign({}, yt, { kind: 'resume', progress: 0.99, durationSec: 600 }), {}).start === 0, 'sourceFor: a nearly finished one starts at the top');
  check(Pv.youtubeIdOf({ id: 'x', url: 'https://youtu.be/dQw4w9WgXcQ?t=3' }) === 'dQw4w9WgXcQ', 'youtubeIdOf: a youtu.be URL');
  check(Pv.youtubeIdOf({ id: 'youtube:short', url: 'https://www.youtube.com/watch?v=bad' }) === '', 'youtubeIdOf: a bad id is no id');
  check(Pv.youtubeIdOf({ id: 'x', url: 'https://evil.example/watch?v=dQw4w9WgXcQ' }) === '', 'youtubeIdOf: another site is no id');

  const prime = { id: 'prime:abc', service: 'prime', kind: 'rec', title: 'Terminator 2: Judgment Day', subtitle: '', url: 'https://www.primevideo.com/detail/abc' };
  s = Pv.sourceFor(prime, { hasTmdbKey: false });
  check(s.type === 'none' && /TMDB key in Settings > Lumen/.test(s.reason), 'sourceFor: Prime without a TMDB key says how to get trailers', s);
  s = Pv.sourceFor(prime, { hasTmdbKey: true });
  check(s.type === 'trailer' && s.title === prime.title && s.tv === false, 'sourceFor: Prime with a key asks for the trailer', s);
  s = Pv.sourceFor(Object.assign({}, prime, { service: 'disney', subtitle: 'S2 E4' }), { hasTmdbKey: true });
  check(s.type === 'trailer' && s.tv === true, 'sourceFor: an "S2 E4" subtitle looks for a series', s);
  s = Pv.sourceFor(Object.assign({}, prime, { also: [{ service: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] }), { hasTmdbKey: false });
  check(s.type === 'youtube' && s.videoId === 'dQw4w9WgXcQ', 'sourceFor: a merged title that is also on YouTube plays that', s);
  check(Pv.sourceFor(Object.assign({}, prime, { kind: 'live' }), { hasTmdbKey: true }).type === 'none', 'sourceFor: live has no trailer');
  s = Pv.sourceFor(null, { event: true });
  check(s.type === 'none' && /games/.test(s.reason), 'sourceFor: an ESPN game says why there is none', s);
  check(Pv.sourceFor(null, {}).type === 'none' && Pv.sourceFor('junk').type === 'none', 'sourceFor: junk never throws');

  // --- the embed
  const u = Pv.embedUrl('dQw4w9WgXcQ', 42);
  check(u.indexOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?') === 0, 'embedUrl: the privacy-enhanced embed', u);
  check(/[?&]mute=1(&|$)/.test(u) && /[?&]autoplay=1(&|$)/.test(u) && /[?&]controls=0(&|$)/.test(u), 'embedUrl: muted, autoplay, no controls', u);
  check(/[?&]loop=1(&|$)/.test(u) && /[?&]playlist=dQw4w9WgXcQ(&|$)/.test(u) && /[?&]start=42(&|$)/.test(u), 'embedUrl: loops, and starts where asked', u);
  check(Pv.embedUrl('"><script>', 0) === '' && Pv.embedUrl('', 0) === '', 'embedUrl: not an id -> no URL');
  check(!/start=/.test(Pv.embedUrl('dQw4w9WgXcQ', 0)), 'embedUrl: start 0 is left out');
  // the test mock's origin: a .invalid host (no network resolves it), and nothing else can be named
  check(/^https:\/\/[a-z0-9-]+\.invalid$/.test(Pv.MOCK_ORIGIN), 'MOCK_ORIGIN: a .invalid host', Pv.MOCK_ORIGIN);
  check(Pv.embedOrigin(true) === Pv.MOCK_ORIGIN && Pv.embedOrigin(false) === Pv.EMBED_ORIGIN && Pv.embedOrigin('yes') === Pv.EMBED_ORIGIN, 'embedOrigin: the mock only for a literal true');
  check(Pv.embedUrl('dQw4w9WgXcQ', 0, Pv.MOCK_ORIGIN).indexOf(Pv.MOCK_ORIGIN + '/embed/dQw4w9WgXcQ?') === 0, 'embedUrl: the mock origin when asked');
  check(Pv.embedUrl('dQw4w9WgXcQ', 0, 'https://evil.example').indexOf(Pv.EMBED_ORIGIN + '/embed/') === 0, 'embedUrl: any other origin falls back to the real embed host');
  check(Pv.embedReferer({ resourceType: 'subFrame', url: Pv.MOCK_ORIGIN + '/embed/dQw4w9WgXcQ', requestHeaders: {}, webContents: { getURL: () => 'file:///C:/q/watch.html' } }) === '', 'embedReferer: never for the mock origin');

  // --- the player's messages
  check(Pv.readPlayerMessage('{"event":"onStateChange","info":1}').playing === true, 'readPlayerMessage: playing');
  check(Pv.readPlayerMessage('{"event":"infoDelivery","info":{"playerState":1,"currentTime":3}}').playing === true, 'readPlayerMessage: infoDelivery playing');
  check(Pv.readPlayerMessage('{"event":"infoDelivery","info":{"currentTime":3}}') === null, 'readPlayerMessage: no state -> nothing');
  check(Pv.readPlayerMessage('{"event":"onError","info":153}').error === 153, 'readPlayerMessage: an error code');
  check(Pv.readPlayerMessage('not json') === null && Pv.readPlayerMessage(null) === null && Pv.readPlayerMessage('{bad') === null, 'readPlayerMessage: junk -> null');
  check(/outside YouTube/.test(Pv.errorWords(150)) && /153/.test(Pv.errorWords(153)) && /error 7/.test(Pv.errorWords(7)), 'errorWords: plain words per code');

  // --- the Referer main.js adds
  const wc = (url) => ({ getURL: () => url });
  const watchPage = 'file:///' + require('path').join(__dirname, '..', 'watch.html').replace(/\\/g, '/') + '?theme=dark';   // this checkout's own Watch page
  const emb = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1';
  check(Pv.embedReferer({ url: emb, resourceType: 'subFrame', requestHeaders: {}, webContents: wc(watchPage) }) === Pv.EMBED_REFERER, 'embedReferer: Watch\'s embed frame gets the Referer');
  check(Pv.embedReferer({ url: emb, resourceType: 'subFrame', requestHeaders: {}, webContents: wc('https://evil.example/watch.html') }) === '', 'embedReferer: a web page called watch.html gets none');
  check(Pv.embedReferer({ url: emb, resourceType: 'subFrame', requestHeaders: {}, webContents: wc('file:///C:/x/files.html') }) === '', 'embedReferer: another bundled page gets none');
  check(Pv.embedReferer({ url: emb, resourceType: 'subFrame', requestHeaders: { Referer: 'https://a.example/' }, webContents: wc(watchPage) }) === '', 'embedReferer: an existing Referer is kept');
  check(Pv.embedReferer({ url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', resourceType: 'subFrame', requestHeaders: {}, webContents: wc(watchPage) }) === '', 'embedReferer: only the nocookie embed');
  check(Pv.embedReferer({ url: emb, resourceType: 'mainFrame', requestHeaders: {}, webContents: wc(watchPage) }) === '', 'embedReferer: only a sub-frame');
  check(Pv.embedReferer({ url: emb, resourceType: 'subFrame', requestHeaders: {}, webContents: { getURL: () => { throw new Error('gone'); } } }) === '' && Pv.embedReferer(null) === '', 'embedReferer: never throws');

  // --- TMDB: pick and match
  check(Tmdb.pickTrailer([
    { site: 'YouTube', key: 'teaser00001', type: 'Teaser', official: true, iso_639_1: 'en' },
    { site: 'Vimeo', key: 'vimeo000001', type: 'Trailer', official: true },
    { site: 'YouTube', key: 'unofficial1', type: 'Trailer', official: false, iso_639_1: 'en' },
    { site: 'YouTube', key: 'official001', type: 'Trailer', official: true, iso_639_1: 'en', name: 'Official Trailer' },
  ]).key === 'official001', 'pickTrailer: an official YouTube trailer first');
  check(Tmdb.pickTrailer([{ site: 'YouTube', key: 'bad' }]) === null && Tmdb.pickTrailer(null) === null, 'pickTrailer: no usable video -> null');
  const hits = [{ id: 1, media_type: 'tv', name: 'Bluey' }, { id: 2, media_type: 'movie', title: 'Bluey' }, { id: 3, media_type: 'person', name: 'X' }];
  check(Tmdb.matchHit(hits, 'Bluey', true).tmdbId === 1 && Tmdb.matchHit(hits, 'bluey', false).tmdbId === 2, 'matchHit: an exact title, the series or the film as hinted');
  check(Tmdb.matchHit([{ id: 9, media_type: 'movie', title: 'Something Else' }], 'Bluey', false).tmdbId === 9 && Tmdb.matchHit([], 'x', false) === null, 'matchHit: no exact title -> the first hit; none -> null');

  // --- TMDB: trailer()
  let f = fake([[/\/search\/multi/, { status: 200, json: { results: [T2] }, error: null }],
    [/\/movie\/280\/videos/, { status: 200, json: { results: [{ site: 'YouTube', key: 'CRRlbK5w8AE', type: 'Trailer', official: true, iso_639_1: 'en' }] }, error: null }]]);
  let a = await Tmdb.trailer('Terminator 2: Judgment Day', { tv: false }, KEY, f);
  check(a.state === 'ok' && a.videoId === 'CRRlbK5w8AE', 'trailer: search then videos -> the YouTube id', a);
  check(f.calls.length === 2 && f.calls.every((c) => c.indexOf(KEY) !== -1), 'trailer: two reads, keyed', f.calls);
  f = fake([[/\/search\/multi/, { status: 200, json: { results: [T2] }, error: null }], [/\/videos/, { status: 200, json: { results: [] }, error: null }]]);
  a = await Tmdb.trailer('Terminator 2: Judgment Day', {}, KEY, f);
  check(a.state === 'none' && /no YouTube trailer/.test(a.reason) && !a.videoId, 'trailer: none on TMDB says so', a);
  f = fake([[/\/search\/multi/, { status: 200, json: { results: [] }, error: null }]]);
  a = await Tmdb.trailer('Nothing Like It', {}, KEY, f);
  check(a.state === 'none' && /nothing called/.test(a.reason), 'trailer: no match says so', a);
  f = fake([[/\/search\/multi/, { status: 401, json: { status_message: 'Invalid API key ' + KEY }, error: null }]]);
  a = await Tmdb.trailer('Terminator 2', {}, KEY, f);
  check(a.state === 'bad-key' && a.reason.indexOf(KEY) === -1, 'trailer: a rejected key, and the key never in the reason', a);
  f = fake([[/\/search\/multi/, { status: 0, json: null, error: { code: 'offline', detail: 'offline ' + KEY } }]]);
  a = await Tmdb.trailer('Terminator 2', {}, KEY, f);
  check(a.state === 'offline' && a.reason.indexOf(KEY) === -1, 'trailer: offline, key scrubbed', a);
  a = await Tmdb.trailer('Terminator 2', {}, '', f);
  check(a.state === 'bad-key' && /Settings > Lumen/.test(a.reason), 'trailer: no key says where to add one', a);
  a = await Tmdb.trailer('Terminator 2', {}, KEY, async () => { throw new Error('boom'); });
  check(a.state === 'error' || a.state === 'offline', 'trailer: a throwing fetch never throws', a);
};
