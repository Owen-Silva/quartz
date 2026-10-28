// home-design-harness.js -- the Home's quiet session pills and its one focal point, checked in plain
// node (no Electron, no browser, about a second).
//
//   node home-design-harness.js
//
// What it proves, and how:
//   1. HomeLayout.isDefault() over fixtures: true only for a layout that sanitises to nothing hidden and
//      nothing moved. The hero is drawn for exactly those, so this is the gate that keeps every customised
//      Home on the classic page.
//   2. The hero mechanism, by running newtab.js's own layoutHome() / homeMeasure() / homeHeroWanted() (cut
//      out of the file by name) against a stand-in page: the class is on only for the untouched default in
//      the plain flow, it is off before every measure (edit mode, a free draw), so a drag can never start
//      from the hero's geometry, and leaving edit mode with nothing changed puts it back.
//   3. newtab.css, read as text: every rule in the hero section is scoped under .home.is-hero, nothing
//      outside it names the class, nothing in it animates or uses the accent, and newtab.js only ever sets
//      the class through homeSetHero(). That is what "a customised Home renders exactly as before" rests on.
//   4. The session piece's geometry from newtab.css: no card (no fill, border, shadow or blur), the card's
//      224px width, and at most 138px tall in its fullest state, under the 158px card it replaced, so its
//      rect at any anchor lies inside the old one and it causes no NEW nudge or fold. (A piece a stored
//      layout had already nudged against the old card's edge does follow that edge: arrange() lands a
//      nudged piece at obstacle.bottom + GAP.) No hover on a pill (only the music buttons can be pressed).
//   5. The readout payload: newtab.js cleanReadout() validation of the new optional fields, and
//      paintReadout() words for every pill state (cut out by name, run against stand-in elements).
//   6. app.js: blockedTallyStep() (the running blocked total: rises, navigation resets, malformed input,
//      the bound on remembered pages), claudeReadout() and readoutSnapshot() (no `blocked` field until the
//      shield has said whether it is on).
//
// Ends with `home-design: N passed, M failed`.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const HL = require('./homelayout.js');
const NEWTAB_JS = fs.readFileSync(path.join(ROOT, 'newtab.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'newtab.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'newtab.html'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  check(name, a === b, { got: got, want: want });
}

/** The source of `function <name>(...) { ... }` in src, by brace matching. */
function cutFunction(src, name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at === -1) throw new Error('no function ' + name);
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at + 1, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
/** `const NAME = ...;` up to the first `endMarker` after it. */
function cutConst(src, name, endMarker) {
  const at = src.indexOf('\nconst ' + name + ' = ');
  if (at === -1) throw new Error('no const ' + name);
  const end = src.indexOf(endMarker, at);
  return src.slice(at + 1, end + endMarker.length);
}
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* ---------------------------------------------------------------- 1. isDefault */
(function isDefaultFixtures() {
  const yes = [
    ['null', null], ['undefined', undefined], ['{}', {}], ['defaults()', HL.defaults()],
    ['v2 empty', { v: 2, hidden: [], place: [] }],
    ['v1 columns, nothing hidden', { v: 1, columns: { left: ['clock'], centre: ['search'], right: [] }, hidden: [] }],
    ['unknown ids only', { hidden: ['nope', 42], place: [{ id: 'nope', h: 'l', x: 1, v: 't', y: 1 }] }],
    ['malformed place only', { place: [{ id: 'clock', h: 'q', x: 1, v: 't', y: 1 }, { id: 'clock' }, null] }],
    ['a string', 'garbage'], ['a number', 7], ['an array', ['clock']], ['true', true]
  ];
  for (const [name, v] of yes) check('isDefault: ' + name, HL.isDefault(v) === true, v);
  const no = [
    ['hidden logo', { hidden: ['logo'] }],
    ['v1 with a hidden piece', { v: 1, columns: {}, hidden: ['markets'] }],
    ['one place', { place: [{ id: 'clock', h: 'c', x: 0, v: 't', y: 120 }] }],
    ['place at the default spot is still a place', { place: [{ id: 'session', h: 'r', x: 24, v: 't', y: 24 }] }],
    ['hidden + place', { hidden: ['saved'], place: [{ id: 'media', h: 'l', x: 24, v: 'b', y: 24 }] }]
  ];
  for (const [name, v] of no) check('not default: ' + name, HL.isDefault(v) === false, v);
  check('isDefault exported to Node', typeof HL.isDefault === 'function');
  check('isDefault exported on window.HomeLayout', /isDefault: isDefault/.test(fs.readFileSync(path.join(ROOT, 'homelayout.js'), 'utf8')));
  const session = HL.PIECES.find((p) => p.id === 'session');
  check('session hint names every pill', session && /Tabs open/.test(session.hint) && /blocked/.test(session.hint) &&
    /auto-pause/.test(session.hint) && /idle music/.test(session.hint) && /Claude/.test(session.hint), session && session.hint);
  check('session is still a card', session && session.kind === 'card');
})();

/* ------------------------------------------------------- 2. the hero mechanism */
(function heroMechanism() {
  function classList() {
    const set = new Set();
    return {
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; }
    };
  }
  const home = { classList: classList(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }) };
  const measures = [];   // hero state at every rect read during a measure
  function pieceEl(id, i) {
    return {
      id: id, style: {}, classList: classList(),
      getClientRects: () => [1],
      getBoundingClientRect: () => {
        measures.push({ id: id, hero: home.classList.contains('is-hero') });
        return { left: 24 + i * 10, top: 24 + i * 40, width: 224, height: 100 };
      }
    };
  }
  const els = Object.create(null);
  HL.PIECES.forEach((p, i) => { els[p.id] = pieceEl(p.id, i); });
  const document = {
    querySelector: (sel) => (sel === '.home' ? home : null),
    documentElement: { classList: classList(), clientWidth: 1440, clientHeight: 900 },
    body: { classList: classList() }
  };
  const ctx = vm.createContext({
    document: document, window: { innerWidth: 1440, innerHeight: 900 }, HL: HL,
    homePieceEl: (id) => els[id] || null,
    homeSetFolded: () => {}, homeWatch: () => {},
    homeRestHeight: (id, el, r) => r.height,
    homeArrange: (layout, m) => ({ ok: true, rects: m.rects, nudged: [] }),
    Object: Object, JSON: JSON, Array: Array
  });
  vm.runInContext(
    'var homeDrawn = null, homeEditing = false, homeFree = false, homeFolded = false, homeFlow = null,' +
    ' homeRects = Object.create(null), homePage = null, homeYield = [];\n' +
    ['homeHeroWanted', 'homeSetHero', 'homeHeroOn', 'homeMeasure', 'homeUnfree', 'layoutHome',
     'homeFreeIds', 'homeDockInside', 'homeIsPlaced', 'homeRel'].map((n) => cutFunction(NEWTAB_JS, n)).join('\n') +
    '\nthis.set = function (layout, editing) { homeDrawn = HL.sanitize(layout); homeEditing = !!editing; };' +
    '\nthis.state = function () { return { free: homeFree }; };' +
    '\nthis.layoutHome = layoutHome; this.homeMeasure = homeMeasure; this.homeHeroWanted = homeHeroWanted; this.homeHeroOn = homeHeroOn;',
    ctx);
  const hero = () => home.classList.contains('is-hero');

  ctx.set(null, false); ctx.layoutHome();
  check('default Home in the flow wears the hero', hero() === true);
  check('default Home in the flow is not free', ctx.state().free === false);
  check('__home().hero reads the class', ctx.homeHeroOn() === true);
  check('the default flow measures nothing', measures.length === 0, measures.length);

  ctx.set(null, true); ctx.layoutHome();          // Edit pressed on a default Home
  check('edit mode drops the hero', hero() === false);
  check('edit mode is a free page', ctx.state().free === true);
  check('edit mode measured something', measures.length > 0);
  check('every edit-mode measure saw the classic page', measures.every((m) => !m.hero), measures.filter((m) => m.hero));

  ctx.set(null, false); ctx.layoutHome();          // Done, nothing changed
  check('leaving edit mode unchanged restores the hero', hero() === true);
  check('...and the flow', ctx.state().free === false);

  measures.length = 0;
  ctx.homeMeasure(HL.PIECES.map((p) => p.id));     // a measure with the hero on
  check('homeMeasure strips the hero before reading a rect', measures.length > 0 && measures.every((m) => !m.hero));

  ctx.set({ hidden: ['logo'] }, false); ctx.layoutHome();
  check('a hidden piece: no hero', hero() === false);
  measures.length = 0;
  ctx.set({ place: [{ id: 'clock', h: 'c', x: 0, v: 't', y: 140 }] }, false); ctx.layoutHome();
  check('a moved piece: no hero', hero() === false);
  check('a moved piece measures the classic page', measures.length > 0 && measures.every((m) => !m.hero));
  check('homeHeroWanted(default, editing) is false', ctx.homeHeroWanted(HL.defaults(), true) === false);
  check('homeHeroWanted(null layout) is false', ctx.homeHeroWanted(null, false) === false);

  // The class is set in one place only, and stripped in homeMeasure.
  const sets = NEWTAB_JS.match(/is-hero/g) || [];
  const allowed = [cutFunction(NEWTAB_JS, 'homeSetHero'), cutFunction(NEWTAB_JS, 'homeHeroOn'), cutFunction(NEWTAB_JS, 'homeMeasure')]
    .reduce((n, f) => n + (f.match(/is-hero/g) || []).length, 0);
  check('newtab.js names is-hero only in homeSetHero / homeHeroOn / homeMeasure', sets.length === allowed, { all: sets.length, allowed: allowed });
  check('homeSetHero is only called from layoutHome', (NEWTAB_JS.match(/homeSetHero\(/g) || []).length === 2 &&
    /homeSetHero\(!wantFree && homeHeroWanted\(homeDrawn, homeEditing\)\)/.test(cutFunction(NEWTAB_JS, 'layoutHome')));
  const lay = cutFunction(NEWTAB_JS, 'layoutHome');
  check('layoutHome decides the hero before it measures', lay.indexOf('homeSetHero(') >= 0 && lay.indexOf('homeSetHero(') < lay.indexOf('homeMeasure(ids)'));
  const edit = cutFunction(NEWTAB_JS, 'setHomeEditing');
  check('setHomeEditing sets homeEditing before layoutHome()', edit.indexOf('homeEditing = on') >= 0 &&
    edit.indexOf('homeEditing = on') < edit.lastIndexOf('layoutHome()'));
})();

/* ------------------------------------------------------- 3. hero CSS scoping */
(function heroCss() {
  const a = CSS.indexOf('/* --- hero: BEGIN');
  const b = CSS.indexOf('/* --- hero: END');
  check('newtab.css has a hero section', a >= 0 && b > a);
  if (a < 0 || b < a) return;
  const section = stripComments(CSS.slice(a, b));
  const outside = stripComments(CSS.slice(0, a) + CSS.slice(b));
  check('nothing outside the hero section names is-hero', outside.indexOf('is-hero') < 0);
  // Walk the blocks: every prelude is an @container query or a selector list scoped under .home.is-hero.
  const preludes = [];
  let start = 0;
  for (let i = 0; i < section.length; i++) {
    const c = section[i];
    if (c === '{') { preludes.push(section.slice(start, i).trim()); start = i + 1; }
    else if (c === '}' || c === ';') start = i + 1;
  }
  const selectors = preludes.filter((p) => p && p[0] !== '@');
  check('the hero section has rules', selectors.length >= 6, selectors.length);
  for (const sel of selectors) {
    for (const part of sel.split(',')) {
      check('hero rule scoped under .home.is-hero: ' + part.trim(), /^\.home\.is-hero(\s|$)/.test(part.trim()));
    }
  }
  for (const at of preludes.filter((p) => p && p[0] === '@')) {
    check('hero at-rule is a fold query: ' + at, /^@container\s+(not\s+)?style\(--home-fold:\s*1\)$/.test(at));
  }
  check('nothing in the hero animates', !/\b(animation|transition)\s*:/.test(section));
  check('no accent and no glow in the hero', !/--ion\b|box-shadow|drop-shadow/.test(section));
  check('the hero clock uses the display face', /\.home\.is-hero \.mod-time-value\s*\{[^}]*var\(--font-display\)/.test(section));
  const size = /\.home\.is-hero \.mod-time-value\s*\{[^}]*font:\s*\d+\s+(\d+)px/.exec(section);
  check('the hero clock is 64-72px', size && +size[1] >= 64 && +size[1] <= 72, size && size[1]);
  check('the hero size carries a css-lint allow', /68px\/76px var\(--font-display\);\s*\/\* css-lint: allow raw-font-size \S/.test(CSS.slice(a, b)));
  check('the Q sits out in the hero', /\.home\.is-hero \.home-logo\s*\{\s*display:\s*none/.test(section));
  check('the date is --text-2 in the hero', /\.home\.is-hero \.mod-date\s*\{[^}]*color:\s*var\(--text-2\)/.test(section));
})();

/* ------------------------------------------------------- 4. session geometry */
(function sessionGeometry() {
  const css = stripComments(CSS);
  function body(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(^|\\n|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}').exec(css);
    return m ? m[2] : null;
  }
  function px(sel, prop) {
    const b = body(sel);
    if (b === null) return NaN;
    const m = new RegExp('(^|;|\\s)' + prop + '\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px').exec(b);
    return m ? Number(m[2]) : NaN;
  }
  const sess = body('.module-session');
  check('.module-session rule exists', sess !== null);
  if (sess !== null) {
    check('session: no border', /border:\s*0/.test(sess));
    check('session: no fill', /background:\s*none/.test(sess));
    check('session: no shadow', /box-shadow:\s*none/.test(sess));
    check('session: no padding', /padding:\s*0/.test(sess));
    check('session keeps the card width (no width of its own)', !/(^|\s|;)width\s*:/.test(sess));
  }
  check('.module is still 224px wide', px('.module', 'width') === 224);
  const line = px('.sess-line', 'height');
  const gap = px('.sess-lines', 'gap');
  const musicTop = px('.mod-music', 'margin-top');
  const row = px('.mod-music-row', 'height');
  const claudeTop = px('.mod-music + .sess-line', 'margin-top');
  const pill = px('.sess-pill', 'height');
  check('pill and line are 30px', line === 30 && pill === 30, { line, pill });
  // Today's card: 14+14 padding, 2 border, two 24px rows + 4, the music block 10 + 18 + 6 + 22 + 4 + 16.
  const CARD = 14 + 14 + 2 + 24 + 4 + 24 + 10 + 18 + 6 + 22 + 4 + 16;
  const fullest = line + gap + line + musicTop + row + claudeTop + line;
  check('fullest session (4 lines) is under the old card', Number.isFinite(fullest) && fullest <= CARD, { fullest, CARD });
  check('music-only session is under the old music-only card', row <= CARD - (14 + 14 + 2 + 24 + 4 + 24 + 10) + 10 + 30, row);
  check('a line never wraps (nowrap pills, ellipsis labels)', /white-space:\s*nowrap/.test(body('.sess-pill') || '') &&
    /text-overflow:\s*ellipsis/.test(body('.sess-label') || '') && !/flex-wrap\s*:\s*wrap/.test(body('.sess-line') || ''));
  const pillBody = (body('.sess-pill') || '') + (body('.mod-music-row') || '');
  check('no blur, border or shadow box on the pills', !/backdrop-filter|box-shadow|border\s*:/.test(pillBody) &&
    !/backdrop-filter/.test(sess || ''));
  check('no hover on a pill', !/\.sess-(pill|line|lines|value|label)[^{]*:hover/.test(css));
  check('[hidden] rules for the flex boxes', /\.sess-lines\[hidden\]\s*\{\s*display:\s*none/.test(css) &&
    /\.sess-line\[hidden\]\s*\{\s*display:\s*none/.test(css) && /\.sess-pill\[hidden\]\s*\{\s*display:\s*none/.test(css));
  check('the waiting mark is the waiting token, no glow', /\.sess-waiting::before\s*\{[^}]*var\(--st-waiting\)/.test(css) &&
    !/\.sess-waiting[^{]*\{[^}]*(box-shadow|filter)/.test(css));
  check('the music button keeps its reduced-motion cut', /prefers-reduced-motion[\s\S]*\.mod-music-btn[\s\S]*transition:\s*none/.test(css));

  // Every id newtab.js reads for the session and the music is in the markup, once.
  const ids = ['mod-session', 'session-rows', 'read-tabs', 'read-tabs-label', 'read-autopause', 'pill-tabs', 'pill-autopause',
    'pill-blocked', 'read-blocked', 'read-blocked-label', 'session-claude', 'pill-claude', 'read-claude-working',
    'read-claude-sep', 'read-claude-waiting', 'mod-music', 'music-state', 'music-toggle', 'music-next'];
  for (const id of ids) {
    const n = (HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    check('newtab.html has #' + id + ' once', n === 1, n);
  }
  check('the session piece is still data-piece="session" data-kind="card"', /id="mod-session"[^>]*data-piece="session" data-kind="card"/.test(HTML));
  check('idle music keeps data-music', /id="mod-music" class="mod-music" data-music="off"/.test(HTML));
  check('window.__music and __applyMusic still exist', /window\.__music = function/.test(NEWTAB_JS) && /window\.__applyMusic = function/.test(NEWTAB_JS));
})();

/* ------------------------------------------------------- 5. readout payload */
(function readoutPayload() {
  function fake(text) {
    return { hidden: false, textContent: text || '', title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  }
  const el = {
    readTabs: fake('--'), readTabsLabel: fake('tabs open'), readAutopause: fake('Unknown'), readBlocked: fake(''),
    readBlockedLabel: fake('blocked'), readClaudeWorking: fake(''), readClaudeSep: fake(''), readClaudeWaiting: fake('')
  };
  // A pill's textContent is its children's, read live (as the DOM does, [hidden] or not).
  function pill(read) { const p = fake(); Object.defineProperty(p, 'textContent', { get: read }); return p; }
  el.pillTabs = pill(() => el.readTabs.textContent + ' ' + el.readTabsLabel.textContent);
  el.pillAutopause = pill(() => 'Spotify auto-pause ' + el.readAutopause.textContent);
  el.pillBlocked = pill(() => el.readBlocked.textContent + ' ' + el.readBlockedLabel.textContent);
  el.pillClaude = pill(() => 'Claude ' + el.readClaudeWorking.textContent + ' ' + el.readClaudeSep.textContent + ' ' +
    el.readClaudeWaiting.textContent);
  el.sessionClaude = fake();
  el.sessionClaude.hidden = true;
  el.pillBlocked.hidden = true;
  const ctx = vm.createContext(Object.assign({ Object: Object, String: String, Number: Number, Array: Array, isFinite: isFinite, Math: Math }, el));
  vm.runInContext(
    cutConst(NEWTAB_JS, 'AUTOPAUSE_TEXT', '};') + '\n' + cutConst(NEWTAB_JS, 'AUTOPAUSE_TITLE', '};') + '\n' +
    'let readoutState = null;\n' +
    ['setText', 'readoutCount', 'readoutWhole', 'cleanReadout', 'blockedWords', 'paintReadout', 'readoutPillText']
      .map((n) => cutFunction(NEWTAB_JS, n)).join('\n') +
    '\nthis.cleanReadout = cleanReadout;' +
    '\nthis.paint = function (d) { readoutState = cleanReadout(d); paintReadout(); return {' +
    ' tabs: readoutPillText(pillTabs), autopause: readoutPillText(pillAutopause), blocked: readoutPillText(pillBlocked),' +
    ' claude: sessionClaude.hidden ? \'\' : readoutPillText(pillClaude) }; };',
    ctx);
  const clean = (d) => JSON.parse(JSON.stringify(ctx.cleanReadout(d)));

  eq('an older chrome: tabs + autopause only, no optional pills', clean({ tabs: 3, autopause: 'on' }),
    { tabs: 3, autopause: 'on', claude: null, blocked: null });
  eq('garbage payload', clean('nope'), { tabs: null, autopause: 'unknown', claude: null, blocked: null });
  eq('an old numeric claude count is ignored', clean({ tabs: 1, autopause: 'off', claude: 2 }).claude, null);
  eq('claude counts', clean({ claude: { working: 2, waiting: 1 } }).claude, { working: 2, waiting: 1 });
  eq('claude: a negative half drops the field', clean({ claude: { working: -1, waiting: 1 } }).claude, null);
  eq('claude: a fraction drops the field', clean({ claude: { working: 1.5, waiting: 0 } }).claude, null);
  eq('claude: a string drops the field', clean({ claude: { working: '2', waiting: 0 } }).claude, null);
  eq('claude: an array drops the field', clean({ claude: [1, 2] }).claude, null);
  eq('blocked on', clean({ blocked: { enabled: true, count: 128 } }).blocked, { enabled: true, ready: true, count: 128 });
  eq('blocked not ready', clean({ blocked: { enabled: true, ready: false, count: 0 } }).blocked, { enabled: true, ready: false, count: 0 });
  eq('blocked off', clean({ blocked: { enabled: false, ready: false, count: 40 } }).blocked, { enabled: false, ready: false, count: 40 });
  eq('blocked: enabled must be a boolean', clean({ blocked: { enabled: 1, count: 3 } }).blocked, null);
  eq('blocked: NaN count drops the field', clean({ blocked: { enabled: true, count: NaN } }).blocked, null);
  eq('blocked: huge count drops the field', clean({ blocked: { enabled: true, count: 1e12 } }).blocked, null);
  eq('blocked: null', clean({ blocked: null }).blocked, null);
  eq('unknown autopause word', clean({ autopause: 'sideways' }).autopause, 'unknown');

  let p = ctx.paint({ tabs: 1, autopause: 'unknown' });
  eq('one tab reads "1 tab open"', p.tabs, '1 tab open');
  eq('unknown auto-pause still says something', p.autopause, 'Spotify auto-pause Unknown');
  eq('no blocked field: the pill is hidden', p.blocked, '');
  eq('no claude field: the pill is hidden', p.claude, '');
  p = ctx.paint({ tabs: 12, autopause: 'holding', blocked: { enabled: true, ready: true, count: 128 }, claude: { working: 2, waiting: 0 } });
  eq('tabs pill', p.tabs, '12 tabs open');
  eq('holding in words', p.autopause, 'Spotify auto-pause Holding');
  eq('blocked count', p.blocked, '128 blocked');
  check('blocked title explains the count', /since it opened/.test(el.pillBlocked.title), el.pillBlocked.title);
  eq('only the working half', p.claude, 'Claude 2 working');
  p = ctx.paint({ tabs: 2, autopause: 'on', blocked: { enabled: false, ready: false, count: 5 }, claude: { working: 0, waiting: 3 } });
  eq('blocking off says so', p.blocked, 'Blocker off');
  eq('only the waiting half', p.claude, 'Claude 3 waiting');
  eq('waiting is marked for the dot', el.pillClaude.attrs['data-waiting'], 'true');
  p = ctx.paint({ tabs: 2, autopause: 'off', blocked: { enabled: true, ready: false, count: 0 }, claude: { working: 1, waiting: 1 } });
  eq('not ready says so', p.blocked, 'Blocker not ready');
  eq('both halves with the separator', p.claude, 'Claude 1 working / 1 waiting');
  p = ctx.paint({ tabs: 2, autopause: 'off', claude: { working: 0, waiting: 0 } });
  eq('no Claude pane: no Claude pill', p.claude, '');
  eq('blocked pill hides again when the field goes', p.blocked, '');
})();

/* ------------------------------------------------------- 6. app.js tally + snapshot */
(function appReadout() {
  const ctx = vm.createContext({ Number: Number, Map: Map, Object: Object });
  vm.runInContext(
    'let tabs = []; let autopauseReadout = "on"; let blockedEnabled = null; let blockedReady = false;\n' +
    'const blockedTally = { total: 0, last: new Map() };\n' +
    'function isClaudeProgramTab(t) { return t.kind === "claude" && t.program === "claude"; }\n' +
    ['blockedTallyStep', 'claudeReadout', 'readoutSnapshot'].map((n) => cutFunction(APP_JS, n)).join('\n') +
    '\nthis.step = blockedTallyStep; this.claudeReadout = claudeReadout; this.snapshot = readoutSnapshot;' +
    '\nthis.setTabs = function (t) { tabs = t; }; this.setBlocked = function (e, r, n) { blockedEnabled = e; blockedReady = r; blockedTally.total = n; };',
    ctx);
  const t = { total: 0, last: new Map() };
  const s = (p, cap) => ctx.step(t, p, cap || 256);
  eq('first count is all new', s({ wcId: 1, blocked: 5 }), 5);
  eq('a rise adds the difference', s({ wcId: 1, blocked: 9 }), 4);
  eq('the same count adds nothing', s({ wcId: 1, blocked: 9 }), 0);
  eq('a drop (navigation) adds the new count whole', s({ wcId: 1, blocked: 3 }), 3);
  eq('a second page counts on its own', s({ wcId: 2, blocked: 10 }), 10);
  eq('running total', t.total, 22);
  eq('malformed: no wcId', s({ blocked: 4 }), 0);
  eq('malformed: string wcId', s({ wcId: '1', blocked: 4 }), 0);
  eq('malformed: negative count', s({ wcId: 3, blocked: -2 }), 0);
  eq('malformed: NaN count', s({ wcId: 3, blocked: 'x' }), 0);
  eq('malformed: null payload', s(null), 0);
  eq('total untouched by malformed input', t.total, 22);
  for (let i = 100; i < 110; i++) s({ wcId: i, blocked: 1 }, 4);
  check('the page map is bounded', t.last.size === 4, t.last.size);
  check('the most recently heard pages are the ones kept', t.last.has(109) && !t.last.has(1));

  ctx.setTabs([{ kind: 'claude', program: 'claude', needsYou: true }, { kind: 'claude', program: 'claude' },
    { kind: 'claude', program: 'pwsh', needsYou: true }, { kind: 'web' }]);
  eq('claude: shells do not count, waiting = needsYou', JSON.parse(JSON.stringify(ctx.claudeReadout([
    { kind: 'claude', program: 'claude', needsYou: true }, { kind: 'claude', program: 'claude' },
    { kind: 'claude', program: 'pwsh', needsYou: true }, { kind: 'web' }]))), { working: 1, waiting: 1 });
  eq('snapshot before the shield answers has no blocked field', JSON.parse(JSON.stringify(ctx.snapshot())),
    { tabs: 4, autopause: 'on', claude: { working: 1, waiting: 1 } });
  ctx.setBlocked(true, true, 128);
  eq('snapshot with the shield on', JSON.parse(JSON.stringify(ctx.snapshot())).blocked, { enabled: true, ready: true, count: 128 });
  ctx.setBlocked(false, false, 128);
  eq('snapshot with the shield off', JSON.parse(JSON.stringify(ctx.snapshot())).blocked, { enabled: false, ready: false, count: 128 });

  // The wiring, read as source: a second listener on the shield's own channel, throttled, through the memoised push.
  const wire = cutFunction(APP_JS, 'wireBlockedReadout');
  check('blocked listens on api.adblock.onUpdate (no new IPC)', /ab\.onUpdate\(/.test(wire) && /ab\.onStateChanged\(/.test(wire) && /ab\.state\(\)/.test(wire));
  check('blocked is feature-detected', /typeof ab\.onUpdate !== 'function'/.test(wire));
  const sched = cutFunction(APP_JS, 'scheduleBlockedPush');
  check('blocked pushes are throttled and go through pushReadoutToAll', /BLOCKED_PUSH_MS/.test(sched) && /pushReadoutToAll\(\)/.test(sched) && /if \(blockedPushTimer\) return/.test(sched));
  check('wireAutopauseReadout wires the blocked readout', /wireBlockedReadout\(\)/.test(cutFunction(APP_JS, 'wireAutopauseReadout')));
  check('markClaudeNeedsYou pushes the readout', /pushReadoutToAll\(\);\s*\}$/.test(cutFunction(APP_JS, 'markClaudeNeedsYou')));
  check('clearClaudeNeedsYou pushes the readout', /pushReadoutToAll\(\);\s*\}$/.test(cutFunction(APP_JS, 'clearClaudeNeedsYou')));
})();

console.log('home-design: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
