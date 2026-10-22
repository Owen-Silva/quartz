// tests/watch-playview-test.js -- Lumen's playback view's pure parts, no Electron, no network:
//   watch-playview.js:      which pages it boxes, the trim CSS (inert until the page's flag, the player
//                           never hidden, the ad UI and dialogs kept), episode words, the info's model
//                           (page first, item as the fallback, never invented), the reasons a button is off,
//                           and the in-page script (self-contained; it installs in a bare page);
//   watch-playview-main.js: "When a video plays" (default Lumen view, saved, junk refused), the TEST-only
//                           window seam, and the chrome-only IPC;
//   watch-player-yt.js:     the bar's "Full page" button defers to the view, and is as before without it.
// One summary line: "watch-playview-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const PV = require(path.join(ROOT, 'watch-playview'));
const Main = require(path.join(ROOT, 'watch-playview-main'));

/* ---- pageKind / boxedFor ------------------------------------------------------------------------ */
const K = (u, s) => PV.pageKind(u, s);
check(K('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube') === 'watch', 'a YouTube watch page is a video');
check(K('https://www.youtube.com/watch', 'youtube') === 'other', 'a /watch with no v is not');
check(K('https://youtu.be/dQw4w9WgXcQ', 'youtube') === 'watch' && K('https://www.youtube.com/live/abcDEF12345', 'youtube') === 'watch', 'youtu.be and /live/ are videos');
check(K('https://www.youtube.com/shorts/abcDEF12345', 'youtube') === 'shorts' && K('https://www.youtube.com/embed/abcDEF12345', 'youtube') === 'embed', 'Shorts and the embed are their own kinds');
check(K('https://www.youtube.com/@channel', 'youtube') === 'other' && K('http://127.0.0.1:5555/watch?v=abcDEF12345', 'youtube') === 'watch', 'a channel page is other; a test origin counts by the slot’s service');
check(K('https://www.disneyplus.com/play/abc', 'disney') === 'player' && K('https://www.disneyplus.com/en-gb/play/abc', 'disney') === 'player' && K('https://www.disneyplus.com/browse/entity-abc', 'disney') === 'other', 'Disney+ /play/ (with a locale) is the player; browse is not');
check(K('https://www.hulu.com/watch/123', 'hulu') === 'player' && K('https://www.hulu.com/series/x', 'hulu') === 'other', 'Hulu /watch/ is the player');
check(K('https://www.primevideo.com/detail/0ABC/ref=x?autoplay=1', 'prime') === 'player' && K('https://www.amazon.com/gp/video/detail/B0X', 'prime') === 'player', 'Prime /detail/ is the player page');
check(K('https://www.espn.com/watch/player/_/id/abc', 'espn') === 'player' && K('https://www.espn.com/nhl/', 'espn') === 'other', 'ESPN /watch/player is the player');
check(K('notaurl', 'youtube') === '' && K('file:///c:/x', 'youtube') === '', 'not a web page: no kind');
const B = (o) => PV.boxedFor(Object.assign({ mode: 'lumen', kind: 'watch', multi: false, n: 1, blocked: '', noRoot: false }, o));
check(B({}) === true, 'the one player, Lumen view, a video: boxed');
check(B({ mode: 'page' }) === false, 'Full page (or the setting): not boxed');
check(B({ multi: true }) === false && B({ n: 2 }) === false, 'a multiview tile or a grid: never boxed (tiles keep their embed)');
check(B({ kind: 'embed' }) === false && B({ kind: 'other' }) === false && B({ kind: 'shorts' }) === false, 'an embed, a channel page, a Short: not boxed (yet)');
check(B({ blocked: 'DRM not ready' }) === false && B({ noRoot: true }) === false, 'a blocked slot, or a page whose player wasn’t found: not boxed');
check(B({ kind: 'player' }) === true, 'a service’s player page: boxed');

/* ---- trimCss ---------------------------------------------------------------------------------------- */
const css = PV.trimCss('youtube');
const rules = css.split('\n').filter((l) => /\{/.test(l));
check(rules.every((l) => /html\[data-lumen-pv\]/.test(l)) && css.split('}').filter((x) => x.trim()).every((blk) => /html\[data-lumen-pv\]/.test(blk)), 'every rule is inert until the page’s <html data-lumen-pv> is set');
check(/> body \{ visibility: hidden !important; \}/.test(css) && /\[data-lumen-pv-root\] \{ visibility: visible !important; position: fixed !important;/.test(css), 'body invisible, the marked player visible and over the viewport');
check(!/#movie_player[^{]*\{[^}]*display: none/.test(css) && !/ytp-ad|ytp-error|ytp-paid/.test(css), 'the player is never hidden, nor its ads, errors or paid-promotion note');
check(/#secondary/.test(css) && /#comments/.test(css) && /ytd-masthead/.test(css) && /ytd-ad-slot-renderer/.test(css) && /#player-ads/.test(css), 'YouTube’s masthead, recommendations, comments and sponsored cards are hidden');
check(/html\[data-lumen-pv\]\.lumen-pv-bar \.ytp-chrome-bottom/.test(css) && /\.lumen-pv-bar \.ytp-gradient-bottom/.test(css), 'the control bar is hidden only under the playerbar bridge’s root class');
check(/:not\(\[data-lumen-pv-pressing\]\) ytd-popup-container tp-yt-paper-dialog:has\(yt-confirm-dialog-renderer\)[^{]*\{ visibility: visible/.test(css), '“Continue watching?” stays seen over the player (not while Lumen answers its own confirm)');
check(!/lumen-pv-bar/.test(PV.trimCss('hulu')) && /\[data-lumen-pv-root\]/.test(PV.trimCss('hulu')) && !/display: none/.test(PV.trimCss('hulu')), 'Hulu: the generic trim only, nothing of its page hidden outright');
check(PV.trimCss('nope').length > 0 && !/undefined/.test(PV.trimCss('nope')), 'an unknown service: the generic trim, no junk');

/* ---- the ad-slot rules follow Quartz's ad blocker ------------------------------------------------ */
// The YouTube hide list as it was before the ad-slot rules became conditional, written out literally:
// with the blocker on (or its state not known yet) the trim must be exactly this, in this order.
const OLD_YT_HIDE = ['#masthead-container', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', '#secondary', '#related',
  '#comments', 'ytd-comments', '#chat', 'ytd-live-chat-frame', '#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer',
  'ytd-merch-shelf-renderer', 'ytd-engagement-panel-section-list-renderer', '#panels', '#offer-module'];
const AD_SLOTS = ['#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer', 'ytd-merch-shelf-renderer'];
const hideBlock = (list) => list.map((s) => 'html[data-lumen-pv] ' + s).join(',\n') + ' { display: none !important; }';
const ytOn = PV.trimCss('youtube', true), ytOff = PV.trimCss('youtube', false);
check(JSON.stringify(PV.HIDE.youtube) === JSON.stringify(OLD_YT_HIDE) && JSON.stringify(PV.ADSLOTS.youtube) === JSON.stringify(AD_SLOTS), 'the YouTube hide list is unchanged; the ad slots are #player-ads, the ad-slot, companion-slot and merch-shelf renderers', PV.ADSLOTS);
check(ytOn === css && PV.trimCss('youtube', undefined) === css && PV.trimCss('youtube', null) === css && PV.trimCss('youtube', 'yes') === css, 'blocker on, or not answered yet: the trim is byte for byte the one with no blocker state given');
check(ytOn.endsWith('\n' + hideBlock(OLD_YT_HIDE)), 'blocker on: the hide rule is the literal old list, in order', ytOn.slice(-200));
check(ytOff.endsWith('\n' + hideBlock(OLD_YT_HIDE.filter((s) => AD_SLOTS.indexOf(s) < 0))) && AD_SLOTS.every((s) => ytOff.indexOf(s) < 0), 'blocker off: the four ad/merch selectors are gone, the rest of the hide list as before, in order', ytOff.slice(-200));
check(ytOff === ytOn.replace('\n' + hideBlock(OLD_YT_HIDE), '\n' + hideBlock(OLD_YT_HIDE.filter((s) => AD_SLOTS.indexOf(s) < 0))), 'blocker off: everything else in the trim (keep, bar, body, player root) is identical');
check(['disney', 'hulu', 'prime', 'espn', 'nope'].every((s) => PV.trimCss(s, false) === PV.trimCss(s, true) && PV.trimCss(s, true) === PV.trimCss(s)), 'the other services: the blocker changes nothing');
check(Object.keys(PV.ADSLOTS).every((s) => PV.ADSLOTS[s].every((x) => (PV.HIDE[s] || []).indexOf(x) >= 0)), 'every ad slot is a member of its service’s hide list (the blocker only ever removes, never adds)');

/* ---- epParts / cleanPageTitle ------------------------------------------------------------------------ */
const E = PV.epParts;
check(JSON.stringify(E('S2 E4 · Honeydew')) === '{"ep":"S2 E4","name":"Honeydew"}', 'S2 E4 · Honeydew', E('S2 E4 · Honeydew'));
check(JSON.stringify(E('S2:E4 Honeydew')) === '{"ep":"S2 E4","name":"Honeydew"}' && JSON.stringify(E('Season 3 Episode 10 - The End')) === '{"ep":"S3 E10","name":"The End"}', 'S2:E4 and "Season 3 Episode 10"');
check(JSON.stringify(E('E7')) === '{"ep":"E7","name":""}' && JSON.stringify(E('')) === '{"ep":"","name":""}' && JSON.stringify(E('Live')) === '{"ep":"","name":"Live"}', 'E7 alone, nothing, plain words');
check(PV.cleanPageTitle('(3) Big Video - YouTube', 'youtube') === 'Big Video' && PV.cleanPageTitle('Watch The Bear | Hulu', 'hulu') === 'The Bear', 'a page title loses the service’s suffix and the unread count');

/* ---- model --------------------------------------------------------------------------------------------- */
const read = { ok: true, videoId: 'abcDEF12345', signedIn: true, title: 'Page Title', titleFrom: 'page', channel: { name: 'Chan', subs: '1.2M subscribers', avatar: 'https://x/a.jpg' },
  desc: { text: 'Hello', meta: '10K views · 2 days ago' }, like: { found: true, on: true, count: '12K' }, dislike: { found: true, on: false }, sub: { found: true, on: false }, save: { found: false }, comments: { token: 'TOK' } };
let m = PV.model('youtube', read, { id: 'youtube:x', title: 'Item Title' }, 'Slot');
check(m.title === 'Page Title' && m.titleFrom === 'page' && m.channel.name === 'Chan' && m.channel.subs === '1.2M subscribers', 'YouTube: the page’s title and channel come first');
check(m.buttons.like.on === true && m.buttons.like.count === '12K' && m.buttons.sub.on === false && m.buttons.save.found === false && m.missing.join() === 'save', 'the buttons’ state is the page’s; a missing one is listed');
check(m.desc.meta === '10K views · 2 days ago' && m.comments.token === 'TOK' && m.videoId === 'abcDEF12345', 'the description, the comments token (for a later module), the video id');
m = PV.model('youtube', null, { id: 'youtube:x', title: 'Item Title' }, 'Slot');
check(m.title === 'Item Title' && m.titleFrom === 'item' && m.channel === null && m.missing.length === 0 && m.signedIn === null, 'nothing read yet: the item’s title, no channel, nothing claimed missing');
m = PV.model('youtube', { ok: true, pageTitle: 'Other - YouTube' }, { title: 'Old' }, '', { moved: true });
check(m.title === 'Other' && m.titleFrom === 'page-title', 'moved on in the page: the page’s own title, not the stale item');
m = PV.model('hulu', { ok: true, title: 'Watch The Bear | Hulu' }, { id: 'hulu:1', title: 'The Bear', subtitle: 'S2 E4 · Honeydew' }, '');
check(m.title === 'The Bear' && m.ep === 'S2 E4' && m.epName === 'Honeydew' && m.name === 'Hulu' && m.channel === null, 'Hulu: the item’s title, SxEy and the episode’s name, the service');
m = PV.model('prime', { ok: true, title: 'Watch Next One | Prime Video' }, { title: 'First' }, '', { moved: true });
check(m.title === 'Next One' && m.ep === '', 'Prime, moved to another episode in its own player: the page’s title, no stale SxEy');
m = PV.model('espn', null, null, 'Game · Live');
check(m.title === 'Game' && m.titleFrom === 'item', 'ESPN with only the slot’s title: its first part');
check(PV.complete(read) === true && PV.complete(Object.assign({}, read, { sub: { found: false } })) === false && PV.complete(null) === false, 'complete(): title, channel, Like and Subscribe');

/* ---- r62-playview: a YouTube page that moved on to another video ------------------------------------------ */
// The view used to treat YouTube as never "moved": after autoplay or an end-screen card (moves in the page),
// the LAST video's title from Lumen's row stood in under the next one, and stayed when the read failed.
check(PV.ytId('https://www.youtube.com/watch?v=abcDEF12345&t=30s') === 'abcDEF12345' && PV.ytId('https://youtu.be/abcDEF12345') === 'abcDEF12345'
  && PV.ytId('https://www.youtube.com/live/abcDEF12345') === 'abcDEF12345' && PV.ytId('https://www.youtube.com/@chan') === '', 'ytId: watch, youtu.be and live addresses; a channel has none');
check(PV.ytMoved('https://www.youtube.com/watch?v=AAAAAAAAAAA', 'https://www.youtube.com/watch?v=BBBBBBBBBBB&pp=x') === true, 'ytMoved: another video id is a move');
check(PV.ytMoved('https://www.youtube.com/watch?v=AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=95s&pp=x') === false
  && PV.ytMoved('https://youtu.be/AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA') === false, 'ytMoved: the same video with a time or a short link is not');
check(PV.ytMoved('https://www.youtube.com/@chan', 'https://www.youtube.com/watch?v=BBBBBBBBBBB') === false, 'ytMoved: an item that was not one video never moves');
{
  const rowItem = { title: 'Video A (from the row)' };
  const mv = PV.model('youtube', null, rowItem, 'Video A (slot)', { moved: true });
  check(mv.title === '' && mv.titleFrom === '', 'model: moved and not read yet: no title from the row (the skeleton, never the last video’s)', mv);
  const mv2 = PV.model('youtube', { ok: true, videoId: 'BBBBBBBBBBB', pageTitle: 'Video B - YouTube' }, rowItem, 'Video A (slot)', { moved: true });
  check(mv2.title === 'Video B' && mv2.titleFrom === 'page-title', 'model: moved, the page has only its <title>: that, cleaned', mv2);
}
// watch-player-hosts.js: an Amazon prefix is whole path segments (amazon.com/videogames is shopping, not Prime Video).
{
  const Hs = require(path.join(ROOT, 'watch-player-hosts'));
  check(Hs.serviceFor('https://www.amazon.com/videogames/b?node=468642') === '' && Hs.serviceFor('https://www.amazon.com/video/detail/B0X') === 'prime'
    && Hs.serviceFor('https://www.amazon.com/gp/video/detail/B0X') === 'prime' && Hs.serviceFor('https://www.amazon.com/Amazon-Video/b?node=2858778011') === 'prime',
  'hosts: amazon.com/videogames is not Prime Video; /video/, /gp/video and /Amazon-Video still are');
}

/* ---- whyOff ---------------------------------------------------------------------------------------------- */
const mm = PV.model('youtube', read, null, '');
check(PV.whyOff(mm, 'like', 'ready') === '' && /Save button isn’t on this page/.test(PV.whyOff(mm, 'save', 'ready')), 'a found button is on; a missing one says why');
check(/^Sign in to YouTube to subscribe$/.test(PV.whyOff(PV.model('youtube', Object.assign({}, read, { signedIn: false }), null, ''), 'sub', 'ready')), 'signed out: Sign in, in words');
check(PV.whyOff(mm, 'like', 'offline') === 'You’re offline' && /Reading/.test(PV.whyOff(PV.model('youtube', { ok: true }, null, ''), 'like', 'loading')), 'offline, and still reading');

/* ---- the in-page script ---------------------------------------------------------------------------------- */
let compiled = true;
try { new vm.Script(PV.call('tick', ['youtube', true])); new vm.Script(PV.call('press', ['youtube', 'like', null])); } catch (e) { compiled = e.message; }
check(compiled === true, 'the page calls compile', compiled);
check(PV.call('read', ['he said "hi"</script>']).indexOf('"he said \\"hi\\"</script>"') > 0, 'arguments are JSON, never pasted in raw');
// A bare page: no player, nothing on it. The script installs, finds no root, and leaves the page alone.
const attrs = {};
const docEl = { hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
const win = { location: { href: 'https://www.youtube.com/watch?v=abcDEF12345' }, dispatchEvent: () => true };
const doc = { documentElement: docEl, title: 'T - YouTube', querySelector: () => null, querySelectorAll: () => [] };
const sb = vm.createContext({ window: win, document: doc, location: win.location, URL, setTimeout, clearTimeout, Promise, Event: function () {}, KeyboardEvent: function () {}, JSON, Math, Date, Number, String, Array, Object });
let tick = null;
try { tick = vm.runInContext(PV.call('tick', ['youtube', true]), sb); } catch (e) { tick = { err: e.message }; }
check(tick && tick.ok === true && tick.applied === false && !('data-lumen-pv' in attrs), 'a page with no #movie_player: not trimmed (the whole page shows)', tick);
check(tick && tick.like && tick.like.found === false && tick.sub.found === false && tick.videoId === 'abcDEF12345' && tick.signedIn === null, 'and nothing claimed: no buttons found, sign-in unknown', tick);
check(typeof win.__lumenPv.press === 'function' && win.__lumenPv.v >= 1, 'installed once, as window.__lumenPv');
let pr = null;
vm.runInContext(PV.call('press', ['youtube', 'like', null]), sb).then((r) => { pr = r; });
let prOther = null;
vm.runInContext(PV.call('press', ['hulu', 'like', null]), sb).then((r) => { prOther = r; });

/* ---- watch-playview-main.js -------------------------------------------------------------------------------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
const handlers = {};
const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
const chrome = { sender: { id: 1 } };
const winStub = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFullScreen: () => winStub.fs, fs: false, setFullScreen(v) { winStub.fs = v; }, isMaximized: () => false, getContentBounds: () => ({ x: -32000, y: -32000, width: 1280, height: 800 }) });
const logs = [];
const a = Main.create({ ipcMain: ipc, userData: dir, getWindow: () => winStub, isChromeSender: (e) => e === chrome, log: (l) => logs.push(l), test: true });
a.registerIpc();
check(a.view() === 'lumen', 'the default: Lumen view');
check(handlers['watch-playview:set-view'](chrome, { view: 'page' }).view === 'page' && JSON.parse(fs.readFileSync(path.join(dir, Main.PREFS_FILE), 'utf8')).view === 'page', 'set to the full page: saved to watch-playview.json');
const b2 = Main.create({ ipcMain: { handle() {} }, userData: dir, getWindow: () => null, test: false });
check(b2.view() === 'page', 'a fresh start reads it back');
check(handlers['watch-playview:set-view'](chrome, { view: 'javascript:1' }).view === 'lumen', 'junk is refused: back to the default');
let threw = false;
try { handlers['watch-playview:get']({ sender: { id: 9 } }, {}); } catch (e) { threw = /not the chrome/.test(e.message); }
check(threw, 'only the chrome may ask');
const tw = handlers['watch-playview:test-win'](chrome, {});
check(tw && tw.ok && tw.fullScreen === false && tw.content.width === 1280 && tw.entered === 0, 'TEST: the window’s real state');
winStub.fs = true; winStub.emit('enter-full-screen');
check(winStub.fs === false && handlers['watch-playview:test-win'](chrome, {}).entered === 1, 'TEST: OS fullscreen is undone at once and counted');
const h2 = {};
Main.create({ ipcMain: { handle: (ch, fn) => { h2[ch] = fn; } }, userData: dir, test: false }).registerIpc();
check(!h2['watch-playview:test-win'] && !!h2['watch-playview:get'], 'not a test profile: no window seam at all');
fs.writeFileSync(path.join(dir, Main.PREFS_FILE), '{not json');
check(Main.create({ userData: dir }).view() === 'lumen', 'a broken prefs file: the default');

/* ---- watch-player-yt.js's "Full page" button ------------------------------------------------------------------ */
const ytSrc = fs.readFileSync(path.join(ROOT, 'watch-player-yt.js'), 'utf8');
function ytIn(withPv) {
  const made = [];
  const mk = () => { const n = { hidden: false, textContent: '', title: '', attrs: {}, listeners: {}, className: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, click() { this.listeners.click({ stopPropagation() {} }); } }; made.push(n); return n; };
  const w = { WatchPlayerHosts: require(path.join(ROOT, 'watch-player-hosts')) };
  const toggled = [];
  if (withPv) w.LumenPlayview = { toggleFor: (s) => (s && s.pv ? { label: s.pv, title: 't' } : null), toggle: (s) => { toggled.push(s.id); return true; } };
  const c = vm.createContext({ window: w, self: w, document: { createElement: mk }, URL, Promise, console, JSON, Math, Number, String, Object });
  vm.runInContext(ytSrc.replace(/typeof module === 'object' && module\.exports/, 'false'), c);
  const Y = w.WatchPlayerYT;
  const barEl = { appendChild() {} };
  const s1 = { id: 1, view: {}, url: 'https://www.youtube.com/watch?v=abcDEF12345', service: 'youtube', pv: 'Full page' };
  const ctx = { focused: () => s1 };
  Y.bar(ctx, barEl);
  return { Y, ctx, s1, btn: made[0], toggled };
}
let t = ytIn(true);
t.Y.sync(t.ctx, t.s1);
check(!t.btn.hidden && t.btn.textContent === 'Full page', 'with the view: the full watch page shows “Full page”');
t.btn.click();
check(t.toggled.join() === '1', 'and its click toggles the view (no reload, no new URL)');
t.s1.pv = 'Lumen view'; t.Y.sync(t.ctx, t.s1);
check(t.btn.textContent === 'Lumen view' && !t.btn.hidden, 'in Full page it says “Lumen view”');
t.s1.pv = null; t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden && t.btn.textContent === 'Full page', 'no view for the slot (the setting says full page): hidden on the watch page, as before');
t = ytIn(false);
t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden === true, 'without watch-playview.js: the watch page has no button, as before');
t.s1.url = 'https://www.youtube.com/embed/abcDEF12345'; t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden === false && t.btn.textContent === 'Full page', 'and the embed still offers “Full page”');

setTimeout(() => {
  check(pr && pr.ok === false && /Like button isn’t on this page/.test(pr.reason), 'a press with no button on the page: refused, with the reason (never a silent no-op)', pr);
  check(prOther && prOther.ok === false, 'nothing is pressed on Disney+, Hulu, Prime or ESPN');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log('watch-playview-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 50);
