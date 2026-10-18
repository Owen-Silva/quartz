try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-alerts-e2e.js -- Lumen Alerts end to end in a REAL hidden Quartz test instance (tests/e2e-kit.js:
// --test-profile, off-screen, watched by testwatch.js).
//
// LOCAL FIXTURES ONLY. The reads an alert rides on are fed through the test IPC (lumen-alerts:test) as the
// answers Lumen's own readers give for tests/watch-fixtures (youtube-subs*.json through watch/ytlib.js,
// espn-nhl.json through watch/adapters/espn.js). Every service origin is rebased to tests/watch-mock.js
// (Lumen, the score pins, the sports pages), so a click that plays or pins stays on 127.0.0.1. The chrome's
// window.Notification is replaced by a counter that never shows anything, and openWatchTab by a counter (no
// Lumen tab, so no hidden reads). Never a real account, cookie or profile, never a real notification.
//
//   node watch-alerts-e2e.js [--cdp 9561] [--shots <dir>] [--prefix lumen-n-alerts]
//
// Checks: a fresh profile's Settings states; the baseline read alerts nothing; a gaming gate holds it; the
// held videos come as ONE batched card while Quartz is in front, with no Notification constructed; a row
// click plays that video through Lumen (open stub); Quartz in the background takes the notification path,
// silently counted; a favourite's game start (Pin this game pins it in score pins) and final; Settings >
// Lumen > Alerts (toggles saved, the team list, signed out, an error with its reason); shots at 1536x800
// and 1920x1000 with nothing clipped. One summary line: "watch-alerts-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, sleep, Cdp } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const L = require('./watch/ytlib');
const Espn = require('./watch/adapters/espn');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9561'));
const SHOTS = opt('shots', 'C:/Users/you/next-week/morning-shots');
const PREFIX = opt('prefix', 'lumen-n-alerts');
const SIZES = [[1536, 800], [1920, 1000]];
const FIX = path.join(__dirname, 'tests', 'watch-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const SUBS_URL = 'https://www.youtube.com/feed/subscriptions';

function subs(name) {
  const f = fx(name);
  const r = L.parseSubs({ now: Date.now(), steps: { subs: { ok: true, url: SUBS_URL, finalUrl: SUBS_URL, status: 200, extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url: SUBS_URL } } } });
  return { state: r.state, reason: r.reason || '', readAt: Date.now(), items: r.items || [] };
}
function extra(base, list) {
  const items = list.map(([vid, channel, title]) => Object.assign({}, base.items[1], { id: 'youtube:' + vid, vid, url: 'https://www.youtube.com/watch?v=' + vid, title, channel: { name: channel, path: '/@x', avatar: '' }, live: false, upcoming: false, badge: '' }));
  return Object.assign({}, base, { readAt: Date.now(), items: items.concat(base.items) });
}
const NHL = fx('espn-nhl.json');
const GAME = '401892518';   // VAN at LA in the fixture
function espn(state, detail, score) {
  const j = JSON.parse(JSON.stringify(NHL));
  const e = j.events.find((x) => String(x.id) === GAME);
  const start = new Date(Date.now() - 20 * 60e3).toISOString();
  e.date = start; e.competitions[0].date = start;
  const names = { pre: 'STATUS_SCHEDULED', in: 'STATUS_IN_PROGRESS', post: 'STATUS_FINAL' };
  for (const st of [e.status, e.competitions[0].status]) if (st) st.type = Object.assign({}, st.type, { state, name: names[state], completed: state === 'post', detail, shortDetail: detail, description: detail });
  if (score) e.competitions[0].competitors.forEach((c) => { c.score = String(c.homeAway === 'home' ? score[1] : score[0]); });
  const r = Espn.parse({ now: Date.now(), steps: { nhl: { ok: true, status: 200, json: j, extracted: j } } }, { leagues: ['nhl'], now: Date.now() });
  return { state: r.state, reason: r.reason || '', readAt: Date.now(), events: r.events || [] };
}
const FAVS = [{ league: 'nhl', id: '13', abbr: 'VAN', name: 'Vancouver Canucks', logo: '' }];

// Clipped text in a root: an element whose own text overflows its box (ellipsis or a cut line), or that
// leaves the viewport. Returns { n, count, bad }.
const CLIP = (root) => `(() => {
  const root = ${root}; if (!root) return { n: 0, count: -1, bad: ['no root'] };
  const bad = []; let n = 0;
  for (const e of root.querySelectorAll('*')) {
    if (!e.childNodes.length || ![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    n++;
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    if (r.width === 0 || cs.display === 'none') continue;
    const clipped = (cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1);
    const off = r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.left < -0.5;
    if ((clipped && cs.webkitLineClamp === 'none') || off) bad.push(e.className + ' "' + e.textContent.trim().slice(0, 40) + '"' + (off ? ' off-viewport' : ''));
  }
  return { n, count: bad.length, bad: bad.slice(0, 6) };
})()`;

run('watch-alerts-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await Mock.start({ log: () => {} });
  // Anything else a pin might ask (the NHL's feed, espn.com) gets a local 404: never the real host.
  const nowhere = await new Promise((res) => { const s = require('http').createServer((q, a) => { a.writeHead(404, { 'Content-Type': 'text/plain' }); a.end('not in this test'); }); s.listen(0, '127.0.0.1', () => res(s)); });
  const nowhereOrigin = 'http://127.0.0.1:' + nowhere.address().port;
  const sportsRebase = mock.rebase.concat([['https://api-web.nhle.com', nowhereOrigin], ['https://www.espn.com', nowhereOrigin]]);
  const stub = path.join(os.tmpdir(), 'quartz-alerts-e2e-' + process.pid + '-open.txt');
  const env = {
    QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase),
    QUARTZ_SCORES_REBASE: JSON.stringify(sportsRebase),
    QUARTZ_SPORTS_REBASE: JSON.stringify(sportsRebase),
    QUARTZ_WATCH_OPEN_STUB: stub,
    QUARTZ_SCORES_OPEN_STUB: stub + '.scores',
    QUARTZ_EDGE_STUB: stub + '.edge',
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
  };
  const opens = () => { try { return fs.readFileSync(stub, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
  try {
    const q = await launch({ cdp: CDP_PORT, env });
    const c = q.chrome;
    const T = (op) => c.ev('window.api.lumenAlerts.test(' + JSON.stringify(op) + ')');
    const R = () => c.ev('window.__lumenAlertsTest');
    const size = async (w, h) => { await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(500); };
    const ready = await c.waitFor('!!(window.api && window.api.lumenAlerts && window.LumenAlertsSettings && window.__lumenAlertsTest)', 20000).catch(() => null);
    check(!!ready, 'the chrome has the alerts bridge, its Settings renderer and its test record');
    // Never a real notification: a counter stands in for window.Notification (it shows nothing), and
    // openWatchTab is counted on its way through.
    await c.ev(`(() => { window.__notes = []; const Fake = function (t, o) { window.__notes.push({ t, o }); this.close = function () {}; };
      Fake.permission = 'granted'; Fake.requestPermission = () => Promise.resolve('granted'); window.Notification = Fake;
      window.__lumenTabs = 0; const open = window.openWatchTab; window.openWatchTab = function () { window.__lumenTabs++; return open.apply(this, arguments); }; return 1; })()`);
    // The Lumen tab, open first so a video plays in its player layer; every https request its page makes is refused here
    // (its reads already go to the mock: QUARTZ_WATCH_REBASE).
    await c.ev('openWatchTab(), 1');
    let gt = null;
    for (let i = 0; i < 200 && !gt; i++) { try { gt = (await q.targets()).find((x) => x.webSocketDebuggerUrl && /\/watch\.html(\?|#|$)/.test(String(x.url))); } catch (e) { /* not yet */ } if (!gt) await sleep(60); }
    const g = gt ? await new Cdp(gt.webSocketDebuggerUrl).open() : null;
    const refused = [];
    if (g) {
      g.ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch (e) { return; } if (m.method === 'Fetch.requestPaused') { refused.push(m.params.resourceType + ' ' + m.params.request.url.slice(0, 80)); g.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }); } });
      await g.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
    }
    check(!!g, 'the Lumen tab is open, every https request from it refused (local fixtures only)');
    const tabs0 = await c.ev('tabs.length');


    // The memory gate sees a simulated 8 GB free: this box may sit near the 2.5 GB floor while tests run.
    await T({ op: 'gate', freeGb: 8 });
    let d = await c.ev('window.api.lumenAlerts.describe()');
    check(d && d.subs.on === true && d.subs.state === 'never' && d.teams.on === false && d.teams.favs.length === 0, 'a fresh profile: subscription alerts on and never read; team alerts off with no team picked', d && { subs: d.subs, teams: d.teams.on });

    // Settings, before anything was read.
    await c.ev("Settings.open('Lumen'), 1");
    const field = "document.querySelector('[data-field=\"watchalerts\"]')";
    const st0 = await c.waitFor(`(() => { const f = ${field}; const s = f && f.querySelector('.lumen-alerts-subs-state'); return s ? { subs: s.textContent, teams: (f.querySelector('.lumen-alerts-teams-state') || {}).textContent, only: (f.querySelector('.lumen-alerts-only') || {}).textContent } : null; })()`, 15000).catch(() => null);
    check(!!st0 && /first Subscriptions read/.test(st0.subs) && /Pick a team/.test(st0.teams), 'Settings: "waiting for the first read" and "pick a team" before anything happened', st0);
    check(!!st0 && /only while Quartz is running/.test(st0.only), 'Settings says alerts come only while Quartz runs', st0 && st0.only);
    await c.ev('Settings.close(), 1');

    // The baseline read: nothing is new to an alert that never looked.
    let r = await T({ op: 'subs', answer: subs('youtube-subs.json') });
    await sleep(300);
    check(r && r.alert === '' && (await R()).card.length === 0 && r.describe.subs.baselined === true && r.describe.subs.held === '', 'the first Subscriptions read is the baseline: no alert', r && r.describe.subs);

    // Gaming: held, nothing said, nothing read.
    await T({ op: 'gate', gaming: 'valorant' });
    r = await T({ op: 'subs', answer: subs('youtube-subs-next.json') });
    const hot = await T({ op: 'hot', events: [] });
    check(r && r.alert === '' && /VALORANT/.test(r.describe.subs.held) && hot.wantSubs === false, 'while VALORANT runs: no alert and no extra Subscriptions read; Settings says why', r && r.describe.subs.held);
    await T({ op: 'gate', gaming: '', flag: true });
    r = await T({ op: 'subs', answer: subs('youtube-subs-next.json') });
    check(r && r.alert === '', 'the gaming flag holds it too');
    await T({ op: 'gate', flag: false, freeGb: 1.0 });
    r = await T({ op: 'subs', answer: subs('youtube-subs-next.json') });
    check(r && r.alert === '' && /memory/.test(r.describe.gate), 'under the RAM floor: held, with the number', r && r.describe.gate);
    // Back over the floor (a simulated 8 GB: the real box may sit near 2.5 GB while the suite runs).
    await T({ op: 'gate', freeGb: 8 });

    // Quartz in front: the held videos, ONE batched card, no notification constructed.
    r = await T({ op: 'subs', answer: subs('youtube-subs-next.json') });
    const card1 = await c.waitFor(`(() => { const k = document.querySelector('.lumen-alert-subs.is-up'); return k ? { title: k.querySelector('.lumen-alert-title').textContent, rows: [...k.querySelectorAll('.lumen-alert-row')].map((x) => x.textContent) } : null; })()`, 8000).catch(() => null);
    check(!!card1 && card1.title === '2 new from your subscriptions' && card1.rows.length === 2, 'the gate clears: one card, "2 new from your subscriptions", a row per video', card1);
    check((await c.ev('window.__notes.length')) === 0, 'Quartz in front: the card, and no Notification constructed');
    let cnt = await T({ op: 'state' });
    check(cnt.counts.sent === 1 && cnt.counts.card === 1 && cnt.counts.os === 0, 'main counts one alert, shown as a card', cnt.counts);
    // A row plays that video through Lumen.
    await c.ev("document.querySelector('.lumen-alert-subs .lumen-alert-row').click(), 1");
    const layer = await c.waitFor("(() => { const s = WatchPlayer._state(); return s && s.open && s.slots && s.slots[0] && /sbNewVid011/.test(s.slots[0].url) ? s.slots[0].url : null; })()", 10000).catch(() => null);
    check(!!layer && (await c.ev('tabs.length')) === tabs0, 'a row click plays THAT video in the Lumen player layer (no new tab)', { layer, tabs: await c.ev('tabs.length'), tabs0 });
    const o1 = opens();
    check(o1.length >= 1 && /watch\?v=sbNewVid011/.test(o1[o1.length - 1].url) && (await c.ev('window.__lumenTabs')) >= 1, 'a row click plays that video through Lumen (its open, with Lumen brought forward)', { o1, lumenTabs: await c.ev('window.__lumenTabs') });
    check((await c.ev('document.querySelectorAll(".lumen-alert-subs").length')) === 0, 'the card leaves after the click');
    await c.ev('(() => { try { if (window.WatchPlayer && WatchPlayer._state().open) WatchPlayer.close(); } catch (e) {} return 1; })()');

    // Quartz in the background: the notification path, silently counted.
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await sleep(300);
    const focused = await c.ev('document.hasFocus()');
    const five = extra(subs('youtube-subs-next.json'), [['lumenAlrt01', 'Kitchen Science Lab', 'Three prep drills for a faster first step'], ['lumenAlrt02', 'Coach Ryan', 'Planet tracking: reading star charts'], ['lumenAlrt03', 'ESA', 'Top 10 stars of the week']]);
    r = await T({ op: 'subs', answer: five });
    await sleep(600);
    const rec = await R();
    check(!focused && rec.os.length === 1 && rec.os[0].title === '3 new from your subscriptions' && /Kitchen Science Lab: Three prep drills/.test(rec.os[0].body), 'Quartz in the background: the notification path, with the batch in its body', { focused, os: rec.os });
    check((await c.ev('window.__notes.length')) === 0 && (await c.ev('document.querySelectorAll(".lumen-alert").length')) === 0, 'TESTS ARE SILENT: no Notification constructed, no card either', await c.ev('window.__notes.length'));
    cnt = await T({ op: 'state' });
    check(cnt.counts.os === 1, 'main heard it went the notification way', cnt.counts);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(300);

    // Favourite teams: a start (Pin this game) and a final.
    r = await T({ op: 'espn', service: espn('pre', '7:30 PM PDT') });
    check(r && r.alerts.length === 0 && r.describe.teams.on === false, 'ESPN read with no team picked: nothing');
    await T({ op: 'favs', favs: FAVS });
    d = await c.ev('window.api.lumenAlerts.describe()');
    check(d.teams.on === true && d.teams.favs[0].abbr === 'VAN', 'a team picked: team alerts on by themselves');
    r = await T({ op: 'espn', service: espn('pre', '7:30 PM PDT') });
    check(r.alerts.length === 0, 'pre-game: nothing yet');
    r = await T({ op: 'espn', service: espn('in', '19:40 - 1st') });
    const g1 = await c.waitFor(`(() => { const k = document.querySelector('.lumen-alert-game.is-up'); return k ? { title: k.querySelector('.lumen-alert-title').textContent, body: (k.querySelector('.lumen-alert-body') || {}).textContent, acts: [...k.querySelectorAll('.lumen-alert-btn')].map((b) => b.textContent) } : null; })()`, 8000).catch(() => null);
    check(!!g1 && g1.title === 'Game on: VAN at LA' && g1.acts.join('|') === 'Open game|Pin this game', 'the start: "Game on: VAN at LA" with Open game and Pin this game', g1);
    await c.ev("document.querySelector('.lumen-alert-game [data-act=\"pin\"]').click(), 1");
    const pinned = await c.waitFor("window.api.scores.games().then((g) => (g.pinned || []).indexOf('nhl:" + GAME + "') !== -1 ? g.pinned : null)", 8000).catch(() => null);
    check(!!pinned, 'Pin this game pins it in score pins (no score drawn by the alert)', pinned);
    if (pinned) await c.ev("window.api.scores.unpin('nhl:" + GAME + "')");
    r = await T({ op: 'espn', service: espn('post', 'Final', [4, 2]) });
    const g2 = await c.waitFor(`(() => { const k = [...document.querySelectorAll('.lumen-alert-game.is-up')].pop(); const t = k && k.querySelector('.lumen-alert-title').textContent; return t && /^Final/.test(t) ? { title: t, acts: [...k.querySelectorAll('.lumen-alert-btn')].map((b) => b.textContent) } : null; })()`, 8000).catch(() => null);
    check(!!g2 && g2.title === 'Final: VAN 4, LA 2' && g2.acts.join('|') === 'Open recap', 'the final: "Final: VAN 4, LA 2", with Open recap', g2);

    // THE ALERT, shot: the final and a fresh subscriptions batch, held on screen.
    const four = extra(five, [['lumenAlrt04', 'Kitchen Science Lab', 'Omelette flip basics: the wrist roll that lands it'], ['lumenAlrt05', 'Guitar Coach Ryan', 'Why your left wrist drops on high notes'], ['lumenAlrt06', 'ESA', 'Every booster landing from opening week'], ['lumenAlrt07', 'Food Club', 'Dinner in Lisbon: extended highlights'], ['lumenAlrt08', 'Coach Jeremy', 'Hill climbing, part 4: gearshifts under pressure']]);
    await T({ op: 'subs', answer: four });
    await c.waitFor("document.querySelectorAll('.lumen-alert.is-up').length >= 2", 8000).catch(() => null);
    await c.ev("[...document.querySelectorAll('.lumen-alert')].forEach((k) => k.dispatchEvent(new MouseEvent('mouseenter'))), 1");
    const batch = await c.ev("(() => { const k = [...document.querySelectorAll('.lumen-alert-subs')].pop(); return k ? { title: k.querySelector('.lumen-alert-title').textContent, rows: k.querySelectorAll('.lumen-alert-row').length, more: (k.querySelector('.lumen-alert-more') || {}).textContent } : null; })()");
    check(!!batch && batch.title === '5 new from your subscriptions' && batch.rows === 3 && /and 2 more/.test(batch.more), 'five new videos: one card naming three, "and 2 more"', batch);
    for (const [w, h] of SIZES) {
      await size(w, h);
      const cut = await c.ev(CLIP("document.querySelector('.lumen-alerts')"));
      check(cut && cut.count === 0 && cut.n > 0, `shot alert ${w}x${h}: nothing clipped (${cut && cut.n} texts)`, cut);
      await c.shot(path.join(SHOTS, `${PREFIX}-alert-${w}x${h}.png`));
    }
    await c.ev("document.querySelectorAll('.lumen-alert').forEach((k) => k.remove()), 1");

    // Settings > Lumen > Alerts: the toggles, the team list, the states.
    await c.ev("Settings.open('Lumen'), 1");
    const scrollTo = `(() => { const f = ${field}; if (f) f.scrollIntoView({ block: 'center' }); return !!f; })()`;
    const st1 = await c.waitFor(`(() => { const f = ${field}; const s = f && f.querySelector('.lumen-alerts-subs-state'); const t = f && f.querySelector('.lumen-alerts-team'); return s && t && /new, alerted/.test(s.textContent) ? { subs: s.textContent, team: t.textContent, teams: f.querySelector('.lumen-alerts-teams-state').textContent, last: (f.querySelector('.lumen-alerts-last') || {}).textContent, sw: [...f.querySelectorAll('.set-row')].map((b) => b.getAttribute('aria-checked')) } : null; })()`, 15000).catch(() => null);
    check(!!st1 && /^Checked just now: 5 new, alerted\.$/.test(st1.subs) && /Vancouver Canucks · NHL/.test(st1.team) && st1.sw.join() === 'true,true', 'Settings: both switches on, "Checked just now: 5 new, alerted.", the team listed', st1);
    check(!!st1 && /Last alert just now, inside Quartz/.test(st1.last || ''), 'Settings: where the last alert went', st1 && st1.last);
    for (const [w, h] of SIZES) {
      await size(w, h);
      await c.ev(scrollTo);
      await sleep(400);
      const cut = await c.ev(CLIP(field));
      check(cut && cut.count === 0 && cut.n > 0, `shot settings ${w}x${h}: nothing clipped (${cut && cut.n} texts)`, cut);
      await c.shot(path.join(SHOTS, `${PREFIX}-settings-${w}x${h}.png`));
    }
    // The toggle, a real click: saved in main.
    await c.ev(`${field}.querySelector('.lumen-alerts-subs').click(), 1`);
    const off = await c.waitFor(`(() => { const b = ${field}.querySelector('.lumen-alerts-subs'); return b && b.getAttribute('aria-checked') === 'false' ? ${field}.querySelector('.lumen-alerts-subs-state').textContent : null; })()`, 8000).catch(() => null);
    d = await c.ev('window.api.lumenAlerts.describe()');
    check(off === 'Off.' && d.subs.on === false, 'the subscriptions switch turns it off, saved in main', { off, on: d.subs.on });
    r = await T({ op: 'subs', answer: extra(four, [['lumenAlrt09', 'NHL', 'Off means off']]) });
    check(r.alert === '', 'off: a new upload makes no alert');
    await c.ev(`${field}.querySelector('.lumen-alerts-subs').click(), 1`);
    await c.waitFor(`${field}.querySelector('.lumen-alerts-subs').getAttribute('aria-checked') === 'true'`, 8000).catch(() => null);
    // Signed out, and an error with its reason.
    await T({ op: 'subs', answer: { state: 'signed-out', reason: 'sign in to YouTube to see your subscriptions', readAt: Date.now(), items: [] } });
    await c.ev('window.LumenAlertsSettings.refresh(), 1');
    const so = await c.waitFor(`(() => { const t = ${field}.querySelector('.lumen-alerts-subs-state').textContent; return /signed out/.test(t) ? t : null; })()`, 8000).catch(() => null);
    check(!!so, 'signed out: no alert, and Settings says sign in', so);
    await T({ op: 'subs', answer: { state: 'error', reason: "the page didn't load", readAt: Date.now(), items: [] } });
    await c.ev('window.LumenAlertsSettings.refresh(), 1');
    const er = await c.waitFor(`(() => { const t = ${field}.querySelector('.lumen-alerts-subs-state').textContent; return /failed/.test(t) ? t : null; })()`, 8000).catch(() => null);
    check(!!er && /didn't load/.test(er), 'a failed read: Settings says it failed, with the reason', er);
    await c.ev('Settings.close(), 1');

    cnt = await T({ op: 'state' });
    check((await c.ev('window.__notes.length')) === 0, 'the whole run constructed no Notification', cnt.counts);
    say('https requests refused from the Lumen page: ' + refused.length + (refused.length ? ' e.g. ' + refused.slice(0, 3).join(', ') : ''));
    if (g) g.close();
    say('counts ' + JSON.stringify(cnt.counts));
    await q.quit();
  } finally {
    try { await mock.close(); } catch (e) { /* gone */ }
    try { nowhere.close(); } catch (e) { /* gone */ }
    for (const f of [stub, stub + '.scores', stub + '.edge']) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  }
});
