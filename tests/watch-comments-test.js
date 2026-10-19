// tests/watch-comments-test.js -- Lumen's own YouTube comments (watch-comments.js), the pure parts, no Electron, no
// network: YouTube's answers on the local fixtures (tests/comments-fixtures.js) in both shapes (entity mutations and
// the older commentRenderer), the header's count and sorts, links (safe, unwrapped, the right kind), the comments
// section of the page's data (a token, turned off, none), the words for every state (never empty), merge, and the
// in-page script: self-contained, it reads the page's own data and makes the page's OWN request (same origin, POST
// /youtubei/v1/next, the page's context) on a fake window.
// One summary line: "watch-comments-test: N passed, M failed".
'use strict';
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'watch-comments'));
const X = require('./comments-fixtures');
const VID = 'pvTest00001';

/* ---- the first page (entity shape) --------------------------------------------------------------- */
const p1 = C.parse(X.next({ continuation: X.FIRST }, '', VID).json, VID);
check(p1.known && p1.reload, 'the first answer is recognised as a new list');
check(p1.header && p1.header.countText === '1,234 Comments' && p1.header.count === 1234, 'the header count', p1.header);
check(p1.header.sorts.length === 2 && p1.header.sorts[0].label === 'Top' && p1.header.sorts[0].selected && p1.header.sorts[1].label === 'Newest' && p1.header.sorts[1].token === X.T.new1,
  'Top / Newest, with their tokens and which is on', p1.header.sorts);
check(p1.items.length === 20 && p1.next === X.T.top2, '20 comments and the next page’s token', { n: p1.items.length, next: p1.next });
const c1 = p1.items[0];
check(c1.id === 'UgxTop001' && c1.author === '@quietglyph' && /^data:image\/svg\+xml/.test(c1.avatar) && /days ago/.test(c1.time), 'comment 1: id, author, avatar, time', c1);
check(c1.text === X.C1_TEXT && c1.likes === '2.4K' && c1.liked === false, 'comment 1: the text verbatim and its likes', { text: c1.text, likes: c1.likes });
check(c1.pinned && c1.hearted && c1.replies === 3 && c1.repliesToken === 'CM-REP-UgxTop001', 'comment 1: pinned, hearted, 3 replies with their token', c1);
const links = c1.segs.filter((s) => s.link);
check(links.length === 3, 'comment 1 has three links', links);
check(links[0].text === '1:05' && links[0].link.kind === 'time' && links[0].link.t === 65, 'a timestamp in this video seeks (t=65)', links[0]);
check(links[1].link.kind === 'web' && links[1].link.href === 'https://example.com/notes', 'YouTube’s /redirect is unwrapped to where it goes', links[1]);
check(links[2].link.kind === 'yt' && links[2].link.href === 'https://www.youtube.com/@jumpingpixel', 'a mention opens the channel (YouTube: in Lumen)', links[2]);
check(c1.segs.map((s) => s.text).join('') === X.C1_TEXT, 'the segments add up to the text exactly');
check(c1.segs.some((s) => !s.link && s.text.indexOf('<img src=x') >= 0), 'markup in a comment is plain text, never a link or a tag');
check(p1.items[1].creator && /edited/.test(p1.items[1].time), 'comment 2: the creator, and "(edited)" kept in its time');
check(p1.items[4].verified, 'comment 5: verified');
check(C.long(p1.items[2]) && !C.long(p1.items[1]), 'a long comment clamps (Read more); a short one doesn’t');

/* ---- the next pages ---------------------------------------------------------------------------------- */
const p2 = C.parse(X.next({ continuation: X.T.top2 }, '', VID).json, VID);
check(p2.known && !p2.reload && !p2.header && p2.items.length === 20 && p2.items[0].id === 'UgxTop021' && p2.next === X.T.top3, 'page 2 appends 20 more and the next token', { n: p2.items.length, next: p2.next });
const p3 = C.parse(X.next({ continuation: X.T.top3 }, '', VID).json, VID);
check(p3.known && p3.items.length === 10 && p3.next === '' && p3.items[0].author === '@frame_by_frame', 'page 3 (the older commentRenderer shape): 10, and no next', { n: p3.items.length, a: p3.items[0] && p3.items[0].author });
check(p3.items[0].likes && p3.items[0].text.indexOf('Top comment 41') === 0, 'the older shape has its likes and text');
const nw = C.parse(X.next({ continuation: X.T.new1 }, '', VID).json, VID);
check(nw.reload && nw.header.sorts[1].selected && nw.items[0].text.indexOf('Newest comment 1') === 0 && nw.next === X.T.new2, 'Newest: a new list, Newest on, its own first comment');
const list = [];
check(C.merge(list, p1.items) === 20 && C.merge(list, p1.items) === 0 && C.merge(list, p2.items) === 20 && list.length === 40, 'merge never repeats a comment');

/* ---- replies ------------------------------------------------------------------------------------------ */
const r1 = C.parse(X.next({ continuation: 'CM-REP-UgxTop001' }, '', VID).json, VID);
check(r1.known && r1.items.length === 2 && r1.items[0].id === 'UgxTop001.r1' && r1.items[0].replyLevel === 1 && r1.next === 'CM-REP-UgxTop001-2', 'replies: two, then "Show more replies"', r1);
const r2 = C.parse(X.next({ continuation: 'CM-REP-UgxTop001-2' }, '', VID).json, VID);
check(r2.items.length === 1 && r2.next === '', 'the rest of the replies, and no more');

/* ---- the section in the page's data ----------------------------------------------------------------- */
const wd = (variant) => {
  const json = X.next({ videoId: VID }, variant, VID).json;
  return C.section(json);
};
check(wd('').state === 'token' && wd('').token === X.FIRST, 'the page’s data has the first token');
check(wd('off').state === 'off' && /turned off/i.test(wd('off').message), 'comments turned off: YouTube’s own words', wd('off'));
check(wd('none').state === 'none', 'no comments section at all: "none"');
check(C.section(null).state === 'none' && C.section({}).state === 'none', 'junk data: none, never a throw');
const empty = C.parse(X.next({ continuation: X.FIRST }, 'empty', VID).json, VID);
check(empty.known && empty.items.length === 0 && empty.header.count === 0 && empty.header.countText === '0 Comments', 'no comments yet: a known answer with zero');
check(!C.parse({ error: { code: 500 } }, VID).known && !C.parse(null).known, 'an error answer is not recognised (the chrome says so)');

/* ---- words, links, images, numbers ----------------------------------------------------------------- */
['loading', 'off', 'none', 'empty', 'offline', 'failed'].forEach((s) => {
  const w = C.words(s, {});
  check(!!w.title && !!w.why, 'state "' + s + '" has a title and a reason', w);
});
check(C.words('signedout').why.indexOf('signed out') >= 0, 'signed out says so');
check(C.words('failed', { reason: 'YouTube answered 500' }).why === 'Lumen couldn’t load comments: YouTube answered 500.', 'a failed load names the reason');
check(C.words('off', { message: 'Comments are turned off. Learn more' }).why.indexOf('Learn more') < 0, 'YouTube’s "Learn more" is dropped from its words');
check(C.linkOf('javascript:alert(1)') === null && C.linkOf('data:text/html,x') === null && C.linkOf('file:///C:/x') === null, 'only http(s) links: javascript:, data:, file: are text');
check(C.linkOf('https://www.youtube.com/redirect?q=javascript%3Aalert(1)') === null, 'a redirect to javascript: is text too');
check(C.linkOf('/watch?v=abc&t=1m5s', 'abc').kind === 'time' && C.linkOf('/watch?v=abc&t=1m5s', 'abc').t === 65 && C.linkOf('/watch?v=other&t=5', 'abc').kind === 'yt', 'a timestamp only seeks in this video');
check(C.linkOf('https://youtu.be/abc?t=30', 'abc').kind === 'time', 'youtu.be timestamps too');
check(C.safeImg('javascript:x') === '' && C.safeImg('http://x/a.jpg') === '' && C.safeImg('//yt3.ggpht.com/a') === 'https://yt3.ggpht.com/a', 'avatars: https or data:image only');
check(C.num('1.2K') === 1200 && C.num('3') === 3 && C.num('1,234') === 1234 && C.num('') === 0, 'counts read');
check(C.countLabel('1') === '1 Comment' && C.countLabel('12') === '12 Comments' && C.countLabel('') === 'Comments', 'the count has its word');
check(/^html\[data-lumen-pv\]\[data-lumen-cm\]/.test(C.PAGE_CSS) && /visibility: hidden !important/.test(C.PAGE_CSS) && /pointer-events: none !important/.test(C.PAGE_CSS),
  'the page CSS is inert until the flags, and YouTube’s own section stays invisible and unclickable');

/* ---- the in-page script ---------------------------------------------------------------------------- */
const fetches = [];
const yd = X.next({ videoId: VID }, '', VID).json;
yd.currentVideoEndpoint = { watchEndpoint: { videoId: VID } };
const win = {
  location: { href: 'https://www.youtube.com/watch?v=' + VID, origin: 'https://www.youtube.com', pathname: '/watch' },
  ytInitialData: yd,
  ytcfg: { d: { LOGGED_IN: true, INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.x' } }, INNERTUBE_CLIENT_VERSION: '2.x', INNERTUBE_CONTEXT_CLIENT_NAME: 1 }, get(k) { return this.d[k]; } },
  fetch: (url, o) => { fetches.push({ url, o }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(X.next(JSON.parse(o.body), '', VID).json) }); },
  setTimeout, clearTimeout, URL, Promise, JSON, Date, Math, Event: function () {}, AbortController,
};
win.window = win;
win.document = { cookie: '', documentElement: { setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; } }, querySelector() { return null; }, querySelectorAll() { return []; } };
const ctx = vm.createContext(win);
(async () => {
  try {
    vm.runInContext(C.call('state'), ctx);
    check(!!win.__lumenCm && win.__lumenCm.v === 1, 'the in-page script installs by itself in a bare page');
    const f = await vm.runInContext(C.call('first'), ctx);
    check(f.ok && f.from === 'ytInitialData' && f.signedIn === true && C.section(f.data).token === X.FIRST, 'first(): the token from the page’s own ytInitialData, and signed in', f);
    const l = await vm.runInContext(C.call('load', [X.FIRST]), ctx);
    const req = fetches[0];
    const body = req ? JSON.parse(req.o.body) : {};
    check(!!req && req.url === '/youtubei/v1/next?prettyPrint=false' && req.o.method === 'POST' && req.o.credentials === 'same-origin', 'load(): the page’s own same-origin POST /youtubei/v1/next', req && { url: req.url, m: req.o.method });
    check(body.continuation === X.FIRST && body.context && body.context.client.clientName === 'WEB' && !/key=/.test(req.url), 'with the page’s own context and the token; no API key', body);
    check(req.o.headers['X-Youtube-Client-Version'] === '2.x' && !req.o.headers.Authorization, 'the page’s client headers (no cookie here: no Authorization)', req.o.headers);
    check(l.ok && C.parse(l.json, VID).items.length === 20, 'the answer comes back whole for the chrome to parse');
    win.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: 'someOther' } } };
    const moved = await vm.runInContext(C.call('first'), ctx);
    check(moved.ok && moved.from === 'next' && JSON.parse(fetches[1].o.body).videoId === VID, 'moved in place (stale ytInitialData): the page’s own /next for this video', moved);
    win.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const bad = await vm.runInContext(C.call('load', ['x']), ctx);
    check(!bad.ok && bad.reason === 'YouTube answered 503', 'a failed answer comes back with its reason', bad);
    win.ytcfg.d.LOGGED_IN = false;
    const so = await vm.runInContext(C.call('press', ['like', { id: 'UgxTop001' }]), ctx);
    check(!so.ok && /signed out/.test(so.reason), 'signed out: nothing is pressed, and it says why', so);
  } catch (e) {
    check(false, 'the in-page script ran', String(e && e.stack || e));
  }
  console.log('watch-comments-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
