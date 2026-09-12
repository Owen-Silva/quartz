/* ============================================================
   newtab.js — the new tab page's own behaviour.

   There is no search field on this page: the window's address bar
   is where it searches. What sits in the field's old place is the
   instrument strip, five readouts the chrome pushes in every two
   seconds through window.__applyStats().

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.

   The browser's settings reach it two ways:

     1. query params, for the first paint —
        ?theme=dark&palette=ocean&hue=300&chips=<JSON>&bg=image
        (every param optional; theme, palette and hue are handled
        earlier, in newtab-theme.js, so colour never flashes)

     2. window.__applySettings({ accentHue, palette, chips })
        pushed later with executeJavaScript. A null or missing
        field means "back to this page's own default". searchEngine
        may still arrive and is ignored: nothing here searches.

     3. window.__applyBackground({ kind, boardOverImage, dim, dataUrl })
        pushed the same way, because the picture is a data: URL far too
        big to hang off the URL.

     4. window.__applyStats(sample) every second while this guest is
        the one on screen — see "the instrument strip" below. The
        sample carries the process list the lower half of the capsule
        shows.

     5. window.__applyEndTask({ key, results }) — the answer to the one
        thing this page asks the browser FOR: a console line,
        `newtab:end-task {"pids":[...],"key":"..."}`, which the chrome
        reads off this guest and runs. There is no preload here, so a
        logged line is the whole channel; see "the process list".

     6. window.__applyApps({ pins, installed }) — the native programs
        pinned into the capsule, and the index the picker filters.
        window.__applyAppsRunning(map) keeps their running lights current
        once a second, and window.__applyAppResult(r) answers the lines
        the dock logs: `newtab:app {"action":"launch"|"focus"|"pin"|
        "unpin"|"refresh",...}`, read off this guest the same way.

     7. window.__applyProcIcons({ key: dataUrl|null }) — the real
        executable's icon for a process group, resolved by the main
        process and pushed whenever an answer comes back. It only
        fills slots the rows already wear; no row is rebuilt for it.

     8. window.__applyMusic({ enabled, playing, source, title, where })
        — the state of the chrome's idle player, pushed on every change
        and when this guest loads. Its three controls answer the same
        way the dock does: `newtab:music {"action":"toggle"|"next"|
        "enable"}`; see "idle music".

     9. window.__applyMedia({ ok, source, title, artist, album, status,
        positionMs, durationMs, art, canNext, canPrev }) — what the
        MACHINE is playing, off the media session the chrome polls. Its
        transport answers the same way: `newtab:media {"cmd":"toggle"|
        "next"|"prev"}`; see "now playing".
   ============================================================ */

'use strict';

/* The shortcut row, used whenever the browser sends no chips of its own. */
const LINKS = [
  { label: 'Wiki',      url: 'https://www.wikipedia.org' },
  { label: 'GitHub',    url: 'https://github.com' },
  { label: 'YouTube',   url: 'https://www.youtube.com' },
  { label: 'Gmail',     url: 'https://mail.google.com' },
  { label: 'Claude',    url: 'https://claude.ai' },
];

/* One shared favicon service; the chip falls back to its label if it 404s. */
const FAVICON_URL = 'https://www.google.com/s2/favicons?domain=';

/* Recent sites. The chrome may hand us more than we show: we accept up to
   RECENT_ACCEPT and draw at most RECENT_LIMIT tiles under the shortcuts. */
const RECENT_ACCEPT = 8;
const RECENT_LIMIT = 6;

/* ------------------------------------------------------------------ */
/* URL handling — only ever validation, never navigation               */
/* ------------------------------------------------------------------ */

function parseUrlOrNull(text) {
  try {
    return new URL(text);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/* The chip list the chrome sent (null = LINKS). */
let chipList = null;

/* Validated recents, most recent first, deduped by host. [] until the
   chrome pushes some in with __applyRecent(). */
let recentList = [];

/** One host, compared the way a person would: case- and www-blind. */
function hostKey(hostname) {
  return String(hostname == null ? '' : hostname).toLowerCase().replace(/^www\./, '');
}

/**
 * Validate one chip list from the chrome. Keeps only entries with an
 * http(s) url; a missing label becomes the bare hostname. Anything that
 * is not an array yields null, meaning "use LINKS".
 */
function normalizeChips(list) {
  if (!Array.isArray(list)) return null;

  const out = [];

  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;

    const parsed = parseUrlOrNull(item.url.trim());
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const host = parsed.hostname.replace(/^www\./i, '');
    const label = (typeof item.label === 'string' && item.label.trim())
      ? item.label.trim()
      : host;

    out.push({ label: label, url: parsed.href, host: parsed.hostname });
  }

  return out;
}

/* LINKS goes through the same validator, so every rendered chip has a host. */
const DEFAULT_CHIPS = normalizeChips(LINKS) || [];

/** Whatever should be on screen right now. */
function currentChips() {
  return chipList || DEFAULT_CHIPS;
}

/**
 * Validate one recent list from the chrome: [{ url, title, last }, …],
 * most recent first. http(s) only, one entry per host (the first, i.e. the
 * most recent, wins), at most RECENT_ACCEPT of them. `last` is carried by
 * the chrome for its own ordering and is not read here.
 */
function normalizeRecent(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;

    const parsed = parseUrlOrNull(item.url.trim());
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const key = hostKey(parsed.hostname);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const label = (typeof item.title === 'string' && item.title.trim())
      ? item.title.trim()
      : key;

    out.push({ label: label, url: parsed.href, host: parsed.hostname, key: key });
    if (out.length >= RECENT_ACCEPT) break;
  }

  return out;
}

/**
 * The recents worth drawing: anything already sitting in the shortcut row
 * is one click away, so it is dropped rather than shown twice.
 */
function visibleRecent() {
  const chipHosts = new Set(currentChips().map(function (chip) { return hostKey(chip.host); }));
  const out = [];

  for (const item of recentList) {
    if (chipHosts.has(item.key)) continue;
    out.push(item);
    if (out.length >= RECENT_LIMIT) break;
  }

  return out;
}

/** ?chips=<encodeURIComponent(JSON)>. Malformed JSON is ignored, not fatal. */
function parseChipsParam(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function setChips(list) {
  chipList = normalizeChips(list);
  renderLinks();
  renderRecent();          // a new chip host may hide (or free) a recent tile
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const linkRow = document.getElementById('links');
const recentRow = document.getElementById('recent');

/* What the nav currently shows, so a settings push that changes nothing
   does not rebuild the row (and re-request every favicon). */
let renderedKey = null;

/* The same trick for the recent row: a repeated push leaves the DOM (and
   its favicons) exactly where it was. */
let renderedRecentKey = null;

function faviconUrl(host) {
  return FAVICON_URL + encodeURIComponent(host) + '&sz=32';
}

/**
 * One 16px favicon. A blocked or missing icon must not leave a hole, so
 * the <img> removes itself on error and the row keeps its normal padding.
 */
function faviconImg(host, className) {
  const icon = document.createElement('img');
  icon.className = className;
  icon.src = faviconUrl(host);
  icon.width = 16;
  icon.height = 16;
  icon.alt = '';
  icon.loading = 'lazy';
  icon.setAttribute('aria-hidden', 'true');
  icon.onerror = function () {
    if (icon.parentNode) icon.parentNode.removeChild(icon);
  };
  return icon;
}

/** Identity of a chip list, cheap enough to compare on every push. */
function chipsKey(list) {
  return list.map(function (item) { return item.url + ' ' + item.label; }).join('\n');
}

/** Build the shortcut chips from the current list. */
function renderLinks() {
  if (!linkRow) return;

  const list = currentChips();
  const key = chipsKey(list);
  if (key === renderedKey) return;      // nothing moved: leave the DOM alone
  renderedKey = key;

  const frag = document.createDocumentFragment();

  for (const item of list) {
    const chip = document.createElement('a');
    chip.className = 'chip';
    chip.href = item.url;

    if (item.host) chip.appendChild(faviconImg(item.host, 'chip-icon'));

    chip.appendChild(document.createTextNode(item.label));
    frag.appendChild(chip);
  }

  linkRow.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* Recent sites                                                        */
/* ------------------------------------------------------------------ */

/** Build the small tile row under the shortcuts. Hidden when empty. */
function renderRecent() {
  if (!recentRow) return;

  const list = visibleRecent();
  const key = list.map(function (item) { return item.url; }).join('\n');
  if (key === renderedRecentKey) return;   // same sites: leave the favicons alone
  renderedRecentKey = key;

  const frag = document.createDocumentFragment();

  if (!list.length) {
    recentRow.replaceChildren(frag);
    recentRow.hidden = true;
    return;
  }

  const caption = document.createElement('p');
  caption.className = 'recent-caption';
  caption.appendChild(document.createTextNode('Recent'));
  frag.appendChild(caption);

  for (const item of list) {
    const tile = document.createElement('a');
    tile.className = 'rtile';
    tile.href = item.url;
    tile.title = item.host;

    tile.appendChild(faviconImg(item.host, 'rtile-icon'));

    const label = document.createElement('span');
    label.className = 'rtile-label';
    label.appendChild(document.createTextNode(item.label));
    tile.appendChild(label);

    frag.appendChild(tile);
  }

  recentRow.replaceChildren(frag);
  recentRow.hidden = false;
}

/* ------------------------------------------------------------------ */
/* The clock module                                                    */
/*                                                                     */
/* One timeout, aligned to the next minute, rescheduled from inside     */
/* itself. No setInterval and no per-second tick: nothing on this face  */
/* changes between minutes, and a timer that fires sixty times for one  */
/* repaint is sixty wake-ups of a guest that is often not even on       */
/* screen. A hidden page's timers are throttled, so coming back from    */
/* hidden — or from a restored webview — repaints and re-aligns rather  */
/* than trusting the timer that was asleep.                            */
/* ------------------------------------------------------------------ */

const clockTime = document.getElementById('clock-time');
const clockPeriod = document.getElementById('clock-period');
const clockDate = document.getElementById('clock-date');

let clockTimer = 0;

/** Write only when it actually changed: this runs on every window focus. */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * The time as the window's own locale states it, with the meridiem split
 * out: "9:05" + "AM" in a 12-hour locale, "09:05" + "" in a 24-hour one,
 * so the big readout is only ever digits and the AM/PM can sit small
 * beside it.
 */
function clockParts(now) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
      .formatToParts(now);
    let time = '';
    let period = '';

    for (const part of parts) {
      if (part.type === 'dayPeriod') period = part.value;
      else if (part.type === 'literal' && !part.value.trim()) continue;  // the space before AM
      else time += part.value;
    }

    if (time) return { time: time, period: period };
  } catch (err) {
    /* no Intl, or a locale it cannot build: fall through to 24-hour */
  }

  const m = now.getMinutes();
  return { time: now.getHours() + ':' + (m < 10 ? '0' + m : String(m)), period: '' };
}

/** "Thursday, 11 September" — whichever order the locale puts it in. */
function clockDateText(now) {
  try {
    return now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (err) {
    return '';
  }
}

function paintClock() {
  const now = new Date();
  const parts = clockParts(now);
  setText(clockTime, parts.time);
  setText(clockPeriod, parts.period);
  setText(clockDate, clockDateText(now));
}

function scheduleClock() {
  if (clockTimer) clearTimeout(clockTimer);
  const now = new Date();
  // Just after the turn, never on it: a timer that fires a few ms early
  // paints the minute it is already showing and then has to do it twice.
  const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  clockTimer = setTimeout(function () {
    clockTimer = 0;
    paintClock();
    scheduleClock();
  }, Math.max(250, wait));
}

/** Back on screen: the throttled timer may be up to a minute behind. */
function refreshClock() {
  if (document.hidden) return;
  paintClock();
  scheduleClock();
}

/* ------------------------------------------------------------------ */
/* The session readout                                                 */
/*                                                                     */
/* The chrome pushes it in on every tab change and every status change: */
/*                                                                     */
/*   window.__applyReadout({ tabs, claude, autopause })                 */
/*     tabs       number of open tabs                                   */
/*     claude     number of live Claude sessions                        */
/*     autopause  'off' | 'on' | 'holding' | 'unknown'                  */
/*                                                                     */
/* The tile is [hidden] until the first call, because a readout of      */
/* three dashes is worse than no readout — and because a hidden tile    */
/* has no box, which is exactly what the board needs to know. Showing   */
/* it therefore re-seats it on the board (see __boardRelayout).         */
/* ------------------------------------------------------------------ */

const sessionModule = document.getElementById('mod-session');
/* The three counts, so they can stay hidden while the tile is on screen:
   the idle-music module below shares this tile and can be the thing that
   reveals it, and three dashes are still worse than no readout. */
const sessionRows = document.getElementById('session-rows');
const readTabs = document.getElementById('read-tabs');
const readTabsLabel = document.getElementById('read-tabs-label');
const readClaude = document.getElementById('read-claude');
const readClaudeLabel = document.getElementById('read-claude-label');
const readAutopause = document.getElementById('read-autopause');

/* Sentence case, and the only four states the bridge can be in. */
const AUTOPAUSE_TEXT = { off: 'Off', on: 'On', holding: 'Holding', unknown: '--' };

let readoutState = { tabs: null, claude: null, autopause: 'unknown' };

/** A count, or null for "the chrome did not say". Never negative. */
function readoutCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function paintReadout() {
  const tabs = readoutState.tabs;
  const claude = readoutState.claude;

  setText(readTabs, tabs === null ? '--' : String(tabs));
  setText(readTabsLabel, tabs === 1 ? 'tab open' : 'tabs open');
  setText(readClaude, claude === null ? '--' : String(claude));
  setText(readClaudeLabel, claude === 1 ? 'Claude session' : 'Claude sessions');
  setText(readAutopause, AUTOPAUSE_TEXT[readoutState.autopause]);
}

window.__applyReadout = function (data) {
  const next = (data && typeof data === 'object') ? data : {};
  const mode = String(next.autopause == null ? 'unknown' : next.autopause).toLowerCase();

  readoutState = {
    tabs: readoutCount(next.tabs),
    claude: readoutCount(next.claude),
    autopause: Object.prototype.hasOwnProperty.call(AUTOPAUSE_TEXT, mode) ? mode : 'unknown'
  };
  paintReadout();

  const grew = revealSession(sessionRows && sessionRows.hidden);
  if (sessionRows) sessionRows.hidden = false;
  if (grew) {
    // It has a box now: the board has to seat it and route around it.
    if (typeof window.__boardRelayout === 'function') window.__boardRelayout();
  }

  return window.__readout();
};

/**
 * Show the tile these two modules share, and say whether its box changed.
 * Both pushes go through here: whichever lands first is what puts the tile
 * on screen, and only a real change of size costs a board relayout.
 */
function revealSession(alsoGrowing) {
  let changed = !!alsoGrowing;
  if (sessionModule && sessionModule.hidden) {
    sessionModule.hidden = false;
    changed = true;
  }
  return changed;
}

/** What the readout actually shows, for tests. */
window.__readout = function () {
  return {
    tabs: readoutState.tabs,
    claude: readoutState.claude,
    autopause: readoutState.autopause,
    /* The counts, not the tile: idle music can have the tile on screen
       before a readout has ever landed. */
    shown: !!(sessionModule && !sessionModule.hidden &&
              sessionRows && !sessionRows.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* Idle music                                                          */
/*                                                                     */
/* Quiet music while nothing else on the machine is playing. The player */
/* itself lives in the CHROME so it survives tab switches; this module  */
/* is only its face, and it shares the readout tile because the board   */
/* seats exactly two tiles (newtab-bg.js MODULE_SPEC is the contract).  */
/*                                                                     */
/* In, on every state change and when this guest loads:                 */
/*                                                                     */
/*   window.__applyMusic({ enabled, playing, source, title, where })    */
/*     enabled  the feature is on at all                               */
/*     playing  the chrome is making sound right now                   */
/*     source   'ambient' (the built-in engine) | 'files' (his own)     */
/*     title    the mood name, or the track's name for files           */
/*     where    'newtab' | 'anywhere' — carried through for the chrome  */
/*              and for tests; the module reads the same either way    */
/*                                                                     */
/* Out, one console line the chrome reads off this guest, exactly the   */
/* way end-task and the dock do:                                       */
/*                                                                     */
/*   newtab:music {"action":"toggle"|"next"|"enable"}                   */
/*                                                                     */
/* Never hidden while the tile is up, and shown with an "Off" state and */
/* a control that turns it on — a feature nobody can find is a feature  */
/* nobody has. Cost: no timer, no animation, nothing sampled. A module  */
/* saying "Off" costs one repaint of four fixed boxes, once.            */
/* ------------------------------------------------------------------ */

const musicModule = document.getElementById('mod-music');
const musicState = document.getElementById('music-state');
const musicToggle = document.getElementById('music-toggle');
const musicNext = document.getElementById('music-next');

/* A track name off the disk can be any length; the state line ellipsises
   it in CSS, and this keeps a pathological one out of the DOM at all. */
const MUSIC_TITLE_MAX = 60;

const MUSIC_SOURCES = { ambient: true, files: true };
const MUSIC_WHERE = { newtab: true, anywhere: true };

let musicData = {
  enabled: false,
  playing: false,
  source: 'ambient',
  title: '',
  where: 'newtab'
};

/** One line of text, trimmed and collapsed. '' for "the chrome did not say". */
function musicTitleText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MUSIC_TITLE_MAX ? text.slice(0, MUSIC_TITLE_MAX - 1) + '…' : text;
}

/** One of the four words the state line can be in. */
function musicStateName() {
  if (!musicData.enabled) return 'off';
  return musicData.playing ? 'playing' : 'paused';
}

/**
 * What the state line says. Playing shows the mood or the track — that is
 * the whole point of the line — and falls back to "Playing" for a chrome
 * that has not named it yet. Off and Paused are the states themselves.
 */
function musicLine() {
  if (!musicData.enabled) return 'Off';
  if (!musicData.playing) return 'Paused';
  return musicData.title || 'Playing';
}

/** The word on the control, and the action it sends. */
function musicAction() {
  if (!musicData.enabled) return { label: 'Turn on', action: 'enable' };
  return musicData.playing
    ? { label: 'Pause', action: 'toggle' }
    : { label: 'Play', action: 'toggle' };
}

/** Next is his own tracks only: there is no next chord in a generative pad. */
function musicHasNext() {
  return !!musicData.enabled && musicData.source === 'files';
}

function paintMusic() {
  const line = musicLine();
  const act = musicAction();

  setText(musicState, line);
  if (musicModule) musicModule.setAttribute('data-music', musicStateName());

  if (musicToggle) {
    setText(musicToggle, act.label);
    musicToggle.setAttribute('data-action', act.action);
    /* The word is the label, so the only thing left to say out loud is
       what it is the word of. */
    musicToggle.setAttribute('aria-label', act.label + ' idle music');
  }

  if (musicNext) {
    const has = musicHasNext();
    // [disabled] is what hides it (visibility, in CSS) and what keeps it
    // out of the tab order: the box stays either way, so the row does not
    // change size when his own tracks come and go.
    musicNext.disabled = !has;
    musicNext.setAttribute('aria-hidden', has ? 'false' : 'true');
  }
}

/** The channel out. One line, the same shape end-task and the dock use. */
function musicSend(action) {
  console.log('newtab:music ' + JSON.stringify({ action: action }));
}

function wireMusic() {
  if (musicToggle) {
    musicToggle.addEventListener('click', function () {
      musicSend(musicAction().action);
    });
  }

  if (musicNext) {
    musicNext.addEventListener('click', function () {
      if (!musicHasNext()) return;
      musicSend('next');
    });
  }

  /* The Off state the markup already wears, painted once so the attribute
     and the control's label come from exactly one place. */
  paintMusic();
}

window.__applyMusic = function (data) {
  const next = (data && typeof data === 'object') ? data : {};

  const source = String(next.source == null ? '' : next.source).toLowerCase();
  const where = String(next.where == null ? '' : next.where).toLowerCase();

  musicData = {
    enabled: !!next.enabled,
    playing: !!next.enabled && !!next.playing,
    source: MUSIC_SOURCES[source] ? source : 'ambient',
    title: musicTitleText(next.title),
    where: MUSIC_WHERE[where] ? where : 'newtab'
  };
  paintMusic();

  /* An idle-music push can be the first thing that lands, so it reveals
     the tile the same way a readout does — with the three counts still
     hidden until the chrome has actually counted something. */
  if (revealSession(false)) {
    if (typeof window.__boardRelayout === 'function') window.__boardRelayout();
  }

  return window.__music();
};

/** What the module actually shows, for tests. */
window.__music = function () {
  return {
    enabled: musicData.enabled,
    playing: musicData.playing,
    source: musicData.source,
    title: musicData.title,
    where: musicData.where,
    state: musicStateName(),
    line: musicState ? musicState.textContent : '',
    control: musicToggle ? musicToggle.textContent : '',
    action: musicAction().action,
    next: musicHasNext(),
    shown: !!(sessionModule && !sessionModule.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* Now playing                                                         */
/*                                                                     */
/* What the MACHINE is playing, and its transport. Nothing plays in     */
/* this page: the chrome polls the user's Spotify auto-pause bridge, which  */
/* already holds a Windows media session, and pushes the state in       */
/* while a new tab is in front.                                        */
/*                                                                     */
/*   window.__applyMedia({ ok, source, title, artist, album, status,    */
/*                         positionMs, durationMs, art,                 */
/*                         canNext, canPrev })                          */
/*     ok          the bridge answered at all                           */
/*     status      'playing' | 'paused' | 'stopped' | 'none'            */
/*     art         base64 JPEG (or a data: URL), or null                */
/*     canNext     the session offers that control                      */
/*                                                                     */
/* Out, one console line the chrome reads off this guest, exactly the   */
/* way idle music and the dock do:                                     */
/*                                                                     */
/*   newtab:media {"cmd":"toggle"|"next"|"prev"}                        */
/*                                                                     */
/* Cost: the only thing running in here is the hairline, stepped four   */
/* times a second while something is PLAYING and stopped dead the       */
/* moment it is not — a transform on one element, so no layout and no   */
/* paint of anything else. The position is interpolated from the last   */
/* push rather than polled for, which is what lets the chrome poll the  */
/* bridge as slowly as it does; paused, the fill keeps the width it     */
/* had and nothing ticks at all. The art is decoded once per distinct   */
/* image, not once per push.                                           */
/* ------------------------------------------------------------------ */

const mediaModule = document.getElementById('mod-media');
const mediaArt = document.getElementById('media-art');
const mediaTitle = document.getElementById('media-title');
const mediaArtist = document.getElementById('media-artist');
const mediaFill = document.getElementById('media-fill');
const mediaPrev = document.getElementById('media-prev');
const mediaToggle = document.getElementById('media-toggle');
const mediaNext = document.getElementById('media-next');

/* A title off a media session can be any length; both lines ellipsise in
   CSS, and this keeps a pathological one out of the DOM at all. */
const MEDIA_TEXT_MAX = 80;

/* How often the hairline is stepped while playing. 250ms is a third of a
   pixel on a three-minute track — smooth at this width, and four style
   writes a second on a composited transform. */
const MEDIA_TICK_MS = 250;

/* The two states the tile has a face for; everything else is "nothing". */
const MEDIA_LIVE = { playing: true, paused: true };

let mediaData = {
  ok: false,
  source: '',
  title: '',
  artist: '',
  album: '',
  status: 'none',
  positionMs: 0,
  durationMs: 0,
  art: null,
  canNext: false,
  canPrev: false
};

/* When positionMs was true, so the fill can be interpolated from it. */
let mediaAt = 0;
/* The art string the <img> is currently showing: the stand-in for the
   bridge's artHash on this side, and what keeps one decode per image. */
let mediaArtKey = null;
let mediaTimer = 0;

/** One line of text, trimmed and collapsed. '' for "the session did not say". */
function mediaText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MEDIA_TEXT_MAX ? text.slice(0, MEDIA_TEXT_MAX - 1) + '…' : text;
}

/** Milliseconds, never negative and never a guess. */
function mediaMs(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * 'playing' | 'paused' | 'none'. A session with no title is nothing
 * playing however healthy it says it is: a tile with an empty first line
 * is worse than one that says so.
 */
function mediaState() {
  if (!mediaData.ok) return 'none';
  if (!MEDIA_LIVE[mediaData.status]) return 'none';
  if (!mediaData.title) return 'none';
  return mediaData.status;
}

/** How far through, 0..1. Interpolated only while it is playing. */
function mediaFraction(now) {
  const dur = mediaData.durationMs;
  if (!(dur > 0)) return 0;
  let pos = mediaData.positionMs;
  if (mediaState() === 'playing') pos += Math.max(0, now - mediaAt);
  if (pos < 0) pos = 0;
  if (pos > dur) pos = dur;
  return pos / dur;
}

/* scaleX on a positioned fill: the one way to move it that costs no
   layout. Written only when it actually changed. */
function paintMediaFill() {
  if (!mediaFill) return;
  const next = 'scaleX(' + mediaFraction(performance.now()).toFixed(4) + ')';
  if (mediaFill.style.transform !== next) mediaFill.style.transform = next;
}

/** One decode per distinct image, and none at all with no art. */
function paintMediaArt() {
  if (!mediaArt) return;
  const art = mediaState() === 'none' ? null : mediaData.art;

  if (!art) {
    if (mediaArtKey !== null) {
      // removeAttribute, never src='': an empty src is a request for this
      // page's own URL.
      mediaArt.removeAttribute('src');
      mediaArtKey = null;
    }
    mediaArt.hidden = true;
    return;
  }

  if (art !== mediaArtKey) {
    mediaArtKey = art;
    mediaArt.src = art.slice(0, 5) === 'data:' ? art : 'data:image/jpeg;base64,' + art;
  }
  mediaArt.hidden = false;
}

function paintMedia() {
  const state = mediaState();
  const live = state !== 'none';

  if (mediaModule) mediaModule.setAttribute('data-media', state);
  setText(mediaTitle, live ? mediaData.title : 'Nothing playing');
  setText(mediaArtist, live ? mediaData.artist : '');
  paintMediaArt();

  if (mediaToggle) {
    // [disabled] is what hides a control (visibility, in CSS) and what keeps
    // it out of the tab order: the box stays either way, so the transport is
    // the same size with nothing playing as with a full session.
    mediaToggle.disabled = !live;
    mediaToggle.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
  }
  if (mediaPrev) mediaPrev.disabled = !(live && mediaData.canPrev);
  if (mediaNext) mediaNext.disabled = !(live && mediaData.canNext);

  paintMediaFill();
}

/** The hairline runs while something plays, and nowhere else. */
function scheduleMediaTick() {
  const want = mediaState() === 'playing' && mediaData.durationMs > 0 &&
               !document.hidden;
  if (want && !mediaTimer) mediaTimer = setInterval(paintMediaFill, MEDIA_TICK_MS);
  else if (!want && mediaTimer) { clearInterval(mediaTimer); mediaTimer = 0; }
}

/** Back on screen, or gone: the tick follows the page. */
function refreshMedia() {
  if (!document.hidden) paintMediaFill();
  scheduleMediaTick();
}

/** The channel out. One line, the same shape idle music and the dock use. */
function mediaSend(cmd) {
  console.log('newtab:media ' + JSON.stringify({ cmd: cmd }));
}

function wireMedia() {
  const hit = function (el, cmd) {
    if (!el) return;
    el.addEventListener('click', function () {
      // A hidden control is not a control: [disabled] already stops the
      // click, and this is the same guard idle music's Next keeps.
      if (el.disabled) return;
      mediaSend(cmd);
    });
  };

  hit(mediaPrev, 'prev');
  hit(mediaToggle, 'toggle');
  hit(mediaNext, 'next');

  /* The "nothing playing" state the markup already wears, painted once so
     the attribute, the two lines and the three controls come from exactly
     one place. */
  paintMedia();
}

window.__applyMedia = function (data) {
  const next = (data && typeof data === 'object') ? data : {};
  const status = String(next.status == null ? '' : next.status).toLowerCase();
  const art = (typeof next.art === 'string' && next.art) ? next.art : null;

  mediaData = {
    /* A push with no `ok` at all is a push from something that answered:
       only an explicit false is the bridge saying it could not. */
    ok: (next.ok === undefined || next.ok === null) ? true : !!next.ok,
    source: mediaText(next.source),
    title: mediaText(next.title),
    artist: mediaText(next.artist),
    album: mediaText(next.album),
    status: MEDIA_LIVE[status] ? status : 'none',
    positionMs: mediaMs(next.positionMs),
    durationMs: mediaMs(next.durationMs),
    art: art,
    canNext: !!next.canNext,
    canPrev: !!next.canPrev
  };
  mediaAt = performance.now();

  paintMedia();
  scheduleMediaTick();

  /* The tile is [hidden] until the chrome pushes for the first time: a
     machine with no bridge never gets a tile at all. Showing it gives it a
     box, which is the one thing the board has to know. */
  if (mediaModule && mediaModule.hidden) {
    mediaModule.hidden = false;
    if (typeof window.__boardRelayout === 'function') window.__boardRelayout();
  }

  return window.__media();
};

/** What the module actually shows, for tests. */
window.__media = function () {
  return {
    state: mediaState(),
    title: mediaTitle ? mediaTitle.textContent : '',
    artist: mediaArtist ? mediaArtist.textContent : '',
    source: mediaData.source,
    album: mediaData.album,
    art: !!(mediaArt && !mediaArt.hidden && mediaArt.getAttribute('src')),
    artBytes: mediaArtKey ? mediaArtKey.length : 0,
    fill: mediaFill ? mediaFill.style.transform : '',
    fraction: Number(mediaFraction(performance.now()).toFixed(4)),
    ticking: !!mediaTimer,
    controls: {
      prev: !!(mediaPrev && !mediaPrev.disabled),
      toggle: !!(mediaToggle && !mediaToggle.disabled),
      next: !!(mediaNext && !mediaNext.disabled)
    },
    glyph: mediaState() === 'playing' ? 'pause' : 'play',
    shown: !!(mediaModule && !mediaModule.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* The instrument strip                                                 */
/*                                                                      */
/* Five readouts where the search field used to be. The chrome samples   */
/* the machine in the main process and pushes one object in every two    */
/* seconds with window.__applyStats(sample):                             */
/*                                                                      */
/*   { t, cpu:{percent,cores}, mem:{usedBytes,totalBytes,percent},       */
/*     disk:{percent,readBps,writeBps}, net:{downBps,upBps},             */
/*     gpu:{percent}, uptimeSec }                                       */
/*                                                                      */
/* A null field means "this machine cannot say", and shows a dash for    */
/* good — the strip never guesses and never interpolates.                */
/*                                                                      */
/* Cost: there is no timer and no requestAnimationFrame anywhere in      */
/* here. A sample landing is the only thing that repaints the five       */
/* canvases, so a page nobody is pushing to costs exactly nothing. The   */
/* other two repaints are a theme flip and a resize, both one-shot.      */
/* ------------------------------------------------------------------ */

/* The chrome asks this before it subscribes: a page that did not want
   stats would set it false and the sampler would never start. */
window.__statsWanted = true;

const STAT_SAMPLES = 60;         // one minute of history at one per second
const DASH = '—';

/* The floor the network graph is scaled against, so an idle link draws a
   flat line near the bottom instead of amplifying its own noise to full
   height. 131072 bytes/s is 1 Mb/s. */
const NET_FLOOR_BPS = 131072;

const statText = {
  cpu:     document.getElementById('st-cpu'),
  mem:     document.getElementById('st-mem'),
  disk:    document.getElementById('st-disk'),
  netDown: document.getElementById('st-net-down'),
  netUp:   document.getElementById('st-net-up'),
  gpu:     document.getElementById('st-gpu')
};

const statCanvas = {
  cpu:  document.getElementById('sg-cpu'),
  mem:  document.getElementById('sg-mem'),
  disk: document.getElementById('sg-disk'),
  net:  document.getElementById('sg-net'),
  gpu:  document.getElementById('sg-gpu')
};

/* One array of numbers-or-null per graph, oldest first, capped at
   STAT_SAMPLES. The net series is down + up: the two rates are stated
   separately in the text, and the graph is the link's total traffic. */
const statSeries = { cpu: [], mem: [], disk: [], net: [], gpu: [] };

/** A finite number in [0,100], or null. */
function pctOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** A finite number >= 0, or null. */
function rateOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, value);
}

function pctText(value) {
  return value == null ? DASH : Math.round(value) + '%';
}

/** "8.9 / 15.8 GB", both halves in GiB so they agree with Task Manager. */
function memText(mem) {
  const used = mem ? rateOrNull(mem.usedBytes) : null;
  const total = mem ? rateOrNull(mem.totalBytes) : null;
  if (used == null || total == null || !total) return DASH;
  const gb = 1073741824;
  return (used / gb).toFixed(1) + ' / ' + (total / gb).toFixed(1) + ' GB';
}

/**
 * A byte rate as BITS per second — Kb/s, Mb/s, Gb/s — which is the unit a
 * link is quoted in and the one Task Manager's network graph uses. The
 * label under the readout says "(bits/s)" so the b is never ambiguous.
 */
function bitsText(bytesPerSec, word) {
  const bytes = rateOrNull(bytesPerSec);
  if (bytes == null) return DASH;

  const bits = bytes * 8;
  let n = bits / 1000;
  let unit = 'Kb/s';

  if (bits >= 1e9) { n = bits / 1e9; unit = 'Gb/s'; }
  else if (bits >= 1e6) { n = bits / 1e6; unit = 'Mb/s'; }

  const figure = (n >= 100) ? String(Math.round(n)) : n.toFixed(1);
  return figure + ' ' + unit + ' ' + word;
}

/** Append one reading, oldest off the front. */
function pushSample(series, value) {
  series.push(value);
  while (series.length > STAT_SAMPLES) series.shift();
}

/** The largest reading in a series, ignoring the nulls. 0 for none. */
function seriesPeak(series) {
  let peak = 0;
  for (const value of series) {
    if (value != null && value > peak) peak = value;
  }
  return peak;
}

/**
 * One history graph. Newest sample at the right edge, so the line grows
 * in from the right and then scrolls, the way every meter on this machine
 * draws one. Two strokes and no more: a hairline baseline in --edge, and
 * the series in --ion over a 10% fill of the same colour.
 *
 * The canvas backing store is sized in device pixels, and the baseline is
 * snapped to the device grid, so the hairline is one real pixel rather
 * than a two-pixel smear on a 1.5x display.
 */
function paintGraph(canvas, series, scaleMax, edge, ion) {
  if (!canvas || typeof canvas.getContext !== 'function') return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 120));
  const h = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 28));
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));

  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;

  const c = canvas.getContext('2d');
  if (!c) return;

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  // The baseline sits on the last device row, centred in it.
  const base = (ph - 0.5) / dpr;
  const top = 1;                            // the peak never touches the lid
  const span = Math.max(1, base - top);

  c.lineWidth = 1 / dpr;
  c.strokeStyle = edge;
  c.beginPath();
  c.moveTo(0, base);
  c.lineTo(w, base);
  c.stroke();

  const max = scaleMax > 0 ? scaleMax : 1;
  const step = (w - 2) / (STAT_SAMPLES - 1);
  const first = w - 1 - (series.length - 1) * step;

  // Every run of consecutive readings is its own shape: a machine that
  // stopped reporting for a while leaves a gap, not a straight line
  // across the missing minutes.
  const runs = [];
  let run = null;

  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (value == null) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push({
      x: first + i * step,
      y: base - Math.max(0, Math.min(1, value / max)) * span
    });
  }

  if (!runs.length) return;

  c.fillStyle = ion;
  c.globalAlpha = 0.10;

  for (const points of runs) {
    if (points.length < 2) continue;        // a single dot has no area
    c.beginPath();
    c.moveTo(points[0].x, base);
    for (const p of points) c.lineTo(p.x, p.y);
    c.lineTo(points[points.length - 1].x, base);
    c.closePath();
    c.fill();
  }

  c.globalAlpha = 1;
  c.strokeStyle = ion;
  c.lineWidth = 1;                          // 1 CSS px: the one accent here
  c.lineJoin = 'round';
  c.lineCap = 'round';

  for (const points of runs) {
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
    c.stroke();
  }
}

/** All five, once. The only caller that runs often is a landing sample. */
function paintStats() {
  const style = getComputedStyle(document.documentElement);
  const edge = style.getPropertyValue('--edge').trim() || 'rgba(255,255,255,.11)';
  const ion = style.getPropertyValue('--ion').trim() || '#72adca';

  paintGraph(statCanvas.cpu, statSeries.cpu, 100, edge, ion);
  paintGraph(statCanvas.mem, statSeries.mem, 100, edge, ion);
  paintGraph(statCanvas.disk, statSeries.disk, 100, edge, ion);
  paintGraph(statCanvas.net, statSeries.net,
    Math.max(NET_FLOOR_BPS, seriesPeak(statSeries.net)), edge, ion);
  paintGraph(statCanvas.gpu, statSeries.gpu, 100, edge, ion);
}

/**
 * The chrome pushes one sample here. Everything it does is append, write
 * six strings and repaint five small canvases — no layout changes, because
 * every box in the strip is sized by CSS.
 */
window.__applyStats = function (sample) {
  const s = sample || {};

  const cpu = s.cpu ? pctOrNull(s.cpu.percent) : null;
  const memPct = s.mem ? pctOrNull(s.mem.percent) : null;
  const disk = s.disk ? pctOrNull(s.disk.percent) : null;
  const gpu = s.gpu ? pctOrNull(s.gpu.percent) : null;
  const down = s.net ? rateOrNull(s.net.downBps) : null;
  const up = s.net ? rateOrNull(s.net.upBps) : null;

  pushSample(statSeries.cpu, cpu);
  pushSample(statSeries.mem, memPct);
  pushSample(statSeries.disk, disk);
  pushSample(statSeries.gpu, gpu);
  pushSample(statSeries.net, (down == null && up == null) ? null : (down || 0) + (up || 0));

  setText(statText.cpu, pctText(cpu));
  setText(statText.mem, memText(s.mem));
  setText(statText.disk, pctText(disk));
  setText(statText.netDown, bitsText(down, 'down'));
  setText(statText.netUp, bitsText(up, 'up'));
  setText(statText.gpu, pctText(gpu));

  paintStats();
  applyProcs(s.procs);
  return window.__stats();
};

/** What the strip actually shows, for tests. */
window.__stats = function () {
  return {
    cpu: statText.cpu ? statText.cpu.textContent : null,
    mem: statText.mem ? statText.mem.textContent : null,
    disk: statText.disk ? statText.disk.textContent : null,
    netDown: statText.netDown ? statText.netDown.textContent : null,
    netUp: statText.netUp ? statText.netUp.textContent : null,
    gpu: statText.gpu ? statText.gpu.textContent : null,
    samples: statSeries.cpu.length
  };
};

/* ------------------------------------------------------------------ */
/* The process list                                                     */
/*                                                                      */
/* The same sample carries `procs: { top: [group...], total: n }`, one   */
/* group per program — `{ key, name, count, pids, cpu, memBytes,        */
/* ioBps, self }` — already summed and already sorted by the sampler.    */
/*                                                                      */
/* Three rules hold this together:                                      */
/*                                                                      */
/*  - A row is a DOM node with a life of its own, found by `key`. A      */
/*    sample writes into its text nodes and, if the order changed,       */
/*    moves the node. Nothing is rebuilt, so a row you are hovering, a   */
/*    confirm you have armed and a note that is still showing all        */
/*    survive the second they land in.                                   */
/*  - The list is folded into the capsule under the strip. Closed, the   */
/*    capsule is the height it always was; open, it grows by the fold    */
/*    and the board re-seats its traces around the new box. The state    */
/*    is remembered — he opens this all the time — and restored          */
/*    without animation.                                                 */
/*  - A sample that lands while it is closed is KEPT and not drawn. The  */
/*    page costs the same as it did before this existed until someone    */
/*    opens it.                                                          */
/*  - The page cannot end a task itself. It logs a line and waits: the   */
/*    chrome is the only thing here holding a kill.                      */
/* ------------------------------------------------------------------ */

const PROC_ROWS = 10;            // the body's height, in rows
const PROC_MAX = 30;             // what "Show more" opens it to
const PROC_PIDS_MAX = 64;        // the chrome refuses a longer list
const PROC_SORT_STORE = 'newtab.procs.sort';
const PROC_CONFIRM_MS = 3000;    // an armed End task disarms itself
const PROC_NOTE_MS = 3000;       // and the answer it got fades

const PROC_OPEN_STORE = 'newtab.procs.open';
const PROC_FOLD_MS = 160;        // the fold's own transition, mirrored here

const procsPanel = document.getElementById('procs');
const procsWrap = document.getElementById('procs-wrap');
const procsBody = document.getElementById('procs-body');
const procsMore = document.getElementById('procs-more');
const procsOpenBtn = document.getElementById('procs-open');
const statsPanel = document.getElementById('stats');
const procSortBtn = {
  cpu: document.getElementById('proc-sort-cpu'),
  mem: document.getElementById('proc-sort-mem')
};

/* key -> { row, label, count, cpu, mem, io, end, note, pids, ... } */
const procRows = new Map();

let procGroups = [];             // the last sample's groups, normalised
let procReady = false;           // a sample has landed at least once
let procExpanded = false;        // "Show more" is open
let procOpen = false;            // the panel is up (never remembered)
let procSort = 'cpu';            // 'cpu' | 'mem', restored below

/** The sort the user last chose. A page with no storage keeps CPU. */
function readProcSort() {
  try {
    return localStorage.getItem(PROC_SORT_STORE) === 'mem' ? 'mem' : 'cpu';
  } catch (err) {
    return 'cpu';
  }
}

function writeProcSort(value) {
  try {
    localStorage.setItem(PROC_SORT_STORE, value);
  } catch (err) {
    /* a page denied storage still sorts, it just forgets */
  }
}

/** A finite number >= 0, or null — the same rule the strip uses. */
function procNum(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, value);
}

/** "7.3%" under ten, "12%" above it: one decimal only where it reads. */
function procCpuText(value) {
  const n = procNum(value);
  if (n == null) return DASH;
  return n < 10 ? n.toFixed(1) + '%' : Math.round(n) + '%';
}

/** "482.4 MB", "1.4 GB" — Task Manager's units, one decimal. */
function procMemText(bytes) {
  const n = procNum(bytes);
  if (n == null) return DASH;
  const mb = n / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
}

/** The group's disk + network bytes a second, as KB/s or MB/s. */
function procIoText(bps) {
  const n = procNum(bps);
  if (n == null) return DASH;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB/s' : (n / 1024).toFixed(1) + ' KB/s';
}

/** One group from the sample, with everything this page will trust. */
function normalizeGroup(group) {
  if (!group || typeof group !== 'object') return null;

  const key = String(group.key || group.name || '');
  if (!key) return null;

  const pids = Array.isArray(group.pids)
    ? group.pids.filter(function (pid) {
        return typeof pid === 'number' && isFinite(pid) && pid > 0;
      }).slice(0, PROC_PIDS_MAX)
    : [];

  const count = (typeof group.count === 'number' && group.count > 1)
    ? Math.round(group.count)
    : (pids.length > 1 ? pids.length : 1);

  return {
    key: key,
    name: String(group.name || key),
    count: count,
    pids: pids,
    cpu: procNum(group.cpu),
    memBytes: procNum(group.memBytes),
    ioBps: procNum(group.ioBps),
    self: group.self === true
  };
}

/** Biggest first, on the chosen column, with the other as the tiebreak. */
function procCompare(a, b) {
  const first = procSort === 'mem' ? 'memBytes' : 'cpu';
  const second = procSort === 'mem' ? 'cpu' : 'memBytes';
  const fa = a[first] == null ? -1 : a[first];
  const fb = b[first] == null ? -1 : b[first];
  if (fb !== fa) return fb - fa;
  const sa = a[second] == null ? -1 : a[second];
  const sb = b[second] == null ? -1 : b[second];
  if (sb !== sa) return sb - sa;
  return a.name.localeCompare(b.name);
}

/* --- the program's own icon ---------------------------------------- */
/* The chrome resolves the icon of the real executable behind a group and
   pushes `{ key: dataUrl|null }` here. Every row wears a 16px slot left
   of its name from the moment it is built — the dashed placeholder rows
   too — so an icon that lands three seconds late moves nothing. A known
   dataUrl becomes one <img> whose src is written ONCE per key; anything
   else keeps the neutral window outline. No row is ever rebuilt for an
   icon, and a repeated answer for a key already shown touches nothing. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROC_ICON_MAX = 300;       // the same cap the main process keeps
const procIcons = new Map();     // key -> dataUrl | null

/** The neutral glyph: one window outline, hairline, no fill. */
function buildProcGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'proc-icon-glyph');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const box = document.createElementNS(SVG_NS, 'rect');
  box.setAttribute('x', '2.5');
  box.setAttribute('y', '3.5');
  box.setAttribute('width', '11');
  box.setAttribute('height', '9');
  box.setAttribute('rx', '1');
  box.setAttribute('fill', 'none');
  box.setAttribute('stroke', 'currentColor');
  box.setAttribute('stroke-width', '1');

  const bar = document.createElementNS(SVG_NS, 'path');
  bar.setAttribute('d', 'M2.5 6.5h11');
  bar.setAttribute('fill', 'none');
  bar.setAttribute('stroke', 'currentColor');
  bar.setAttribute('stroke-width', '1');

  svg.appendChild(box);
  svg.appendChild(bar);
  return svg;
}

/** The slot: 16px wide whatever is in it, built with the row, never removed. */
function buildProcIconSlot() {
  const slot = document.createElement('span');
  slot.className = 'proc-icon';
  slot.setAttribute('aria-hidden', 'true');
  return slot;
}

/**
 * Put whatever is known for this row's key in its slot. Called once when
 * the row is built and again only for the keys an answer actually names,
 * so a sample costs nothing here. `rec.iconSrc` is the guard: a key whose
 * src is already written is left completely alone — no attribute is
 * touched a second time, and an icon that is up is never taken away.
 */
function syncRowIcon(rec) {
  if (!rec || !rec.icon) return;

  const known = procIcons.get(rec.key);
  const url = (typeof known === 'string' && known) ? known : '';

  if (url) {
    if (rec.iconSrc === url) return;            // written once per key
    if (!rec.iconImg) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      rec.iconImg = img;
    }
    rec.iconSrc = url;
    rec.iconImg.src = url;
    if (rec.iconGlyph && rec.iconGlyph.parentNode === rec.icon) {
      rec.icon.removeChild(rec.iconGlyph);
      rec.iconGlyph = null;
    }
    if (rec.iconImg.parentNode !== rec.icon) rec.icon.appendChild(rec.iconImg);
    return;
  }

  if (rec.iconSrc) return;                      // an icon stays where it is
  if (rec.iconGlyph) return;                    // the glyph is already there
  rec.iconGlyph = buildProcGlyph();
  rec.icon.appendChild(rec.iconGlyph);
}

/** Whatever the chrome has resolved so far, merged and worn in place. */
window.__applyProcIcons = function (map) {
  if (map && typeof map === 'object') {
    Object.keys(map).forEach(function (raw) {
      const key = String(raw);
      const value = map[raw];
      procIcons.set(key, (typeof value === 'string' && value) ? value : null);
      const rec = procRows.get(key);
      if (rec) syncRowIcon(rec);
    });

    // Insertion order is oldest first: drop from the front, never a row's own.
    while (procIcons.size > PROC_ICON_MAX) {
      const oldest = procIcons.keys().next();
      if (oldest.done) break;
      procIcons.delete(oldest.value);
    }
  }
  return procIcons.size;
};

function procCell(className) {
  const cell = document.createElement('span');
  cell.className = 'proc-col ' + className;
  cell.setAttribute('role', 'cell');
  return cell;
}

/**
 * One row, built once. Everything a sample writes later is a text node
 * already in place, so an update is six string writes and nothing else.
 */
function buildRow(group) {
  const row = document.createElement('div');
  row.className = 'proc-row';
  row.setAttribute('role', 'row');
  row.dataset.key = group.key;

  const name = procCell('proc-name');
  const icon = buildProcIconSlot();
  const label = document.createTextNode('');
  const count = document.createElement('span');
  count.className = 'proc-count';
  name.appendChild(icon);
  name.appendChild(label);
  name.appendChild(count);

  const cpu = procCell('proc-cpu');
  const mem = procCell('proc-mem');
  const io = procCell('proc-io');
  const act = procCell('proc-act');

  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'proc-end';
  end.textContent = 'End task';
  act.appendChild(end);

  const note = document.createElement('span');
  note.className = 'proc-note';

  row.appendChild(name);
  row.appendChild(cpu);
  row.appendChild(mem);
  row.appendChild(io);
  row.appendChild(act);
  row.appendChild(note);        // laid over the row's right end, not a column

  const rec = {
    key: group.key,
    row: row,
    label: label,
    count: count,
    icon: icon,
    iconImg: null,
    iconGlyph: null,
    iconSrc: '',
    cpu: cpu,
    mem: mem,
    io: io,
    end: end,
    note: note,
    name: '',
    pids: [],
    self: false,
    confirmTimer: 0,
    noteTimer: 0
  };

  end.addEventListener('click', function () { armEnd(rec); });
  syncRowIcon(rec);              // whatever is already known, worn at once
  return rec;
}

function procRowFor(group) {
  let rec = procRows.get(group.key);
  if (!rec) {
    rec = buildRow(group);
    procRows.set(group.key, rec);
  }
  return rec;
}

/** The six writes. setText only touches a node whose text actually moved. */
function updateRow(rec, group) {
  rec.pids = group.pids;
  rec.self = group.self;

  if (rec.name !== group.name) {
    rec.name = group.name;
    rec.label.nodeValue = group.name;
    rec.end.setAttribute('aria-label', 'End task, ' + group.name);
  }

  setText(rec.count, group.count > 1 ? '(' + group.count + ')' : '');
  setText(rec.cpu, procCpuText(group.cpu));
  setText(rec.mem, procMemText(group.memBytes));
  setText(rec.io, procIoText(group.ioBps));

  rec.row.classList.toggle('is-self', group.self);
  rec.row.classList.remove('is-blank');

  // This browser is stated like anything else and offered no control:
  // there is nothing sensible on the other side of that button.
  const offered = !group.self && rec.pids.length > 0;
  if (rec.end.hidden === offered) rec.end.hidden = !offered;
  if (!offered) disarmEnd(rec);
}

/** A dashed row: what the list is before the first sample lands. */
function buildBlankRow() {
  const row = document.createElement('div');
  row.className = 'proc-row is-blank';
  row.setAttribute('role', 'row');

  const name = procCell('proc-name');
  name.appendChild(buildProcIconSlot());   // empty, but the same 24px wide
  name.appendChild(document.createTextNode(DASH));
  const cpu = procCell('proc-cpu');
  cpu.textContent = DASH;
  const mem = procCell('proc-mem');
  mem.textContent = DASH;
  const io = procCell('proc-io');
  io.textContent = DASH;
  const act = procCell('proc-act');

  row.appendChild(name);
  row.appendChild(cpu);
  row.appendChild(mem);
  row.appendChild(io);
  row.appendChild(act);
  return row;
}

function renderBlank() {
  if (!procsBody) return;
  if (procsBody.childElementCount === PROC_ROWS &&
      procsBody.firstElementChild &&
      procsBody.firstElementChild.classList.contains('is-blank')) return;

  procsBody.textContent = '';
  for (let i = 0; i < PROC_ROWS; i++) procsBody.appendChild(buildBlankRow());
}

/** The header: which column is sorted, and the caret that says so. */
function syncProcHead() {
  ['cpu', 'mem'].forEach(function (which) {
    const btn = procSortBtn[which];
    if (!btn) return;
    const active = procSort === which;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-sort', active ? 'descending' : 'none');
  });
}

/** "Show more" keeps its box when there is nothing more: see the note. */
function syncProcMore() {
  if (!procsMore) return;
  const more = procGroups.length > PROC_ROWS;
  procsMore.classList.toggle('is-idle', !more);
  procsMore.disabled = !more;
  setText(procsMore, procExpanded ? 'Show less' : 'Show more');
  procsMore.setAttribute('aria-expanded', procExpanded ? 'true' : 'false');
}

/**
 * Place the visible rows in order. Nodes are MOVED, never remade: a row
 * that was third and is now first is the same element, so its text does
 * not flash and a confirm armed on it stays armed.
 */
function renderProcs() {
  if (!procsBody || !procOpen) return;   // closed: the sample is kept, not drawn

  syncProcHead();

  if (!procReady) {
    renderBlank();
    syncProcMore();
    return;
  }

  const sorted = procGroups.slice().sort(procCompare);
  const visible = sorted.slice(0, procExpanded ? PROC_MAX : PROC_ROWS);

  for (let i = 0; i < visible.length; i++) {
    const rec = procRowFor(visible[i]);
    updateRow(rec, visible[i]);
    const at = procsBody.children[i];
    if (at !== rec.row) procsBody.insertBefore(rec.row, at || null);
  }

  // Whatever is left past the visible list: the blank rows on the first
  // sample, and any row this sample pushed out of sight.
  while (procsBody.childElementCount > visible.length) {
    procsBody.removeChild(procsBody.lastElementChild);
  }

  // Forget a program the sample no longer lists at all. A row that is
  // merely below the fold keeps its record, so it comes back as itself.
  const live = new Set(procGroups.map(function (group) { return group.key; }));
  procRows.forEach(function (rec, key) {
    if (live.has(key)) return;
    if (rec.confirmTimer) clearTimeout(rec.confirmTimer);
    if (rec.noteTimer) clearTimeout(rec.noteTimer);
    if (rec.row.parentNode) rec.row.parentNode.removeChild(rec.row);
    procRows.delete(key);
  });

  syncProcMore();
}

function applyProcs(procs) {
  if (!procs || !Array.isArray(procs.top)) return;

  // Cheap either way: one map over at most thirty small objects. The DOM
  // work below it only happens while somebody is looking.
  procGroups = procs.top
    .map(normalizeGroup)
    .filter(function (group) { return group !== null; })
    .slice(0, PROC_MAX);

  procReady = true;
  renderProcs();
}

/* --- the fold ------------------------------------------------------ */

/** What the last tab left. A page with no storage starts closed. */
function readProcOpen() {
  try {
    return localStorage.getItem(PROC_OPEN_STORE) === '1';
  } catch (err) {
    return false;
  }
}

function writeProcOpen(open) {
  try {
    localStorage.setItem(PROC_OPEN_STORE, open ? '1' : '0');
  } catch (err) {
    /* a page denied storage still folds, it just forgets */
  }
}

let procFoldTimer = 0;

/**
 * The capsule changed height, so the board's socket and every trace it
 * routed around it are wrong. One forced re-layout AFTER the fold has
 * finished moving — the transition is stepped, and re-seating on each of
 * its four frames would be four board rebuilds for one result.
 */
function relayoutBoard() {
  if (procFoldTimer) clearTimeout(procFoldTimer);
  procFoldTimer = setTimeout(function () {
    procFoldTimer = 0;
    if (typeof window.__boardRelayout === 'function') window.__boardRelayout();
  }, PROC_FOLD_MS + 30);
}

/**
 * Open or close the fold. `animate === false` is the restore on load: the
 * page wears last session's state from the first frame instead of
 * unfolding in front of whoever opened the tab.
 */
function setProcsOpen(open, animate) {
  if (!statsPanel || !procsPanel) return;

  const next = !!open;
  const changed = next !== procOpen;
  procOpen = next;

  if (animate === false && procsWrap) {
    procsWrap.classList.add('no-anim');
    // Read the box back so the class lands in its own style pass: without
    // this the browser coalesces both and the fold animates anyway.
    void procsWrap.offsetHeight;
  }

  statsPanel.classList.toggle('is-procs-open', next);
  if (procsOpenBtn) procsOpenBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
  // Nothing inside a closed fold is reachable, by pointer or by tab.
  if (procsWrap) procsWrap.inert = !next;

  if (animate === false && procsWrap) {
    void procsWrap.offsetHeight;
    procsWrap.classList.remove('no-anim');
  }

  if (next) {
    renderProcs();               // the rows this page has been keeping
  } else {
    // Whatever was armed or showing on a row does not survive the close.
    procRows.forEach(function (rec) {
      disarmEnd(rec);
      if (rec.noteTimer) {
        clearTimeout(rec.noteTimer);
        rec.noteTimer = 0;
        rec.row.classList.remove('has-note');
      }
    });
  }

  if (changed) {
    writeProcOpen(next);
    relayoutBoard();
  }
}

function toggleProcs() {
  setProcsOpen(!procOpen, true);
}

/* --- End task ----------------------------------------------------- */

function disarmEnd(rec) {
  if (rec.confirmTimer) {
    clearTimeout(rec.confirmTimer);
    rec.confirmTimer = 0;
  }
  rec.end.classList.remove('is-confirm');
  setText(rec.end, 'End task');
}

/**
 * Two presses, three seconds apart at most. The first arms the row and
 * says what the second does; the second logs the line and lets go. The
 * page never learns whether it worked — __applyEndTask does.
 */
function armEnd(rec) {
  if (rec.self || !rec.pids.length) return;

  if (rec.confirmTimer) {
    disarmEnd(rec);
    console.log('newtab:end-task ' + JSON.stringify({
      pids: rec.pids.slice(0, PROC_PIDS_MAX),
      key: rec.key
    }));
    return;
  }

  setText(rec.end, 'Confirm');
  rec.end.classList.add('is-confirm');
  rec.confirmTimer = setTimeout(function () {
    rec.confirmTimer = 0;
    rec.end.classList.remove('is-confirm');
    setText(rec.end, 'End task');
  }, PROC_CONFIRM_MS);
}

/** What a row says after the chrome answered. */
function endTaskNote(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return 'No change';

  const failed = list.filter(function (r) { return !r || r.ok !== true; });
  if (!failed.length) return 'Ended';

  const reason = String((failed[0] && failed[0].reason) || '');
  if (reason === 'self') return "That's this browser";
  if (reason === 'protected') return 'Protected';
  if (!reason) return 'Not ended';
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function showNote(rec, text) {
  rec.note.textContent = text;
  rec.row.classList.add('has-note');
  if (rec.noteTimer) clearTimeout(rec.noteTimer);
  rec.noteTimer = setTimeout(function () {
    rec.noteTimer = 0;
    rec.row.classList.remove('has-note');
    rec.note.textContent = '';
  }, PROC_NOTE_MS);
}

/**
 * The chrome's answer to one logged line: an array of { pid, ok, reason }.
 * Returns the note it wrote, so a test can read it without racing the
 * three-second timer.
 */
window.__applyEndTask = function (data) {
  const d = data || {};
  const text = endTaskNote(d.results);
  const rec = procRows.get(String(d.key));
  if (rec) showNote(rec, text);
  return text;
};

/** What the list actually shows, for tests. */
window.__procs = function () {
  const column = document.querySelector('.column');
  const panel = procsPanel ? procsPanel.getBoundingClientRect() : null;
  return {
    open: procOpen,
    sort: procSort,
    expanded: procExpanded,
    ready: procReady,
    total: procGroups.length,
    foldHeight: panel ? panel.height : 0,
    panel: panel ? { top: panel.top, left: panel.left, width: panel.width, height: panel.height } : null,
    bodyHeight: procsBody ? procsBody.getBoundingClientRect().height : 0,
    capsuleHeight: statsPanel ? statsPanel.getBoundingClientRect().height : 0,
    columnHeight: column ? column.getBoundingClientRect().height : 0,
    rows: Array.prototype.map.call(procsBody ? procsBody.children : [], function (row) {
      const end = row.querySelector('.proc-end');
      const note = row.querySelector('.proc-note');
      const slot = row.querySelector('.proc-icon');
      return {
        key: row.dataset.key || null,
        icon: slot
          ? (slot.querySelector('img') ? 'img'
            : (slot.querySelector('svg') ? 'glyph' : 'empty'))
          : null,
        name: row.querySelector('.proc-name') ? row.querySelector('.proc-name').textContent : '',
        cpu: row.querySelector('.proc-cpu').textContent,
        mem: row.querySelector('.proc-mem').textContent,
        io: row.querySelector('.proc-io').textContent,
        self: row.classList.contains('is-self'),
        blank: row.classList.contains('is-blank'),
        end: end ? (end.hidden ? null : end.textContent) : null,
        note: (note && row.classList.contains('has-note')) ? note.textContent : null,
        height: row.getBoundingClientRect().height
      };
    })
  };
};

/** What the page knows about icons, for tests. */
window.__procIcons = function () {
  let known = 0;
  procIcons.forEach(function (value) { if (value) known++; });
  return { entries: procIcons.size, known: known, rows: procRows.size };
};

function wireProcs() {
  procSort = readProcSort();
  syncProcHead();

  ['cpu', 'mem'].forEach(function (which) {
    const btn = procSortBtn[which];
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (procSort === which) return;
      procSort = which;
      writeProcSort(which);
      renderProcs();
    });
  });

  if (procsMore) {
    procsMore.addEventListener('click', function (event) {
      event.stopPropagation();   // the strip behind it toggles the fold
      procExpanded = !procExpanded;
      if (!procExpanded) procsBody.scrollTop = 0;
      if (procsPanel) procsPanel.classList.toggle('is-expanded', procExpanded);
      renderProcs();
      relayoutBoard();           // thirty rows is a taller capsule
    });
  }

  // The way in: the word, and the whole strip behind it. A button is what
  // the keyboard reaches (Enter and Space are its own), the strip is what
  // the mouse hits — but a click inside the open fold is a click on the
  // list, never on the thing holding it.
  if (procsOpenBtn) {
    procsOpenBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleProcs();
    });
  }

  if (statsPanel) {
    statsPanel.addEventListener('click', function (event) {
      if (procsPanel && procsPanel.contains(event.target)) return;
      // The app dock lives in the capsule too, and a press on a tile is
      // meant for the tile: the panel behind it does not also fold.
      if (dockSection && dockSection.contains(event.target)) return;
      toggleProcs();
    });
  }

  // Escape belongs to the fold only while you are inside it: this page has
  // no overlay, and a key that collapses a list you are not in is a key
  // that ate something else's Escape.
  document.addEventListener('keydown', function (event) {
    if (!procOpen || !procsPanel) return;
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (!procsPanel.contains(document.activeElement)) return;
    event.preventDefault();
    setProcsOpen(false, true);
    if (procsOpenBtn) procsOpenBtn.focus();
  });

  // Last session's state, worn from the first frame rather than unfolded.
  setProcsOpen(readProcOpen(), false);
}

/* ------------------------------------------------------------------ */
/* The app dock                                                        */
/*                                                                     */
/* What this machine opens, pinned into the capsule above the web       */
/* chips. Three kinds of pin share the one row:                        */
/*                                                                     */
/*   an installed program   an opaque index id: its own 32px icon       */
/*   a web app             'web:<slug>': the site's favicon, fetched    */
/*                          through the same service the chips use      */
/*   a terminal program     'term:<program>': a monospace >_ plate      */
/*                                                                     */
/* An installed pin can also be asked to open its web form instead      */
/* ({ id, web: true } in the pins list) — it keeps its app icon and     */
/* wears a small "web" mark; edit mode turns that on and off. The page  */
/* never decides where a press lands: it names the pin and the chrome   */
/* routes it.                                                          */
/*                                                                     */
/* Three pushes feed it and one console line leaves it:                */
/*                                                                     */
/*   window.__applyApps({ pins, installed, webapps, programs })  the    */
/*       pinned row, plus the three catalogues the picker groups and    */
/*       the pins resolve their names out of. Each list is only         */
/*       replaced when the push carried it. Rebuilds the row only when  */
/*       the pins themselves changed — a repeated push leaves every     */
/*       tile, and every 32px icon, exactly where it was.               */
/*                                                                     */
/*   window.__applyAppsRunning({ id: { running, pids, tab } })  arrives */
/*       once a second while this guest is on screen. It touches the    */
/*       dots and nothing else: no rebuild, no measurement, no board.   */
/*       An open tab (`tab: true`, which is how a web app or a terminal */
/*       is ever "running") lights the identical dot.                   */
/*                                                                     */
/*   window.__applyAppResult({ action, id, ok, reason })  the answer to */
/*       a line we logged. Only failures show: a 3s note on the tile.   */
/*                                                                     */
/* Out: `newtab:app {json}`, read off this guest by the chrome exactly  */
/* like the process list's end-task line. A press on a program is       */
/* launch, or focus when it is already running; a web pin is open-web   */
/* and a terminal pin open-term; edit mode sends unpin, and its "web"   */
/* switch sends pin-web; the picker sends pin. Pin and unpin also land  */
/* locally at once — the chrome's next push is authoritative, but the   */
/* row must answer the press whether or not the browser it is inside    */
/* knows about apps yet. pin-web is the one exception: nothing flips    */
/* here until the chrome says it did.                                   */
/* ------------------------------------------------------------------ */

const DOCK_RESULTS = 8;          // the picker never shows more per group
const DOCK_NOTE_MS = 3000;       // and a failure note lives this long

const DOCK_WEB_PREFIX = 'web:';    // 'web:discord'   — a site pinned as an app
const DOCK_TERM_PREFIX = 'term:';  // 'term:powershell' — a pty in a tab

const dockSection = document.getElementById('dock');
const dockRow = document.getElementById('dock-row');
const dockEditBtn = document.getElementById('dock-edit');
const dockPicker = document.getElementById('dock-picker');
const dockSearch = document.getElementById('dock-search');
const dockResults = document.getElementById('dock-results');

let dockPins = [];               // the pinned apps, in the chrome's order
let dockInstalled = [];          // the index, sorted by name, names at least
let dockWebapps = [];            // the web-app catalogue, sorted by name
let dockPrograms = [];           // the terminal programs that are available
const dockCells = new Map();     // id -> { cell, tile, dot, note, running, pids }

/* The three catalogues, by id, so resolving a pin is a lookup and not a
   scan of thirty rows on every push. dockWebByDesktop is the other join:
   installed id -> the web app that is the same thing, which is what puts
   the "web" switch on a tile in edit mode. */
const dockInstalledById = new Map();
const dockWebById = new Map();
const dockWebByDesktop = new Map();
const dockProgById = new Map();

let dockKey = null;              // identity of the row that is built
let dockHeight = -1;             // its last measured height, for the board
let dockEditing = false;
let dockPickerOpen = false;
let dockMatches = [];            // what the picker is showing
let dockActive = 0;              // and where the arrow keys are in it

let dockAddCell = null;          // the "+ Add app" tile, built once
let dockAddTile = null;

function dockText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * An icon is a data: URL or it is nothing. The index is built in the main
 * process; a pin must never make this page fetch anything.
 */
function dockIcon(value) {
  const url = dockText(value);
  return /^data:image\//i.test(url) ? url : null;
}

/** The pids the chrome found, bounded by the same cap end-task uses. */
function dockPids(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push(Math.trunc(pid));
    if (out.length >= PROC_PIDS_MAX) break;
  }
  return out;
}

/** 'web:discord' / 'term:powershell', or '' for an installed-app id. */
function dockPrefix(id) {
  if (id.indexOf(DOCK_WEB_PREFIX) === 0) return DOCK_WEB_PREFIX;
  if (id.indexOf(DOCK_TERM_PREFIX) === 0) return DOCK_TERM_PREFIX;
  return '';
}

/**
 * One pin. The chrome may name it three ways and all three arrive here:
 *
 *   'a1b2c3'                    a bare id — everything else is looked up
 *   { id: 'a1b2c3', web: true } an installed app, opened as its web form
 *   { id, name, iconDataUrl, running, pids, tab }  the whole row
 *
 * `kind` is what the tile is made of: 'app', 'web', 'term', or 'missing'
 * when the id belongs to none of the three catalogues and the push did not
 * carry a name either — that one renders exactly as an app whose index
 * entry has gone, which is what it is.
 */
function normalizePin(entry) {
  const e = (typeof entry === 'string') ? { id: entry } : (entry || {});
  const id = dockText(e.id);
  if (!id) return null;

  const given = dockText(e.name) || dockText(e.exe);
  const pin = {
    id: id,
    kind: 'app',
    name: given || id,
    icon: dockIcon(e.iconDataUrl),
    host: dockText(e.host),
    web: e.web === true,
    webAvailable: false,
    running: e.running === true,
    tab: e.tab === true,
    pids: dockPids(e.pids)
  };

  const prefix = dockPrefix(id);

  if (prefix === DOCK_WEB_PREFIX) {
    const site = dockWebById.get(id);
    // A web pin is the web form by definition; its icon is a favicon, so
    // an iconDataUrl that came with it is not what this tile wears.
    pin.kind = (site || given) ? 'web' : 'missing';
    pin.web = true;
    pin.icon = null;
    if (site) { pin.name = site.name; pin.host = site.host; }
    return pin;
  }

  if (prefix === DOCK_TERM_PREFIX) {
    const program = dockProgById.get(id);
    pin.kind = (program || given) ? 'term' : 'missing';
    pin.icon = null;
    pin.host = '';
    if (program) pin.name = program.name;
    return pin;
  }

  const app = dockInstalledById.get(id);
  if (app) {
    if (!given) pin.name = app.name;
    if (!pin.icon) pin.icon = app.icon;
  } else if (!given) {
    pin.kind = 'missing';
  }
  pin.webAvailable = dockWebByDesktop.has(id);
  return pin;
}

function normalizePins(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const pin = normalizePin(entry);
    if (!pin || seen.has(pin.id)) continue;
    seen.add(pin.id);
    out.push(pin);
  }
  return out;
}

/**
 * The installed index: id and name are all the picker needs, and an icon
 * if one happened to come with it. Sorted here, once, so the picker's own
 * order is the same every time it opens.
 */
function normalizeInstalled(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    const name = dockText(e.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id, name: name, icon: dockIcon(e.iconDataUrl) });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

/**
 * The web-app catalogue. `desktopId` is the join the chrome worked out —
 * the installed app this site is the web form of, or null — and it is what
 * decides whether a tile gets the "web" switch. Sorted by name, like the
 * installed index, so the picker's second group reads the same way as its
 * first.
 */
function normalizeWebapps(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    const name = dockText(e.name);
    if (!id || !name || seen.has(id)) continue;
    if (dockPrefix(id) !== DOCK_WEB_PREFIX) continue;
    seen.add(id);
    out.push({
      id: id,
      name: name,
      host: dockText(e.host),
      drm: e.drm === true,
      desktopId: dockText(e.desktopId) || null
    });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

/**
 * The terminal programs. An unavailable one is dropped here rather than
 * filtered at every use: a program this machine does not have is not a
 * thing the picker can offer.
 */
function normalizePrograms(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    if (!id || seen.has(id) || e.available === false) continue;
    if (dockPrefix(id) !== DOCK_TERM_PREFIX) continue;
    seen.add(id);
    out.push({ id: id, name: dockText(e.name) || id.slice(DOCK_TERM_PREFIX.length) });
  }
  return out;                     // the chrome's order: its table is curated
}

/* The three catalogues land through these, so the id maps a pin resolves
   against can never drift from the lists the picker shows. */

function setDockInstalled(list) {
  dockInstalled = normalizeInstalled(list);
  dockInstalledById.clear();
  for (const app of dockInstalled) dockInstalledById.set(app.id, app);
}

function setDockWebapps(list) {
  dockWebapps = normalizeWebapps(list);
  dockWebById.clear();
  dockWebByDesktop.clear();
  for (const site of dockWebapps) {
    dockWebById.set(site.id, site);
    if (site.desktopId) dockWebByDesktop.set(site.desktopId, site);
  }
}

function setDockPrograms(list) {
  dockPrograms = normalizePrograms(list);
  dockProgById.clear();
  for (const program of dockPrograms) dockProgById.set(program.id, program);
}

/* webapps.js is loaded by this page too, so a web pin has a name and a
   host to draw from the very first paint — before the chrome's first push,
   and whether or not that push carries the catalogue. The pushed list is
   still the authority: it is the only one that knows desktopId. */
if (Array.isArray(window.WEBAPPS)) setDockWebapps(window.WEBAPPS);

/** Identity of the built row: what would make a tile different. */
function dockPinsKey(list) {
  return list.map(function (pin) {
    return [
      pin.id, pin.kind, pin.name, pin.host,
      pin.icon ? '1' : '0', pin.web ? '1' : '0', pin.webAvailable ? '1' : '0'
    ].join('\t');
  }).join('\n');
}

/** The channel out. One line, the same shape end-task uses. */
function dockSend(message) {
  console.log('newtab:app ' + JSON.stringify(message));
}

/** No icon in the index: a neutral plate with the app's first letter. A
    site's fallback is the same letter on a disc, so a web pin still reads
    as a site when its favicon does not arrive. */
function dockGlyphNode(name, round) {
  const glyph = document.createElement('span');
  glyph.className = round ? 'dock-glyph is-web' : 'dock-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = (dockText(name) || '?').charAt(0);
  return glyph;
}

/** A terminal pin: the prompt itself, in the only monospace on this page. */
function dockTermNode() {
  const glyph = document.createElement('span');
  glyph.className = 'dock-glyph dock-term';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '>_';
  return glyph;
}

/**
 * A web pin's icon: the same favicon service, and the same 32px request,
 * the chips row above already uses — one service for the whole page. The
 * chips drop a missing icon and keep their padding; a tile cannot, so this
 * one falls back to the lettered disc instead of leaving a hole.
 */
function dockFaviconNode(pin) {
  if (!pin.host) return dockGlyphNode(pin.name, true);

  const img = faviconImg(pin.host, 'dock-icon dock-icon-web');
  img.width = 32;
  img.height = 32;
  img.onerror = function () {
    if (img.parentNode) img.parentNode.replaceChild(dockGlyphNode(pin.name, true), img);
  };
  return img;
}

/**
 * The 32px icon. A data URL that fails to decode is replaced by the glyph
 * rather than left as a broken image: this row is on screen full-time.
 */
function dockIconNode(pin) {
  if (pin.kind === 'web') return dockFaviconNode(pin);
  if (pin.kind === 'term') return dockTermNode();
  if (!pin.icon) return dockGlyphNode(pin.name);

  const img = document.createElement('img');
  img.className = 'dock-icon';
  img.src = pin.icon;
  img.width = 32;
  img.height = 32;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.onerror = function () {
    if (img.parentNode) img.parentNode.replaceChild(dockGlyphNode(pin.name), img);
  };
  return img;
}

/**
 * A tile's title. The state words are the whole difference between the
 * three kinds: a program runs, a tab is open, and the dot is the same
 * light for both.
 */
function dockTileTitle(name, running, tab) {
  if (!running) return name;
  return name + (tab ? ' — open' : ' — running');
}

/** One pinned app: the tile, the remove glyph over it, and its note. */
function buildDockCell(pin) {
  const cell = document.createElement('div');
  cell.className = 'dock-cell';
  cell.dataset.id = pin.id;
  cell.dataset.mark = pin.kind;

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'dock-tile dock-tile-' + pin.kind;
  tile.title = dockTileTitle(pin.name, pin.running, pin.tab);

  const ico = document.createElement('span');
  ico.className = 'dock-ico';
  ico.appendChild(dockIconNode(pin));

  const dot = document.createElement('span');
  dot.className = 'dock-dot';
  dot.setAttribute('aria-hidden', 'true');
  ico.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'dock-name';
  name.textContent = pin.name;

  tile.appendChild(ico);
  tile.appendChild(name);

  // An installed app currently opened as its web form says so in the one
  // corner nothing else uses: the dot has the top-right, the remove glyph
  // takes that corner in edit mode, and the note owns the foot.
  if (pin.kind === 'app' && pin.web) {
    const badge = document.createElement('span');
    badge.className = 'dock-badge';
    badge.title = pin.name + ' opens in a tab';
    badge.textContent = 'web';
    tile.appendChild(badge);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'dock-remove';
  remove.title = 'Unpin ' + pin.name;
  remove.setAttribute('aria-label', 'Unpin ' + pin.name);
  remove.textContent = '×';

  const note = document.createElement('span');
  note.className = 'dock-note';

  cell.appendChild(tile);
  cell.appendChild(remove);
  cell.appendChild(note);

  // The switch, for an app that has a web form: only ever visible in edit
  // mode, and it does not flip itself. The chrome owns which way this pin
  // opens, so the tile changes when the next __applyApps says it did.
  let toggle = null;
  if (pin.kind === 'app' && pin.webAvailable) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dock-webtoggle' + (pin.web ? ' is-on' : '');
    toggle.textContent = 'web';
    toggle.setAttribute('aria-pressed', pin.web ? 'true' : 'false');
    toggle.title = (pin.web ? 'Open ' + pin.name + ' as a program' : 'Open ' + pin.name + ' in a tab');
    toggle.setAttribute('aria-label', toggle.title);
    cell.appendChild(toggle);
  }

  const rec = {
    cell: cell, tile: tile, dot: dot, note: note, toggle: toggle,
    kind: pin.kind, web: pin.web, name: pin.name,
    running: pin.running, tab: pin.tab, pids: pin.pids.slice(), noteTimer: 0
  };

  tile.addEventListener('click', function () { pressDockTile(pin.id); });
  remove.addEventListener('click', function () { unpinApp(pin.id); });
  if (toggle) {
    toggle.addEventListener('click', function () { toggleDockWeb(pin.id); });
  }

  dockCells.set(pin.id, rec);
  return cell;
}

/** The way in to pinning: the tile recipe with the glass taken away. */
function buildDockAddCell() {
  const cell = document.createElement('div');
  cell.className = 'dock-cell dock-cell-add';

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'dock-tile dock-add';
  tile.title = 'Add an app';
  tile.setAttribute('aria-expanded', 'false');
  tile.setAttribute('aria-controls', 'dock-picker');

  const plus = document.createElement('span');
  plus.className = 'dock-plus';
  plus.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'dock-name';
  name.textContent = 'Add app';

  tile.appendChild(plus);
  tile.appendChild(name);
  cell.appendChild(tile);

  tile.addEventListener('click', function () {
    setPickerOpen(!dockPickerOpen);
  });

  dockAddCell = cell;
  dockAddTile = tile;
  return cell;
}

function rebuildDockRow() {
  if (!dockRow) return;

  dockCells.forEach(function (rec) {
    if (rec.noteTimer) clearTimeout(rec.noteTimer);
  });
  dockCells.clear();

  const frag = document.createDocumentFragment();
  for (const pin of dockPins) frag.appendChild(buildDockCell(pin));
  frag.appendChild(dockAddCell || buildDockAddCell());
  dockRow.replaceChildren(frag);
}

/** The add tile is there while the row is being edited, and while it is empty.
    It also stays while its own picker is open: pinning the first app fills the
    row, and taking the tile away under an open picker would leave the picker
    with nothing to close it (the only other way out is Escape in the field). */
function syncDockAdd() {
  if (!dockAddCell) return;
  dockAddCell.hidden = !(dockEditing || dockPickerOpen || !dockPins.length);
  if (dockAddTile) dockAddTile.setAttribute('aria-expanded', dockPickerOpen ? 'true' : 'false');
}

/** Every dot from the pin list it belongs to. No geometry is touched. */
function syncDockRunning() {
  for (const pin of dockPins) {
    const rec = dockCells.get(pin.id);
    if (!rec) continue;
    rec.running = pin.running;
    rec.tab = pin.tab;
    rec.pids = pin.pids.slice();
    rec.tile.classList.toggle('is-running', pin.running);
    rec.tile.title = dockTileTitle(pin.name, pin.running, pin.tab);
  }
}

/**
 * The capsule is what the board measured, so a dock that grew a row — or
 * opened its picker — has to say so. Only ever called from the paths that
 * can change the box: never from a running-state push.
 */
function settleDockHeight() {
  if (!dockSection) return;
  const h = dockSection.offsetHeight;
  if (dockHeight >= 0 && h !== dockHeight) relayoutBoard();
  dockHeight = h;
}

function renderDock() {
  if (!dockRow) return;

  const key = dockPinsKey(dockPins);
  if (key !== dockKey) {
    dockKey = key;
    rebuildDockRow();
  }

  syncDockAdd();
  syncDockRunning();
  if (dockPickerOpen) renderDockResults();
  settleDockHeight();
}

function setDockPins(list) {
  dockPins = list;
  renderDock();
}

/* --- pressing things ---------------------------------------------- */

/**
 * A press is "open it", or "show me the one that is already open". The page
 * never learns whether that worked: __applyAppResult does, and only when
 * it did not.
 */
function pressDockTile(id) {
  const rec = dockCells.get(id);
  if (!rec) return;
  if (dockEditing) return;         // the row is being arranged, not used

  // A site and a terminal are one line each: the chrome decides whether
  // that means a new tab or the one already open.
  if (rec.kind === 'web') { dockSend({ action: 'open-web', id: id }); return; }
  if (rec.kind === 'term') { dockSend({ action: 'open-term', id: id }); return; }

  // A program — including one pinned to open as its web form. That routing
  // is the chrome's: the press it gets is the press it always got.
  if (rec.running && rec.pids.length) dockSend({ action: 'focus', id: id, pid: rec.pids[0] });
  else dockSend({ action: 'launch', id: id });
}

/**
 * Edit mode's "web" switch. It asks, and nothing more: the tile is only
 * ever redrawn by the push that comes back, so the row can never disagree
 * with where a press would actually land.
 */
function toggleDockWeb(id) {
  const rec = dockCells.get(id);
  if (!rec || rec.kind !== 'app') return;
  dockSend({ action: 'pin-web', id: id, web: !rec.web });
}

function unpinApp(id) {
  if (!dockCells.has(id)) return;
  dockSend({ action: 'unpin', id: id });
  setDockPins(dockPins.filter(function (pin) { return pin.id !== id; }));
}

function pinApp(app) {
  if (!app || dockCells.has(app.id)) return;
  dockSend({ action: 'pin', id: app.id });
  // The id alone: normalizePin resolves the tile out of the same catalogue
  // the row was picked from, whichever of the three that was.
  setDockPins(dockPins.concat([normalizePin(app.id)]));
  // The picker stays up with the field cleared: pinning three apps is three
  // presses, not three trips through edit mode.
  if (dockSearch) dockSearch.value = '';
  renderDockResults();
  settleDockHeight();
}

function setDockEditing(on) {
  const next = !!on;
  if (next === dockEditing) return;
  dockEditing = next;
  if (dockSection) dockSection.classList.toggle('is-editing', next);
  if (dockEditBtn) {
    setText(dockEditBtn, next ? 'Done' : 'Edit');
    dockEditBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  if (!next && dockPickerOpen) setPickerOpen(false);
  syncDockAdd();
  settleDockHeight();
}

/* --- the picker --------------------------------------------------- */

/* Three groups, always in this order: what is on the machine, then what is
   on the web, then the shells. One field filters all three. */
const DOCK_GROUPS = [
  { kind: 'app', label: 'Installed' },
  { kind: 'web', label: 'Web apps' },
  { kind: 'term', label: 'Terminals' }
];

/** Where the typed text sits in a row: 0 for a start, -1 for no match. A
    site is findable by its host too — "gmail" and "mail.google" both. */
function dockMatchAt(entry, q) {
  const name = entry.name.toLowerCase().indexOf(q);
  if (name === 0) return 0;
  const host = entry.host ? entry.host.toLowerCase().indexOf(q) : -1;
  if (host === 0) return 0;
  if (name > 0) return name;
  if (host > 0) return host;
  return -1;
}

function dockGroupMatches(list, kind, q) {
  const starts = [];
  const inside = [];

  for (const item of list) {
    if (dockCells.has(item.id)) continue;       // already on the row
    const entry = {
      kind: kind,
      id: item.id,
      name: item.name,
      icon: item.icon || null,
      host: item.host || '',
      drm: item.drm === true,
      desktopId: item.desktopId || null
    };
    if (!q) { starts.push(entry); continue; }
    const at = dockMatchAt(entry, q);
    if (at === 0) starts.push(entry);
    else if (at > 0) inside.push(entry);
  }

  // A name that starts with what was typed is what was meant.
  return starts.concat(inside).slice(0, DOCK_RESULTS);
}

/** Every group's matches, flattened in group order. The headings are drawn
    from the `kind` changing, so this list is exactly the options: nothing
    the arrow keys can land on is a label. */
function dockMatchApps(query) {
  const q = dockText(query).toLowerCase();
  return dockGroupMatches(dockInstalled, 'app', q)
    .concat(dockGroupMatches(dockWebapps, 'web', q))
    .concat(dockGroupMatches(dockPrograms, 'term', q));
}

/** A picker row's leading 16px: the app's icon, a favicon, or the prompt. */
function dockResultIcon(app) {
  if (app.kind === 'term') {
    const glyph = document.createElement('span');
    glyph.className = 'dock-result-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '>_';
    return glyph;
  }

  if (app.kind === 'web') {
    return app.host ? faviconImg(app.host, 'dock-result-icon') : null;
  }

  if (!app.icon) return null;

  const icon = document.createElement('img');
  icon.className = 'dock-result-icon';
  icon.src = app.icon;
  icon.width = 16;
  icon.height = 16;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.onerror = function () {
    if (icon.parentNode) icon.parentNode.removeChild(icon);
  };
  return icon;
}

/** The heading over a group. Quiet: the caption voice, not a new one. */
function dockGroupRow(label) {
  const row = document.createElement('li');
  row.className = 'dock-group';
  row.setAttribute('role', 'presentation');
  row.textContent = label;
  return row;
}

/**
 * Keep the arrow keys' row in view without scrolling the page under it.
 * Measured against the list's own box rather than offsetTop: neither the
 * list nor its rows establish a containing block, so offsetTop is counted
 * from some panel further up and would scroll the list to the wrong place.
 */
function scrollDockActiveIntoView() {
  if (!dockResults || typeof dockResults.getBoundingClientRect !== 'function') return;
  const row = dockResults.querySelector('.dock-result.is-active');
  if (!row) return;

  const list = dockResults.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < list.top) dockResults.scrollTop -= (list.top - box.top);
  else if (box.bottom > list.bottom) dockResults.scrollTop += (box.bottom - list.bottom);
}

function renderDockResults() {
  if (!dockResults) return;

  dockMatches = dockMatchApps(dockSearch ? dockSearch.value : '');
  if (dockActive >= dockMatches.length) dockActive = Math.max(0, dockMatches.length - 1);

  const frag = document.createDocumentFragment();

  if (!dockMatches.length) {
    const empty = document.createElement('li');
    empty.className = 'dock-result is-empty';
    const anything = dockInstalled.length || dockWebapps.length || dockPrograms.length;
    empty.textContent = anything ? 'No matches' : 'No apps indexed yet';
    frag.appendChild(empty);
    dockResults.replaceChildren(frag);
    if (dockSearch) dockSearch.removeAttribute('aria-activedescendant');
    return;
  }

  let group = null;

  dockMatches.forEach(function (app, i) {
    // One heading each time the kind changes: the list is already in group
    // order, so a group with nothing in it never announces itself.
    if (app.kind !== group) {
      group = app.kind;
      const label = DOCK_GROUPS.find(function (g) { return g.kind === group; });
      frag.appendChild(dockGroupRow(label ? label.label : group));
    }

    const row = document.createElement('li');
    row.className = 'dock-result dock-result-' + app.kind + (i === dockActive ? ' is-active' : '');
    row.id = 'dock-result-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === dockActive ? 'true' : 'false');
    row.dataset.id = app.id;
    row.dataset.mark = app.kind;
    row.title = app.host ? app.name + ' — ' + app.host : app.name;

    const icon = dockResultIcon(app);
    if (icon) row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'dock-result-name';
    name.textContent = app.name;
    row.appendChild(name);

    // The host is what tells two Google rows apart, so it travels with the
    // name rather than only living in the title.
    if (app.kind === 'web' && app.host) {
      const host = document.createElement('span');
      host.className = 'dock-result-host';
      host.textContent = app.host;
      row.appendChild(host);
    }

    // This build has no Widevine, so a protected site plays through the
    // program instead — worth saying here, where the pin is chosen.
    if (app.kind === 'web' && app.desktopId) {
      const hint = document.createElement('span');
      hint.className = 'dock-result-hint';
      hint.textContent = 'desktop';
      row.appendChild(hint);
    }

    // mousedown, not click: the field must not lose focus before the pin.
    row.addEventListener('mousedown', function (event) {
      event.preventDefault();
      pinApp(app);
    });

    frag.appendChild(row);
  });

  dockResults.replaceChildren(frag);
  if (dockSearch) dockSearch.setAttribute('aria-activedescendant', 'dock-result-' + dockActive);
  scrollDockActiveIntoView();
}

function moveDockActive(delta) {
  if (!dockMatches.length) return;
  const last = dockMatches.length - 1;
  dockActive = Math.min(last, Math.max(0, dockActive + delta));
  renderDockResults();
}

function setPickerOpen(open) {
  if (!dockPicker) return;

  const next = !!open;
  dockPickerOpen = next;
  dockPicker.hidden = !next;
  if (dockAddTile) dockAddTile.setAttribute('aria-expanded', next ? 'true' : 'false');

  if (next) {
    if (dockSearch) dockSearch.value = '';
    dockActive = 0;
    renderDockResults();
    if (dockSearch) dockSearch.focus();
    // Nothing to pick from: ask the chrome to build the index. One line,
    // once per opening, and the picker is usable the moment it answers.
    if (!dockInstalled.length) dockSend({ action: 'refresh' });
  } else {
    dockMatches = [];
    dockActive = 0;
    if (dockResults) dockResults.replaceChildren();
  }

  // The add tile's visibility depends on this flag, so it is re-read here
  // before the box is measured — closing the picker over a filled row is
  // what takes the tile away again.
  syncDockAdd();
  settleDockHeight();
}

/* --- what came back ----------------------------------------------- */

/** A failure, in the row's voice. The tile's title carries the whole of it. */
function dockResultNote(result) {
  const reason = dockText(result.reason);
  if (!reason) return result.action === 'focus' ? 'No window' : 'Failed';
  if (reason === 'not-found' || reason === 'missing') return 'Not found';
  if (reason === 'no-window') return 'No window';
  if (reason === 'busy') return 'Busy';
  const text = reason.replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function showDockNote(rec, text) {
  rec.note.textContent = text;
  rec.note.title = text;
  rec.cell.classList.add('has-note');
  if (rec.noteTimer) clearTimeout(rec.noteTimer);
  rec.noteTimer = setTimeout(function () {
    rec.noteTimer = 0;
    rec.cell.classList.remove('has-note');
    rec.note.textContent = '';
    rec.note.removeAttribute('title');
  }, DOCK_NOTE_MS);
}

/* --- the three pushes --------------------------------------------- */

/**
 * The pinned row and the three catalogues behind the picker. Each list is
 * only replaced when one was sent: a push that carries pins alone leaves
 * the picker with the catalogues it already had. The catalogues land first,
 * because a pin resolves its name, its host and its "web" switch out of
 * them.
 */
window.__applyApps = function (data) {
  const d = data || {};
  if (Array.isArray(d.installed)) setDockInstalled(d.installed);
  if (Array.isArray(d.webapps)) setDockWebapps(d.webapps);
  if (Array.isArray(d.programs)) setDockPrograms(d.programs);
  if (Array.isArray(d.pins)) setDockPins(normalizePins(d.pins));
  else renderDock();
  // A count, not the whole row: this is an executeJavaScript return value,
  // and __dock() is a forced layout nobody asked for. Tests call that.
  return {
    pins: dockPins.length,
    installed: dockInstalled.length,
    webapps: dockWebapps.length,
    programs: dockPrograms.length
  };
};

/**
 * Running state only, once a second. Dots in place: no tile is rebuilt, no
 * box is measured and the board is never told anything.
 */
window.__applyAppsRunning = function (map) {
  const m = (map && typeof map === 'object') ? map : {};
  let touched = 0;

  for (const id of Object.keys(m)) {
    const key = dockText(id);
    const entry = m[id] || {};
    const running = entry.running === true;
    const tab = entry.tab === true;
    const pids = dockPids(entry.pids);

    const pin = dockPins.find(function (p) { return p.id === key; });
    if (pin) { pin.running = running; pin.tab = tab; pin.pids = pids; }

    const rec = dockCells.get(key);
    if (!rec) continue;
    rec.running = running;
    rec.tab = tab;
    rec.pids = pids;
    rec.tile.classList.toggle('is-running', running);
    rec.tile.title = dockTileTitle(rec.name, running, tab);
    touched++;
  }

  // Deliberately not __dock(): this arrives once a second, and a forced
  // layout for a return value nobody reads is once a second too often.
  return { touched: touched };
};

/**
 * The answer to a line we logged. Only failures show: a launch that worked
 * is answered by the program itself. Returns the note it wrote, so a test
 * can read it without racing the three-second timer.
 */
window.__applyAppResult = function (result) {
  const r = result || {};
  if (r.ok === true) return null;

  const rec = dockCells.get(dockText(r.id));
  const text = dockResultNote(r);
  if (rec) showDockNote(rec, text);
  return text;
};

/** What the dock actually shows, for tests. */
window.__dock = function () {
  const cap = statsPanel ? statsPanel.getBoundingClientRect() : null;
  const row = dockRow ? dockRow.getBoundingClientRect() : null;
  const tops = new Set();

  const tiles = Array.prototype.map.call(dockRow ? dockRow.children : [], function (cell) {
    const tile = cell.querySelector('.dock-tile');
    const label = cell.querySelector('.dock-name');
    const dot = cell.querySelector('.dock-dot');
    const badge = cell.querySelector('.dock-badge');
    const toggle = cell.querySelector('.dock-webtoggle');
    const box = cell.getBoundingClientRect();
    if (!cell.hidden) tops.add(Math.round(box.top));
    return {
      id: cell.dataset.id || null,
      add: cell.classList.contains('dock-cell-add'),
      hidden: !!cell.hidden,
      mark: cell.dataset.mark || null,
      name: label ? label.textContent : '',
      title: tile ? tile.title : '',
      running: !!(tile && tile.classList.contains('is-running')),
      dot: !!(dot && getComputedStyle(dot).display !== 'none'),
      icon: !!cell.querySelector('.dock-icon'),
      favicon: !!cell.querySelector('.dock-icon-web'),
      glyph: !!cell.querySelector('.dock-glyph'),
      term: !!cell.querySelector('.dock-term'),
      badge: !!(badge && getComputedStyle(badge).display !== 'none'),
      toggle: toggle
        ? {
            on: toggle.classList.contains('is-on'),
            pressed: toggle.getAttribute('aria-pressed') === 'true',
            shown: getComputedStyle(toggle).display !== 'none'
          }
        : null,
      note: cell.classList.contains('has-note')
        ? (cell.querySelector('.dock-note') || {}).textContent : null,
      w: box.width, h: box.height, top: box.top, left: box.left
    };
  });

  return {
    editing: dockEditing,
    pickerOpen: dockPickerOpen,
    installed: dockInstalled.length,
    webapps: dockWebapps.length,
    programs: dockPrograms.length,
    pins: dockPins.map(function (pin) {
      return {
        id: pin.id, kind: pin.kind, name: pin.name, host: pin.host,
        web: pin.web, webAvailable: pin.webAvailable,
        running: pin.running, tab: pin.tab,
        pids: pin.pids.slice(), icon: !!pin.icon
      };
    }),
    rows: tops.size,
    capsuleHeight: cap ? cap.height : 0,
    sectionHeight: dockSection ? dockSection.getBoundingClientRect().height : 0,
    rowHeight: row ? row.height : 0,
    active: dockActive,
    results: dockMatches.map(function (app) { return app.name; }),
    resultKinds: dockMatches.map(function (app) { return app.kind; }),
    resultRows: Array.prototype.map.call(dockResults ? dockResults.children : [], function (li) {
      return {
        name: li.textContent,
        group: li.classList.contains('dock-group'),
        kind: li.dataset.mark || null,
        active: li.classList.contains('is-active')
      };
    }),
    tiles: tiles
  };
};

function wireDock() {
  if (!dockRow) return;

  /* The capsule behind this row folds the process list when it is clicked,
     and a press in here is never that. The containment check over in
     wireProcs() is not enough on its own: unpinning DETACHES the button
     that was pressed, so by the time the click reaches the panel its
     target is no longer inside the dock — and the capsule folded. Stopping
     the click at the section covers every control in here, including the
     ones that remove themselves. */
  if (dockSection) {
    dockSection.addEventListener('click', function (event) {
      event.stopPropagation();
    });
  }

  // The row starts with nothing pinned and the way in showing, so the
  // capsule wears its final height from the first paint whether or not the
  // chrome ever pushes a pin.
  renderDock();

  if (dockEditBtn) {
    dockEditBtn.addEventListener('click', function () {
      setDockEditing(!dockEditing);
    });
  }

  if (dockSearch) {
    dockSearch.addEventListener('input', function () {
      dockActive = 0;
      renderDockResults();
      // Eight rows or one "No matches" is a different capsule height, and the
      // board routed its traces around the old one. Debounced in relayoutBoard,
      // so a typed word is one re-seat and not one per letter.
      settleDockHeight();
    });

    dockSearch.addEventListener('keydown', function (event) {
      const key = event.key;
      if (key === 'ArrowDown') { event.preventDefault(); moveDockActive(1); return; }
      if (key === 'ArrowUp')   { event.preventDefault(); moveDockActive(-1); return; }
      if (key === 'Enter') {
        event.preventDefault();
        pinApp(dockMatches[dockActive]);
        return;
      }
      if (key === 'Escape' || key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
        // Closing it can also take the add tile away (a filled row, not being
        // edited): focus has to land on something that is still on screen.
        if (dockAddTile && dockAddCell && !dockAddCell.hidden) dockAddTile.focus();
        else if (dockEditBtn) dockEditBtn.focus();
      }
    });
  }
}

/* The accent's base colour differs per theme, so re-derive the same hue
   whenever the chrome flips data-theme on <html>. */
function watchTheme() {
  if (typeof MutationObserver !== 'function') return;

  const observer = new MutationObserver(function () {
    if (typeof window.__applyAccent === 'function') {
      window.__applyAccent(window.__accentHue ? window.__accentHue() : null);
    }
    // The graphs hold a painted copy of --ion and --edge: a theme flip
    // between samples would otherwise leave them in the old colour for
    // up to a second.
    paintStats();
  });

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ------------------------------------------------------------------ */
/* Background                                                          */
/*                                                                     */
/* Four backgrounds, chosen in Settings and pushed in by the chrome:    */
/*                                                                     */
/*   board   the circuit board — this page's own default               */
/*   aurora  the aurora alone; newtab-bg.js then does nothing at all    */
/*   image   the user's picture, dimmed, with the board optional        */
/*   video   a moving picture, same slot and same options as image      */
/*                                                                     */
/* The picture never travels on the URL: the chrome keeps the blob in   */
/* IndexedDB and hands it over as a data: URL inside the push. ?bg= is  */
/* only a first-paint hint, so an image user never watches the board    */
/* draw itself and then disappear.                                      */
/*                                                                     */
/* A clip is too big for either, so the chrome copies the chosen file   */
/* into its own folder and pushes the file:// URL instead (fileUrl).    */
/* ------------------------------------------------------------------ */

const BG_KINDS = ['board', 'aurora', 'image', 'video'];
const BG_DIM_DEFAULT = 0.25;
const BG_DIM_MAX = 0.6;

function bgKind(value) {
  return BG_KINDS.indexOf(String(value)) >= 0 ? String(value) : 'board';
}

/** 0..0.6, with anything unreadable falling back to the default wash. */
function bgDim(value) {
  if (value === null || value === undefined || value === '') return BG_DIM_DEFAULT;
  const n = Number(value);
  if (!isFinite(n)) return BG_DIM_DEFAULT;
  return Math.min(BG_DIM_MAX, Math.max(0, n));
}

/** A still picture and a moving one wear the same wash and the same board. */
function bgIsPicture(kind) {
  return kind === 'image' || kind === 'video';
}

/* Which element the chosen file belongs in. A real clip is decoded by the
   <video> — on this hardware, by the GPU — and a GIF cannot be: it goes in
   the <img>, where it animates itself. Anything else an <img> can decode
   ends up there too, which is the right answer for a still frame as well. */
const BG_CLIP_EXT = /\.(?:mp4|webm|mov|m4v)$/i;

/* file: is what the chrome sends once it has copied the file into its own
   folder; the rest are here so a test can hand one over directly. */
const BG_CLIP_PROTO = /^(?:file|blob|data|https?):/i;

/** The path part of a URL, so an extension test never reads a query. */
function bgUrlPath(url) {
  return String(url).split('#')[0].split('?')[0];
}

/** '' for anything this page will not put in a layer. */
function bgClipUrl(value) {
  if (typeof value !== 'string' || value === '') return '';
  return BG_CLIP_PROTO.test(value) ? value : '';
}

/** 'video' for a clip, 'img' for a GIF (or any other image), '' for neither. */
function bgClipLayer(url) {
  if (!url) return '';
  if (/^data:video\//i.test(url)) return 'video';
  if (/^data:image\//i.test(url)) return 'img';
  return BG_CLIP_EXT.test(bgUrlPath(url)) ? 'video' : 'img';
}

let bgState = {
  kind: 'board', boardOverImage: false, dim: 0, hasImage: false,
  clipUrl: '', clipLayer: ''
};

/* The chrome's __boardPaused(true): an overlay with a backdrop-filter is
   open over this page, or the window went behind. The clip stops on it for
   the same reason the board does — everything under a blurred panel is
   re-composited on every frame it moves. */
let bgChromePaused = false;

let bgClipWired = false;

/* A clip that cannot be decoded — the file was moved, or the chrome copied
   something this build has no decoder for — falls back to the board rather
   than to a black window, and says nothing about it: the setting is still
   the user's choice, and the next push tries it again. */
function onClipError() {
  if (bgState.kind !== 'video') return;
  applyBackground({ kind: 'board' });
}

function wireClipLayers(video, img) {
  if (bgClipWired) return;
  bgClipWired = true;
  if (video) video.addEventListener('error', onClipError);
  if (img) img.addEventListener('error', onClipError);
}

/**
 * Fill (or empty) the two moving-picture layers. Exactly one of them ever
 * carries .on, so a 'video' background with no file yet draws nothing at
 * all rather than a black rectangle over the aurora.
 */
function setClipLayers(layer, url) {
  const video = document.getElementById('bg-video');
  const img = document.getElementById('bg-video-img');
  wireClipLayers(video, img);

  if (video) {
    if (layer === 'video') {
      if (video.getAttribute('src') !== url) {
        video.muted = true;            // the attribute alone is not always enough
        video.setAttribute('src', url);
      }
      video.classList.add('on');
    } else {
      video.classList.remove('on');
      /* Pause before clearing: a media element holding a source it is no
         longer showing still holds a decoder and a network job. Removing
         the attribute and reloading is the only way to give both back. */
      video.pause();
      if (video.hasAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
    }
  }

  if (img) {
    if (layer === 'img') {
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      img.classList.add('on');
    } else {
      img.classList.remove('on');
      if (img.hasAttribute('src')) img.removeAttribute('src');
    }
  }
}

/** Only while this page is the one a person is looking at. */
function clipShouldRun() {
  return bgState.kind === 'video' && bgState.clipLayer === 'video' &&
    !bgChromePaused && !document.hidden;
}

/**
 * Start or stop the clip. Idempotent, and cheap enough to hang off every
 * signal that means "in front again" — the same three the board resumes on.
 * A paused <video> costs nothing; the element is never torn down, so coming
 * back is one call and no reload.
 */
function syncClip() {
  const video = document.getElementById('bg-video');
  if (!video) return;
  if (clipShouldRun()) {
    if (video.paused) {
      const started = video.play();
      /* The autoplay promise rejects when the source went away mid-call.
         Nothing to report: the error handler above owns the fallback. */
      if (started && typeof started.catch === 'function') started.catch(function () {});
    }
    return;
  }
  if (!video.paused) video.pause();
}

function applyBackground(bg) {
  const next = bg && typeof bg === 'object' ? bg : {};
  const kind = bgKind(next.kind);
  const picture = bgIsPicture(kind);
  const over = picture && next.boardOverImage === true;
  const dim = picture ? bgDim(next.dim) : 0;
  /* Only a data: image URL is ever written into the stylesheet. */
  const url = kind === 'image' && typeof next.dataUrl === 'string' &&
    /^data:image\//i.test(next.dataUrl) ? next.dataUrl : '';
  /* The clip travels as a URL, not as bytes: the chrome copied the file. */
  const clipUrl = kind === 'video' ? bgClipUrl(next.fileUrl) : '';
  const clipLayer = bgClipLayer(clipUrl);

  const root = document.documentElement;
  root.setAttribute('data-bg', kind);
  if (over) root.setAttribute('data-bg-board', 'over');
  else root.removeAttribute('data-bg-board');
  /* Only ever inline for a picture: the token has its own default in the
     stylesheet, and <html>'s inline style is otherwise the accent's alone. */
  if (picture) root.style.setProperty('--bg-dim', String(dim));
  else root.style.removeProperty('--bg-dim');

  const layer = document.getElementById('bg-image');
  if (layer) {
    if (url) layer.style.setProperty('background-image', 'url("' + url + '")');
    else layer.style.removeProperty('background-image');
  }

  bgState = {
    kind: kind, boardOverImage: over, dim: dim, hasImage: !!url,
    clipUrl: clipUrl, clipLayer: clipLayer
  };
  /* Leaving 'video' therefore pauses and clears; arriving sets and plays. */
  setClipLayers(clipLayer, clipUrl);
  syncClip();
  return bgState;
}

/**
 * The chrome pushes the background in on dom-ready and on every settings
 * change: __applyBackground({ kind, boardOverImage, dim, dataUrl, fileUrl }).
 * Anything missing means this page's own default.
 */
window.__applyBackground = function (bg) {
  return applyBackground(bg);
};

/* The chrome's pause reaches the board through newtab-bg.js, which is loaded
   above this file. Wrap its handler rather than asking the chrome for a
   second call: the clip and the board then stop on exactly the same signal,
   in the same order, and a chrome that knows nothing about video still
   pauses one. */
(function wrapBoardPaused() {
  const board = typeof window.__boardPaused === 'function' ? window.__boardPaused : null;
  window.__boardPaused = function (flag) {
    bgChromePaused = !!flag;
    syncClip();
    if (board) return board.apply(window, arguments);
    return undefined;
  };
})();

/** The background actually on screen, for tests. */
window.__background = function () {
  const video = document.getElementById('bg-video');
  return {
    kind: bgState.kind,
    boardOverImage: bgState.boardOverImage,
    dim: bgState.dim,
    hasImage: bgState.hasImage,
    clipLayer: bgState.clipLayer,
    hasClip: !!bgState.clipUrl,
    clipPlaying: !!(video && bgState.clipLayer === 'video' && !video.paused)
  };
};

/** The chrome pushes settings here with executeJavaScript. */
window.__applySettings = function (settings) {
  const next = settings || {};
  // next.searchEngine is deliberately ignored: this page has no field.
  setChips(next.chips);
  // Palette first: it authors the accent the hue is then painted over, so
  // a push that clears the hue lands on the new preset's own colour.
  if (typeof window.__applyPalette === 'function') window.__applyPalette(next.palette);
  if (typeof window.__applyAccent === 'function') window.__applyAccent(next.accentHue);
};

/**
 * The chrome pushes browsing history here the same way, up to 8 entries,
 * most recent first: __applyRecent([{ url, title, last }]). Safe to call
 * before DOMContentLoaded (the nav is parsed above this script), and safe
 * to call repeatedly — an unchanged list does not rebuild anything.
 */
window.__applyRecent = function (list) {
  recentList = normalizeRecent(list);
  renderRecent();
};

/** The chips actually on screen, for tests. */
window.__chips = function () {
  return currentChips().map(function (item) {
    return { label: item.label, url: item.url };
  });
};

/** The recent tiles actually on screen, for tests. */
window.__recent = function () {
  return visibleRecent().map(function (item) {
    return { label: item.label, url: item.url, host: item.host };
  });
};

function readParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch (err) {
    return null;
  }
}

function init() {
  const params = readParams();
  setChips(params ? parseChipsParam(params.get('chips')) : null);
  /* Before newtab-bg.js draws anything: its first paint is in a rAF after
     this handler, so ?bg=aurora|image means the board is never drawn. */
  applyBackground({ kind: params ? params.get('bg') : null });
  watchTheme();

  /* The empty instrument: the baseline hairlines, drawn once so a page
     nobody has pushed a sample to still reads as an instrument rather
     than as five blank rectangles. The strip is already at its full
     height either way — the boxes are sized in CSS — so this changes
     no geometry and the board's measurement stands. */
  paintStats();

  /* The process list in the same state: ten dashed rows at the height the
     real ten will wear, the sort the user last chose, and the "Show more"
     control holding its space. Nothing below this line changes the box. */
  wireProcs();

  /* The app dock, in the same state and for the same reason: the row keeps
     one tile-row of height before a single pin has arrived, so the capsule
     the board is about to measure is already the height it will wear. */
  wireDock();

  /* The idle-music module, before the board measures the tile it shares
     with the readout: it is inside a [hidden] tile either way, so this
     changes no geometry — it only makes the Off state the module's own
     rather than the markup's, and hangs the two controls. */
  wireMusic();

  /* Now playing, in the same state and for the same reason: the tile is
     [hidden] until the chrome pushes, so this changes no geometry — it only
     makes the "nothing playing" face the module's own rather than the
     markup's, and hangs the three controls. */
  wireMedia();

  /* The canvases are a percentage of the column, so their backing store
     is wrong after a resize. One repaint, no rAF: nothing here animates. */
  window.addEventListener('resize', paintStats);

  /* The clock, before the board measures the tile it sits in: newtab-bg.js
     seats the tiles in a rAF after this handler, and an empty face would be
     the wrong size. The three listeners are the same "back on screen"
     signals the board resumes on, for the same reason. */
  paintClock();
  scheduleClock();
  document.addEventListener('visibilitychange', refreshClock);
  window.addEventListener('pageshow', refreshClock);
  window.addEventListener('focus', refreshClock);

  /* The now-playing hairline stops and starts on the same signals, for the
     same reason the clip does: a fill nobody can see is four style writes a
     second for nothing. refreshMedia() checks the state itself, so none of
     these starts a tick a paused session does not want. */
  document.addEventListener('visibilitychange', refreshMedia);
  window.addEventListener('pageshow', refreshMedia);
  window.addEventListener('focus', refreshMedia);

  /* The moving picture stops and starts on the same three signals, for the
     stronger reason: a clip nobody can see is a decoder nobody is watching.
     syncClip() is idempotent and checks every reason on its own, so none of
     these starts anything the chrome or a hidden page still vetoes. */
  document.addEventListener('visibilitychange', syncClip);
  window.addEventListener('pageshow', syncClip);
  window.addEventListener('focus', syncClip);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
