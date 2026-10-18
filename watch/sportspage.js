/*
 * watch/sportspage.js -- Lumen's sports pages, drawn inside Lumen (watch.html): the game page,
 * a team page with its schedule, standings per league, the favourite-team picker, and the
 * "My teams" row's cards. Main (sports-main.js) reads ESPN; this file only draws what it says.
 *
 * Like watch.js and watch/pinbutton.js the page has no preload. It speaks console lines that
 * sports-main.js hears only from OUR watch.html (see that file's header for the verbs), and
 * main answers through window.__applySports(msg). "Watch this game" asks for the title the
 * same way watch.js does (quartz-watch:open), so it plays in Lumen's player layer.
 *
 * watch.js calls in through window.LumenSports (small hooks only): the rows it builds (My
 * teams; Live now leading when a favourite's or a big game is live), a game card's click,
 * and the stage's buttons. Everything is createElement + textContent.
 *
 * POLLING. Only an OPEN game page polls, on main's cadence (live 20 s, intermission 60 s,
 * pre-game 1-5 min, Final never), and never while the tab is hidden. My teams re-asks every
 * 2 min only while one of his games is live and the page is in sight. Nothing runs at rest.
 */
(function () {
  'use strict';
  var LINE = 'quartz-sports:';
  var POLL = { live: 20000, brk: 60000, soon: 60000, pre: 300000, backoff: [30000, 60000, 120000] };
  var MY_LIVE_MS = 120000;
  var LEAGUES = [
    ['nhl', 'NHL'], ['nfl', 'NFL'], ['nba', 'NBA'], ['mlb', 'MLB'], ['chky', 'College hockey'],
    ['cfb', 'College football'], ['wnba', 'WNBA'], ['mls', 'MLS']
  ];
  function leagueName(id) { for (var i = 0; i < LEAGUES.length; i++) if (LEAGUES[i][0] === id) return LEAGUES[i][1]; return String(id || '').toUpperCase(); }

  var S = {
    favs: [], favsKnown: false, my: null, myAt: 0, myTimer: 0,
    views: [], root: null, body: null, title: null, crumbs: null, tools: null,
    pollTimer: 0, tickTimer: 0, returnFocus: null,
    teamsCache: {}, standingsCache: {}, note: ''
  };

  function send(verb, msg) {
    var json = '{}';
    try { json = JSON.stringify(msg || {}); } catch (e) { json = '{}'; }
    try { console.log(LINE + verb + ' ' + json); } catch (e) { /* nothing to tell */ }
  }
  function openInLayer(url, title) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
    var m = { url: url };
    if (title) m.title = String(title).slice(0, 200);
    try { console.log('quartz-watch:open ' + JSON.stringify(m)); } catch (e) { /* nothing to tell */ }
  }

  try {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'watch/sportspage.css';
    document.head.appendChild(link);
  } catch (e) { /* unstyled is still usable */ }

  /* ------------------------------------------------------------------ dom helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
    return n;
  }
  function btn(cls, text, fn) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (fn) b.addEventListener('click', function (e) { e.stopPropagation(); fn(e); });
    return b;
  }
  function logo(t, size) {
    var l = el('span', 'logo lsp-logo' + (size ? ' ' + size : ''));
    var abbr = (t && t.abbr) || '?';
    if (t && t.logo) {
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.addEventListener('error', function () { l.classList.add('none'); l.replaceChildren(); l.textContent = abbr; }, { once: true });
      img.src = t.logo;
      l.appendChild(img);
    } else { l.classList.add('none'); l.textContent = abbr; }
    return l;
  }
  function dot(parts) { return parts.filter(function (p) { return !!p; }).join(' · '); }

  /* ------------------------------------------------------------------ time words */

  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function timeText(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function dateText(ms, long) {
    try { return new Date(ms).toLocaleDateString([], long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
  function whenText(ms) {
    if (!ms) return '';
    var now = Date.now();
    if (dayKey(ms) === dayKey(now)) return 'Today ' + timeText(ms);
    if (dayKey(ms) === dayKey(now + 86400e3)) return 'Tomorrow ' + timeText(ms);
    if (dayKey(ms) === dayKey(now - 86400e3)) return 'Yesterday';
    return dateText(ms) + (ms > now ? ' · ' + timeText(ms) : '');
  }
  function agoText(ms) {
    if (!ms) return '';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + ' s ago';
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }

  /* ------------------------------------------------------------------ favourites */

  function favKey(league, id) { return league + ':' + id; }
  function isFavTeam(league, abbr, id) {
    for (var i = 0; i < S.favs.length; i++) {
      var f = S.favs[i];
      if (f.league === league && ((id && f.id === id) || (abbr && f.abbr === abbr))) return true;
    }
    return false;
  }
  function isFav(ev) {
    return !!ev && (isFavTeam(ev.league, ev.home && ev.home.abbr, ev.home && ev.home.id) || isFavTeam(ev.league, ev.away && ev.away.abbr, ev.away && ev.away.id));
  }
  var NATIONAL = /^(ABC|ESPN|ESPN2|TNT|TBS|truTV|NBC|FOX|CBS|Prime Video|Amazon Prime Video|NFL Network|NFL Net|Peacock|Netflix|Max|HBO Max|Apple TV)$/i;
  function isBig(ev) { return !!ev && (ev.postseason === true || (ev.broadcasts || []).some(function (b) { return NATIONAL.test(String(b)); })); }
  function liveOnTop(list) { return (list || []).some(function (e) { return isFav(e) || isBig(e); }); }
  function sortLive(list) {
    var rank = function (e) { return isFav(e) ? 0 : isBig(e) ? 1 : 2; };
    return (list || []).map(function (e, i) { return [e, i]; }).sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function toggleFav(team, league, on) {
    send('fav', { league: league, team: { id: team.id, abbr: team.abbr, name: team.name, logo: team.logo }, on: on });
  }
  function favButton(team, league) {
    var on = isFavTeam(league, team.abbr, team.id);
    var b = btn('btn sm lsp-fav' + (on ? ' on' : ''), '', function () { toggleFav(team, league, !isFavTeam(league, team.abbr, team.id)); b.disabled = true; });
    b.appendChild(el('span', 'lsp-star', on ? '★' : '☆'));
    b.appendChild(document.createTextNode(on ? 'My team' : 'Add to My teams'));
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? 'Remove ' + team.name + ' from My teams' : 'Add ' + team.name + ' to My teams');
    return b;
  }

  /* ------------------------------------------------------------------ the My teams row (watch.js) */

  function myTeamsRow() {
    if (!S.favs.length) return null;
    var teams = S.favs.map(function (f) {
      var c = S.my ? S.my.filter(function (t) { return t.key === favKey(f.league, f.id); })[0] : null;
      return c || { key: favKey(f.league, f.id), league: f.league, leagueName: leagueName(f.league), id: f.id, abbr: f.abbr, name: f.name, logo: f.logo, loading: true };
    });
    return { key: 'myteams', kind: 'teams', id: 'myteams', title: 'My teams', service: '', teams: teams };
  }
  function rowSig(m) {
    return m.teams.map(function (t) {
      var g = t.live || t.next || t.last;
      return [t.key, t.loading ? 'l' : '', t.error || '', t.record, g ? g.id + g.state + g.detail + g.home.score + g.away.score : '', t.last ? t.last.result : '', t.offseason ? 'o' : ''].join('|');
    }).join('\u0001');
  }
  function focal(t) { return t.live || t.next || t.last || null; }
  function vsText(g, t) {
    if (!g) return '';
    var home = g.home && g.home.abbr === t.abbr;
    var opp = home ? g.away : g.home;
    return (home ? 'vs ' : 'at ') + (opp ? opp.abbr || opp.name : '');
  }
  function teamCardEl(t) {
    var wrap = el('div', 'gw lsp-tw');
    var g = btn('gc lsp-tc');
    g.dataset.key = 'team:' + t.key;
    g._team = t;
    var ev = focal(t);
    if (ev) g._event = ev;
    var t1 = el('span', 't1');
    if (t.live) t1.appendChild(el('span', 'live', 'Live'));
    t1.appendChild(el('span', 'net', dot([t.leagueName, t.record])));
    g.appendChild(t1);
    var hd = el('span', 'lsp-tc-h');
    hd.appendChild(logo(t, 'md'));
    hd.appendChild(el('span', 'lsp-tc-n', t.name));
    g.appendChild(hd);
    var lines = el('span', 'lsp-tc-l');
    var line = function (label, text, cls) {
      var r = el('span', 'lsp-tc-r' + (cls ? ' ' + cls : ''));
      r.appendChild(el('b', '', label));
      r.appendChild(el('span', '', text));
      lines.appendChild(r);
    };
    if (t.loading) line('', 'Reading the schedule…', 'dim');
    else if (t.error) line('', "Couldn't read the schedule: " + t.error, 'err');
    else {
      if (t.live) {
        var mine = t.live.home.abbr === t.abbr ? t.live.home : t.live.away, theirs = mine === t.live.home ? t.live.away : t.live.home;
        line('Live', dot([mine.score + '–' + theirs.score + ' ' + vsText(t.live, t), t.live.detail]), 'live');
      } else if (t.next) line('Next', dot([whenText(t.next.startsAt), vsText(t.next, t), (t.next.broadcasts || [])[0]]));
      if (t.postponed && !t.live) line('', vsText(t.postponed, t) + ' postponed', 'warn');
      if (t.last) line('Last', t.last.result + ' ' + vsText(t.last, t));
      if (t.offseason) line('', 'Off-season. No games scheduled yet.', 'dim');
    }
    g.appendChild(lines);
    var label = t.name + '. ' + (t.live ? 'Live now.' : t.next ? 'Next game ' + whenText(t.next.startsAt) + '.' : '') + ' Opens the team page.';
    g.setAttribute('aria-label', label);
    wrap.appendChild(g);
    return wrap;
  }
  function rowSub(m, head) {
    var live = m.teams.filter(function (t) { return t.live; }).length;
    var errs = m.teams.filter(function (t) { return t.error; });
    var sub = el('span', 'sub' + (errs.length ? ' err' : ''), errs.length ? "Couldn't read " + errs.length + ' schedule' + (errs.length > 1 ? 's' : '') + ' · ' + errs[0].error : dot(['ESPN', live ? live + ' live now' : m.teams.length + (m.teams.length === 1 ? ' team' : ' teams')]));
    head.appendChild(sub);
    if (errs.length) { var r = btn('btn sm ghost', 'Retry', function () { send('myteams', {}); }); r.tabIndex = -1; head.appendChild(r); }
    var e = btn('btn sm ghost lsp-chip', 'Edit teams', function () { openPicker(m.teams[0] ? m.teams[0].league : 'nhl'); });
    e.tabIndex = -1;
    head.appendChild(e);
  }
  /** The sports rows' heads: Standings, and Pick teams until he has some. */
  function headChips(m, head) {
    var lg = (m.events && m.events[0] && m.events[0].league) || 'nhl';
    var st = btn('btn sm ghost lsp-chip', 'Standings', function () { openStandings(lg); });
    st.tabIndex = -1;
    head.appendChild(st);
    if (!S.favs.length) {
      var p = btn('btn sm ghost lsp-chip', 'Pick your teams', function () { openPicker(lg); });
      p.tabIndex = -1;
      head.appendChild(p);
    }
  }
  /** The stage for a team card with no game to show (off-season, a failed schedule). */
  function stageTeam(t) {
    var txt = el('div', 'txt');
    var eb = el('div', 'eyebrow');
    eb.appendChild(el('span', 'rn', 'My teams'));
    eb.appendChild(el('span', 'chip', t.leagueName || leagueName(t.league)));
    txt.appendChild(eb);
    txt.appendChild(el('h1', '', t.name));
    var meta = el('div', 'meta');
    meta.appendChild(el('span', '', t.error ? "Couldn't read the schedule: " + t.error : t.offseason ? 'Off-season. No games scheduled yet.' : t.loading ? 'Reading the schedule…' : dot([t.record, t.standing])));
    txt.appendChild(meta);
    var acts = el('div', 'acts');
    acts.appendChild(btn('btn primary', 'Team page', function () { openTeam(t); }));
    txt.appendChild(acts);
    var pic = el('div', 'pic');
    var board = el('div', 'board');
    board.setAttribute('aria-hidden', 'true');
    var side = el('div', 'side');
    side.appendChild(logo(t));
    side.appendChild(el('span', '', t.abbr));
    board.appendChild(side);
    pic.appendChild(board);
    return [txt, pic];
  }
  /** The stage's buttons for a game: its page, and Watch this game when it is on. */
  function stageActs(ev) {
    var frag = document.createDocumentFragment();
    var p = btn('btn primary', 'Game page', function () { openGame(ev); });
    frag.appendChild(p);
    if (ev.state !== 'post') {
      var w = btn('btn', ev.state === 'in' ? 'Watch this game' : 'Where to watch', function () { openGame(ev, { watch: true }); });
      frag.appendChild(w);
    }
    return frag;
  }
  function cardFoot() { return 'Game page'; }

  /* ------------------------------------------------------------------ the overlay */

  function ensureRoot() {
    if (S.root) return;
    var r = el('div', 'lsp');
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    r.hidden = true;
    r.tabIndex = -1;
    var bar = el('div', 'lsp-bar');
    var back = btn('icon-btn lsp-back', '', function () { goBack(); });
    back.setAttribute('aria-label', 'Back');
    back.title = 'Back (Esc)';
    back.appendChild(el('span', 'lsp-arrow', '←'));
    bar.appendChild(back);
    S.crumbs = el('div', 'lsp-crumbs');
    bar.appendChild(S.crumbs);
    S.tools = el('div', 'lsp-tools');
    bar.appendChild(S.tools);
    var close = btn('btn sm ghost', 'Close', function () { closeAll(); });
    close.setAttribute('aria-label', 'Close and go back to Lumen');
    bar.appendChild(close);
    r.appendChild(bar);
    S.body = el('div', 'lsp-body');
    r.appendChild(S.body);
    // the page under us must not hear our keys or wheel (watch.js listens on document/window)
    r.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      else if (e.key === 'Tab') trapTab(e);
    });
    r.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
    document.body.appendChild(r);
    S.root = r;
  }
  function trapTab(e) {
    var f = [].slice.call(S.root.querySelectorAll('button:not([disabled]), input, [tabindex="0"]')).filter(function (n) { return n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function cur() { return S.views.length ? S.views[S.views.length - 1] : null; }
  function show(view) {
    ensureRoot();
    if (!S.views.length) S.returnFocus = document.activeElement;
    S.views.push(view);
    S.root.hidden = false;
    document.body.classList.add('lsp-open');
    render(true);
    load(view);
    try { S.root.querySelector('.lsp-back').focus({ preventScroll: true }); } catch (e) { /* fine */ }
  }
  function goBack() {
    stopPoll();
    S.views.pop();
    if (!S.views.length) { closeAll(); return; }
    render(true);
    var v = cur();
    if (v.type === 'game') schedulePoll(v);
  }
  function closeAll() {
    stopPoll();
    S.views = [];
    if (!S.root) return;
    S.root.hidden = true;
    S.body.replaceChildren();
    document.body.classList.remove('lsp-open');
    var f = S.returnFocus;
    S.returnFocus = null;
    if (f && f.isConnected && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch (e) { /* fine */ } }
  }
  function load(v) {
    if (v.type === 'game') { v.loading = true; send('game', gameAsk(v)); }
    else if (v.type === 'team') send('team', { league: v.league, id: v.id });
    else if (v.type === 'standings') {
      var c = S.standingsCache[v.league];
      if (c && Date.now() - c.at < 5 * 60e3) { v.data = c.data; v.error = ''; render(false); return; }
      send('standings', { league: v.league });
    } else if (v.type === 'picker') {
      if (S.teamsCache[v.league]) { v.teams = S.teamsCache[v.league]; render(false); return; }
      send('teams', { league: v.league });
    }
  }

  function openGame(ev, opts) {
    var id = String((ev && ev.id) || '').replace(/^espn:/, '');
    if (!ev || !/^\d{1,15}$/.test(id)) return;
    var v = { type: 'game', league: ev.league, id: id, seed: ev, game: null, error: '', at: 0, failures: 0, watchFirst: !!(opts && opts.watch) };
    var c = cur();
    if (c && c.type === 'game' && c.id === id) return;
    show(v);
  }
  /** A game read: the card's own WatchESPN player link and broadcasts ride along (the summary has neither). */
  function gameAsk(v) {
    var e = v.seed || {};
    var m = { league: v.league, id: v.id };
    if (typeof e.url === 'string' && /^https:\/\/www\.espn\.com\/watch\/player/.test(e.url)) m.watchUrl = e.url;
    if (Array.isArray(e.broadcasts)) m.broadcasts = e.broadcasts.filter(function (b) { return typeof b === 'string'; }).slice(0, 4);
    return m;
  }
  function openTeam(t) {
    if (!t || !t.id) return;
    var c = cur();
    if (c && c.type === 'team' && c.id === t.id && c.league === t.league) return;
    show({ type: 'team', league: t.league, id: String(t.id), seed: t, data: null, error: '' });
  }
  function openStandings(league) { show({ type: 'standings', league: league || 'nhl', data: null, error: '', mode: 'division' }); }
  function openPicker(league) { show({ type: 'picker', league: league || 'nhl', teams: null, error: '', q: '' }); }

  /* --- polling: only the open game page, only in sight ---------------------------------------- */

  function stopPoll() { clearTimeout(S.pollTimer); S.pollTimer = 0; clearInterval(S.tickTimer); S.tickTimer = 0; }
  function pollMs(v) {
    if (v.failures > 0) return POLL.backoff[Math.min(v.failures, POLL.backoff.length) - 1];
    var g = v.game;
    if (!g) return POLL.live;
    if (g.state === 'post' || g.status === 'postponed' || g.status === 'canceled') return null;
    if (g.state === 'pre') return (g.startsAt || 0) - Date.now() <= 15 * 60e3 ? POLL.soon : POLL.pre;
    if (g.status === 'break' || g.status === 'delayed' || g.status === 'suspended') return POLL.brk;
    return POLL.live;
  }
  function schedulePoll(v) {
    stopPoll();
    if (document.visibilityState === 'hidden' || cur() !== v) return;
    var ms = pollMs(v);
    if (ms === null) return;
    v.nextAt = Date.now() + ms;
    S.pollTimer = setTimeout(function () { if (cur() === v && document.visibilityState !== 'hidden') send('game', gameAsk(v)); }, ms);
    // the "updated N s ago" words, once every 10 s (not per frame)
    S.tickTimer = setInterval(function () { var u = S.root && S.root.querySelector('.lsp-upd-t'); if (u && v.at) u.textContent = 'Updated ' + agoText(v.at); }, 10000);
  }
  document.addEventListener('visibilitychange', function () {
    var v = cur();
    if (document.visibilityState === 'hidden') { stopPoll(); clearTimeout(S.myTimer); S.myTimer = 0; return; }
    if (v && v.type === 'game') { if (v.game && pollMs(v) !== null && Date.now() - v.at > 10000) send('game', gameAsk(v)); else schedulePoll(v); }
    myLiveTimer();
  });
  function myLiveTimer() {
    clearTimeout(S.myTimer);
    S.myTimer = 0;
    if (!S.my || !S.my.some(function (t) { return t.live; }) || document.visibilityState === 'hidden') return;
    S.myTimer = setTimeout(function () { send('myteams', {}); }, MY_LIVE_MS);
  }

  /* ------------------------------------------------------------------ rendering */

  function render(top) {
    var v = cur();
    if (!v || !S.root) return;
    var keep = top ? 0 : S.body.scrollTop;
    S.crumbs.replaceChildren();
    S.tools.replaceChildren();
    var nodes;
    if (v.type === 'game') nodes = gameView(v);
    else if (v.type === 'team') nodes = teamView(v);
    else if (v.type === 'standings') nodes = standingsView(v);
    else nodes = pickerView(v);
    S.body.replaceChildren(nodes);
    S.body.scrollTop = keep;
    S.root.setAttribute('aria-label', S.crumbs.textContent || 'Sports');
  }
  function crumb(text) { S.crumbs.appendChild(el('span', 'lsp-crumb', text)); }
  function tool(text, fn) { S.tools.appendChild(btn('btn sm ghost', text, fn)); }
  function stateBox(kind, title, words, actions) {
    var b = el('div', 'lsp-state ' + kind);
    b.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    b.appendChild(el('span', 'dot ' + (kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : '')));
    var t = el('div', 'lsp-state-t');
    t.appendChild(el('b', '', title));
    if (words) t.appendChild(el('span', '', words));
    b.appendChild(t);
    (actions || []).forEach(function (a) { b.appendChild(a); });
    return b;
  }
  function skeleton(lines) {
    var s = el('div', 'lsp-skel');
    s.setAttribute('aria-label', 'Loading');
    for (var i = 0; i < (lines || 4); i++) s.appendChild(el('span', 'sk'));
    return s;
  }
  function section(title, extra) {
    var s = el('section', 'lsp-sec');
    var h = el('h3', '', title);
    if (extra) h.appendChild(el('small', '', extra));
    s.appendChild(h);
    return s;
  }

  /* --- the game page --------------------------------------------------------------------------- */

  function seedGame(v) {
    var e = v.seed || {};
    var mk = function (t) { return { id: t.id || '', abbr: t.abbr || '', name: t.name || '', short: t.name || '', logo: t.logo || '', score: t.score || '', record: t.record || '', linescores: [] }; };
    return { id: v.id, league: v.league, leagueName: e.leagueName || leagueName(v.league), state: e.state || 'pre', status: e.state === 'in' ? 'live' : e.state === 'post' ? 'final' : 'scheduled', line: e.detail || '', startsAt: e.startsAt, away: mk(e.away || {}), home: mk(e.home || {}), periods: [], broadcasts: e.broadcasts || [], seedOnly: true };
  }
  function statusWords(g) {
    if (g.status === 'postponed') return 'Postponed';
    if (g.status === 'canceled') return 'Canceled';
    if (g.status === 'suspended') return 'Suspended' + (g.line && !/suspend/i.test(g.line) ? ' · ' + g.line : '');
    if (g.state === 'pre') return whenText(g.startsAt) || g.line;
    return g.line || (g.state === 'post' ? 'Final' : '');
  }
  function gameView(v) {
    var g = v.game || seedGame(v);
    var frag = document.createDocumentFragment();
    crumb(g.leagueName || leagueName(v.league));
    crumb(g.away.abbr && g.home.abbr ? g.away.abbr + ' at ' + g.home.abbr : 'Game');
    tool('Standings', function () { openStandings(v.league); });
    if (g.gamecastUrl) tool('Gamecast', function () { openInLayer(g.gamecastUrl, g.away.name + ' at ' + g.home.name); });

    // the scoreboard
    var hero = el('section', 'lsp-hero' + (g.state === 'in' ? ' is-live' : ''));
    var st = el('div', 'lsp-hero-st');
    if (g.state === 'in') st.appendChild(el('span', 'live', g.status === 'break' ? 'Intermission' : 'Live'));
    st.appendChild(el('span', 'lsp-st-w' + (g.status === 'postponed' || g.status === 'canceled' ? ' warn' : ''), statusWords(g)));
    hero.appendChild(st);
    var board = el('div', 'lsp-board');
    var pre = g.state === 'pre' || g.status === 'postponed' || g.status === 'canceled';
    [g.away, g.home].forEach(function (t, i) {
      var other = i ? g.away : g.home;
      var lose = !pre && g.state === 'post' && t.score !== '' && other.score !== '' && Number(t.score) < Number(other.score);
      var side = btn('lsp-side ' + (i ? 'home' : 'away') + (lose ? ' lo' : ''), '', function () { if (t.id) openTeam({ league: v.league, id: t.id, abbr: t.abbr, name: t.name, logo: t.logo }); });
      side.setAttribute('aria-label', (t.name || t.abbr) + (t.record ? ', ' + t.record : '') + '. Opens the team page.');
      side.appendChild(logo(t, 'lg'));
      var nm = el('span', 'lsp-side-n');
      nm.appendChild(el('b', '', t.name || t.abbr));
      nm.appendChild(el('small', '', dot([i ? 'Home' : 'Away', t.record])));
      side.appendChild(nm);
      if (isFavTeam(v.league, t.abbr, t.id)) side.appendChild(el('span', 'lsp-star mine', '★'));
      board.appendChild(side);
      if (!i) {
        var mid = el('div', 'lsp-score');
        if (pre) mid.appendChild(el('span', 'at', 'at'));
        else { mid.appendChild(el('span', 'n', g.away.score)); mid.appendChild(el('span', 'dash', '–')); mid.appendChild(el('span', 'n', g.home.score)); }
        board.appendChild(mid);
      }
    });
    hero.appendChild(board);
    hero.appendChild(el('div', 'lsp-hero-m', dot([g.leagueName, g.venue, (g.broadcasts || []).slice(0, 3).join(', ')])));
    frag.appendChild(hero);

    // live updates / errors
    if (v.error) {
      frag.appendChild(stateBox('err', v.game ? "Couldn't update this game" : "Couldn't read this game", v.error + (v.game && v.at ? '. Showing what ESPN said ' + agoText(v.at) + '.' : '.'), [btn('btn sm', 'Retry', function () { v.failures = 0; send('game', gameAsk(v)); })]));
    } else if (v.game && pollMs(v) !== null) {
      var upd = el('div', 'lsp-upd');
      upd.appendChild(el('span', 'lsp-upd-t', 'Updated ' + agoText(v.at)));
      upd.appendChild(el('span', '', g.state === 'in' ? 'Updates every ' + Math.round(pollMs(v) / 1000) + ' s while this page is open' : 'Checks again before the start'));
      frag.appendChild(upd);
    }

    // watch this game
    if (g.watch && g.state !== 'post') frag.appendChild(watchBlock(g, v));
    if (g.status === 'postponed' || g.status === 'canceled') {
      frag.appendChild(stateBox('warn', g.status === 'postponed' ? 'This game was postponed' : 'This game was canceled', g.detail && !/^(postponed|canceled)$/i.test(g.detail) ? g.detail : (g.status === 'postponed' ? "ESPN hasn't listed a new date yet. It shows on the team pages once it does." : '')));
    }

    if (!v.game && !v.error) { frag.appendChild(skeleton(6)); return frag; }
    if (!v.game) return frag;

    if (g.state === 'pre' && g.status === 'scheduled') {
      frag.appendChild(stateBox('', 'Not started', 'Starts ' + (dateText(g.startsAt, true) + ' at ' + timeText(g.startsAt)) + '. The box score fills in once it starts.'));
    }
    var cols = el('div', 'lsp-cols');
    var left = el('div', 'lsp-col'), right = el('div', 'lsp-col');
    if (g.periods.length) left.appendChild(periodTable(g));
    if (g.stars && g.stars.length) right.appendChild(starsBlock(g));
    else if (g.state === 'post' && g.league === 'nhl' && g.starsError) right.appendChild(stateBox('warn', 'No three stars', g.starsError));
    if (g.scoring) left.appendChild(playsBlock(g, g.scoring, g.sport === 'hockey' ? 'Scoring' : 'Scoring summary', g.sport === 'hockey' ? 'No goals yet' : 'No scoring yet'));
    if (g.penalties) left.appendChild(playsBlock(g, g.penalties, 'Penalties', 'No penalties'));
    if (g.goalies && g.goalies.length) right.appendChild(goaliesBlock(g));
    if (g.teamStats && g.teamStats.length) right.appendChild(statsBlock(g));
    if (left.childNodes.length) cols.appendChild(left);
    if (right.childNodes.length) cols.appendChild(right);
    if (cols.childNodes.length) frag.appendChild(cols);
    return frag;
  }
  function watchBlock(g, v) {
    var w = g.watch;
    var s = el('section', 'lsp-watch' + (v.watchFirst ? ' first' : ''));
    var h = el('div', 'lsp-watch-h');
    h.appendChild(el('b', '', g.state === 'in' ? 'Watch this game' : 'Where to watch'));
    s.appendChild(h);
    var row = el('div', 'lsp-watch-o');
    w.options.forEach(function (o, i) {
      var b = btn('btn' + (i === 0 ? ' primary' : ''), '', function () { openInLayer(o.url, g.away.name + ' at ' + g.home.name); });
      b.appendChild(el('span', '', o.label));
      b.title = o.note;
      b.dataset.service = o.service;
      b.setAttribute('aria-label', o.label + '. ' + o.note + '. Plays in Lumen.');
      var wrap = el('div', 'lsp-wo');
      wrap.appendChild(b);
      wrap.appendChild(el('small', '', o.note));
      row.appendChild(wrap);
    });
    if (w.options.length) s.appendChild(row);
    if (w.words) s.appendChild(el('p', 'lsp-watch-w', w.words));
    return s;
  }
  function periodTable(g) {
    var s = section(g.sport === 'baseball' ? 'Line score' : 'By period');
    var t = el('table', 'lsp-tbl lsp-lines');
    var hr = el('tr');
    hr.appendChild(el('th', 'tm', ''));
    g.periods.forEach(function (p) { hr.appendChild(el('th', '', p)); });
    hr.appendChild(el('th', 'tot', g.sport === 'baseball' ? 'R' : 'T'));
    if (g.sport === 'baseball') { hr.appendChild(el('th', 'tot', 'H')); hr.appendChild(el('th', 'tot', 'E')); }
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    [g.away, g.home].forEach(function (tm) {
      var r = el('tr');
      var c = el('td', 'tm');
      c.appendChild(logo(tm, 'sm'));
      c.appendChild(el('span', '', tm.abbr));
      r.appendChild(c);
      g.periods.forEach(function (_, i) { r.appendChild(el('td', '', tm.linescores[i] !== undefined ? tm.linescores[i] : '–')); });
      r.appendChild(el('td', 'tot', tm.score));
      if (g.sport === 'baseball') { r.appendChild(el('td', 'tot', tm.hits || '')); r.appendChild(el('td', 'tot', tm.errors || '')); }
      tb.appendChild(r);
    });
    t.appendChild(tb);
    var sc = el('div', 'lsp-scroll');
    sc.appendChild(t);
    s.appendChild(sc);
    return s;
  }
  function playsBlock(g, groups, title, none) {
    var total = groups.reduce(function (n, x) { return n + x.plays.length; }, 0);
    var s = section(title, total ? String(total) : '');
    if (!total) { s.appendChild(el('p', 'lsp-none', g.state === 'pre' ? 'Not started' : none)); return s; }
    groups.forEach(function (grp) {
      s.appendChild(el('h4', '', grp.label || 'Other'));
      var ul = el('ul', 'lsp-plays');
      grp.plays.forEach(function (p) {
        var li = el('li', p.side ? 'is-' + p.side : '');
        li.appendChild(el('span', 'lsp-clock', p.clock));
        var team = p.side === 'away' ? g.away : p.side === 'home' ? g.home : null;
        if (team) li.appendChild(logo(team, 'xs')); else li.appendChild(el('span', 'lsp-nologo'));
        var tx = el('span', 'lsp-ptext');
        if (p.tag) tx.appendChild(el('span', 'lsp-tag', p.tag));
        if (p.kind && g.sport !== 'hockey') tx.appendChild(el('b', '', p.kind + ' '));
        tx.appendChild(document.createTextNode(p.text));
        li.appendChild(tx);
        li.appendChild(el('span', 'lsp-psc', p.score || (p.minutes ? p.minutes + ' min' : '')));
        ul.appendChild(li);
      });
      s.appendChild(ul);
    });
    return s;
  }
  function goaliesBlock(g) {
    var s = section('Goalies');
    var t = el('table', 'lsp-tbl');
    var hr = el('tr');
    ['', 'SV', 'SA', 'SV%', 'TOI'].forEach(function (h, i) { hr.appendChild(el('th', i ? '' : 'tm', h)); });
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    g.goalies.forEach(function (x) {
      var r = el('tr');
      var c = el('td', 'tm');
      var team = x.side === 'away' ? g.away : x.side === 'home' ? g.home : null;
      if (team) c.appendChild(logo(team, 'xs'));
      c.appendChild(el('span', '', x.name));
      r.appendChild(c);
      [x.saves, x.shots, x.svPct, x.toi].forEach(function (val) { r.appendChild(el('td', '', val || '–')); });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    s.appendChild(t);
    return s;
  }
  function statsBlock(g) {
    var s = section('Team stats');
    var head = el('div', 'lsp-stat-h');
    head.appendChild(el('span', '', g.away.abbr));
    head.appendChild(el('span', '', g.home.abbr));
    s.appendChild(head);
    g.teamStats.forEach(function (st) {
      var r = el('div', 'lsp-stat');
      r.appendChild(el('span', 'a', st.away));
      r.appendChild(el('span', 'l', st.label));
      r.appendChild(el('span', 'h', st.home));
      var a = parseFloat(st.away), h = parseFloat(st.home);
      if (isFinite(a) && isFinite(h) && a + h > 0 && !/\//.test(st.away)) {
        var bar = el('span', 'lsp-bar2');
        var ba = el('i', 'ba'); ba.style.width = (100 * a / (a + h)).toFixed(1) + '%';
        bar.appendChild(ba);
        r.appendChild(bar);
      }
      s.appendChild(r);
    });
    return s;
  }
  function starsBlock(g) {
    var s = section('Three stars');
    var ol = el('ol', 'lsp-stars');
    g.stars.forEach(function (x) {
      var li = el('li');
      li.appendChild(el('span', 'lsp-starn', ['', '1st', '2nd', '3rd'][x.star] || String(x.star)));
      var t = el('span', 'lsp-starp');
      t.appendChild(el('b', '', x.name));
      t.appendChild(el('small', '', dot([x.abbr, x.line])));
      li.appendChild(t);
      ol.appendChild(li);
    });
    s.appendChild(ol);
    return s;
  }

  /* --- the team page ------------------------------------------------------------------------- */

  function teamView(v) {
    var frag = document.createDocumentFragment();
    var d = v.data;
    var t = d && d.team ? d.team : v.seed || {};
    crumb(leagueName(v.league));
    crumb(t.name || t.abbr || 'Team');
    tool('Standings', function () { openStandings(v.league); });
    var head = el('section', 'lsp-team-h');
    head.appendChild(logo(t, 'xl'));
    var nm = el('div', 'lsp-team-n');
    nm.appendChild(el('h2', '', t.name || t.abbr || 'Team'));
    nm.appendChild(el('span', '', dot([leagueName(v.league), t.record, t.standing])));
    head.appendChild(nm);
    if (t.id && t.name) head.appendChild(favButton({ id: t.id, abbr: t.abbr, name: t.name, logo: t.logo }, v.league));
    frag.appendChild(head);
    if (v.error) { frag.appendChild(stateBox('err', "Couldn't read the schedule", v.error + '.', [btn('btn sm', 'Retry', function () { v.error = ''; render(false); load(v); })])); return frag; }
    if (!d) { frag.appendChild(skeleton(6)); return frag; }
    var card = d.card || {};
    var tiles = el('div', 'lsp-tiles');
    var tile = function (label, ev, words) {
      var b = btn('lsp-tile' + (label === 'Live' ? ' is-live' : ''), '', function () { if (ev) openGame(ev); });
      b.appendChild(el('span', 'lsp-tile-l', label));
      var opp = ev ? (ev.isHome ? 'vs ' : 'at ') + (ev.opponent ? ev.opponent.name : '') : '';
      b.appendChild(el('b', '', opp));
      b.appendChild(el('span', '', words));
      if (!ev) b.disabled = true;
      tiles.appendChild(b);
    };
    if (card.live) {
      var mine = card.live.isHome ? card.live.home : card.live.away, theirs = card.live.isHome ? card.live.away : card.live.home;
      tile('Live', card.live, dot([mine.score + '–' + theirs.score, card.live.detail]));
    }
    if (card.next) tile('Next game', card.next, dot([whenText(card.next.startsAt), (card.next.broadcasts || []).slice(0, 2).join(', ')]));
    if (card.last) tile('Last result', card.last, dot([card.last.result, dateText(card.last.startsAt)]));
    if (tiles.childNodes.length) frag.appendChild(tiles);
    if (card.offseason) frag.appendChild(stateBox('', 'Off-season', "No games are scheduled yet. ESPN's schedule fills in once the league publishes it."));
    var s = section('Schedule', d.events.length ? d.events.length + ' games' : '');
    if (!d.events.length) s.appendChild(el('p', 'lsp-none', 'ESPN lists no games for this season yet.'));
    var month = '';
    var list = null;
    d.events.forEach(function (e) {
      var mk = '';
      try { mk = new Date(e.startsAt).toLocaleDateString([], { month: 'long', year: 'numeric' }); } catch (x) { mk = ''; }
      if (mk !== month) { month = mk; s.appendChild(el('h4', '', mk)); list = el('ul', 'lsp-sched'); s.appendChild(list); }
      var li = el('li');
      var b = btn('lsp-sched-r' + (e.state === 'in' ? ' is-live' : ''), '', function () { openGame(e); });
      b.appendChild(el('span', 'lsp-sd', dateText(e.startsAt)));
      var o = el('span', 'lsp-so');
      o.appendChild(el('small', '', e.isHome ? 'vs' : 'at'));
      if (e.opponent) { o.appendChild(logo(e.opponent, 'xs')); o.appendChild(el('span', '', e.opponent.name)); }
      b.appendChild(o);
      var res = e.status === 'postponed' ? 'Postponed' : e.status === 'canceled' ? 'Canceled' : e.state === 'in' ? dot(['Live', e.detail]) : e.state === 'post' ? e.result || e.detail : timeText(e.startsAt);
      b.appendChild(el('span', 'lsp-sr' + (/^W/.test(res) ? ' w' : /^L/.test(res) ? ' l' : e.status === 'postponed' ? ' warn' : ''), res));
      b.appendChild(el('span', 'lsp-sb', e.state === 'post' ? '' : (e.broadcasts || []).slice(0, 2).join(', ')));
      li.appendChild(b);
      list.appendChild(li);
    });
    frag.appendChild(s);
    return frag;
  }

  /* --- standings ----------------------------------------------------------------------------- */

  function leagueTabs(v, onPick) {
    var tabs = el('div', 'lsp-tabs');
    tabs.setAttribute('role', 'tablist');
    LEAGUES.forEach(function (l) {
      var b = btn('lsp-tab' + (l[0] === v.league ? ' on' : ''), l[1], function () { onPick(l[0]); });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', l[0] === v.league ? 'true' : 'false');
      tabs.appendChild(b);
    });
    return tabs;
  }
  function standingsView(v) {
    var frag = document.createDocumentFragment();
    crumb('Standings');
    crumb(leagueName(v.league));
    frag.appendChild(leagueTabs(v, function (lg) { v.league = lg; v.data = null; v.error = ''; render(true); load(v); }));
    if (v.error) { frag.appendChild(stateBox('err', "Couldn't read the standings", v.error + '.', [btn('btn sm', 'Retry', function () { v.error = ''; delete S.standingsCache[v.league]; render(false); load(v); })])); return frag; }
    var d = v.data;
    if (!d) { frag.appendChild(skeleton(8)); return frag; }
    if (d.empty || !d.groups.length) { frag.appendChild(stateBox('', 'No standings yet', 'ESPN has no table for this season yet (the off-season, or before the first game).')); return frag; }
    if (d.wildcard) {
      var seg = el('div', 'lsp-seg');
      [['division', 'Division'], ['wildcard', 'Wild card']].forEach(function (m) {
        var b = btn('lsp-tab' + (v.mode === m[0] ? ' on' : ''), m[1], function () { v.mode = m[0]; render(false); });
        b.setAttribute('aria-pressed', v.mode === m[0] ? 'true' : 'false');
        seg.appendChild(b);
      });
      frag.appendChild(seg);
    }
    var grid = el('div', 'lsp-st-grid');
    if (d.wildcard && v.mode === 'wildcard') {
      d.wildcard.forEach(function (c) {
        var s = section(c.conference);
        c.divisions.forEach(function (dv) { s.appendChild(standTable(v, d.cols, dv.rows, dv.name, 0)); });
        s.appendChild(standTable(v, d.cols, c.race, 'Wild card', c.cut));
        grid.appendChild(s);
      });
    } else {
      var parents = [];
      d.groups.forEach(function (g) { if (parents.indexOf(g.parent) === -1) parents.push(g.parent); });
      parents.forEach(function (p) {
        var s = section(p || leagueName(v.league));
        d.groups.filter(function (g) { return g.parent === p; }).forEach(function (g) { s.appendChild(standTable(v, d.cols, g.rows, g.name === p ? '' : g.name, 0)); });
        grid.appendChild(s);
      });
    }
    frag.appendChild(grid);
    return frag;
  }
  function standTable(v, cols, rows, title, cut) {
    var wrap = el('div', 'lsp-st');
    if (title) wrap.appendChild(el('h4', '', title));
    var t = el('table', 'lsp-tbl lsp-stand');
    var hr = el('tr');
    hr.appendChild(el('th', 'rk', ''));
    hr.appendChild(el('th', 'tm', 'Team'));
    cols.forEach(function (c) { hr.appendChild(el('th', '', c)); });
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    rows.forEach(function (r, i) {
      var tr = el('tr', (isFavTeam(v.league, r.abbr, r.id) ? 'mine' : '') + (cut && i === cut ? ' cut' : ''));
      tr.tabIndex = 0;
      tr.setAttribute('role', 'link');
      tr.setAttribute('aria-label', r.name + '. Opens the team page.');
      var go = function () { openTeam({ league: v.league, id: r.id, abbr: r.abbr, name: r.name, logo: r.logo }); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      tr.appendChild(el('td', 'rk', String(i + 1)));
      var c = el('td', 'tm');
      c.appendChild(logo(r, 'xs'));
      c.appendChild(el('span', 'full', r.name));
      c.appendChild(el('span', 'ab', r.abbr));
      if (r.note) c.title = r.note;
      tr.appendChild(c);
      r.cells.forEach(function (x, k) { tr.appendChild(el('td', cols[k] === 'PTS' ? 'pts' : '', x)); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  /* --- the picker ---------------------------------------------------------------------------- */

  function pickerView(v) {
    var frag = document.createDocumentFragment();
    crumb('My teams');
    crumb('Pick your teams');
    var intro = el('p', 'lsp-intro', 'Your teams get a My teams row in Lumen with their next game, live score and last result, and lead the Live now row. They are saved on this PC only.');
    frag.appendChild(intro);
    if (S.note) { frag.appendChild(stateBox('err', S.note, '')); S.note = ''; }
    if (S.favs.length) {
      var mine = el('div', 'lsp-mine');
      S.favs.forEach(function (f) {
        var chip = btn('lsp-minec', '', function () { toggleFav(f, f.league, false); });
        chip.appendChild(logo(f, 'xs'));
        chip.appendChild(el('span', '', f.name));
        chip.appendChild(el('span', 'x', '×'));
        chip.setAttribute('aria-label', 'Remove ' + f.name + ' from My teams');
        mine.appendChild(chip);
      });
      frag.appendChild(mine);
    }
    frag.appendChild(leagueTabs(v, function (lg) { v.league = lg; v.teams = null; v.error = ''; v.q = ''; render(true); load(v); }));
    if (v.error) { frag.appendChild(stateBox('err', "Couldn't read the team list", v.error + '.', [btn('btn sm', 'Retry', function () { v.error = ''; render(false); load(v); })])); return frag; }
    if (!v.teams) { frag.appendChild(skeleton(6)); return frag; }
    var find = document.createElement('input');
    find.type = 'search';
    find.className = 'lsp-find';
    find.placeholder = 'Find a team';
    find.setAttribute('aria-label', 'Find a team');
    find.value = v.q || '';
    var grid = el('div', 'lsp-picks');
    var draw = function () {
      var q = (v.q || '').toLowerCase();
      grid.replaceChildren();
      v.teams.filter(function (t) { return !q || t.name.toLowerCase().indexOf(q) !== -1 || t.abbr.toLowerCase() === q; }).forEach(function (t) {
        var on = isFavTeam(v.league, t.abbr, t.id);
        var b = btn('lsp-pick' + (on ? ' on' : ''), '', function () { toggleFav(t, v.league, !on); b.disabled = true; });
        b.appendChild(logo(t, 'md'));
        b.appendChild(el('span', 'n', t.name));
        b.appendChild(el('span', 'lsp-star', on ? '★' : '☆'));
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.setAttribute('aria-label', (on ? 'Remove ' : 'Add ') + t.name + (on ? ' from' : ' to') + ' My teams');
        grid.appendChild(b);
      });
      if (!grid.childNodes.length) grid.appendChild(el('p', 'lsp-none', 'No team matches "' + v.q + '".'));
    };
    find.addEventListener('input', function () { v.q = find.value.slice(0, 40); draw(); });
    frag.appendChild(find);
    draw();
    frag.appendChild(grid);
    return frag;
  }

  /* ------------------------------------------------------------------ main's answers */

  function rerenderRows() { try { if (typeof window.__lumenRerender === 'function') window.__lumenRerender(); } catch (e) { /* the rows redraw next update */ } }

  window.__applySports = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    var v = cur();
    if (msg.kind === 'favs') {
      S.favs = Array.isArray(msg.favs) ? msg.favs : [];
      S.favsKnown = true;
      if (msg.error) S.note = String(msg.error).slice(0, 160);
      if (S.my) S.my = S.my.filter(function (t) { return S.favs.some(function (f) { return favKey(f.league, f.id) === t.key; }); });
      rerenderRows();
      if (v && (v.type === 'picker' || v.type === 'team' || v.type === 'standings' || v.type === 'game')) render(false);
    } else if (msg.kind === 'myteams') {
      S.my = Array.isArray(msg.teams) ? msg.teams : [];
      S.myAt = msg.at || Date.now();
      rerenderRows();
      myLiveTimer();
    } else if (msg.kind === 'game') {
      if (!v || v.type !== 'game' || v.league !== msg.league || v.id !== String(msg.id)) return;
      v.loading = false;
      if (msg.error) { v.error = String(msg.error); v.failures++; }
      else if (msg.game) { v.game = msg.game; v.error = ''; v.failures = 0; v.at = msg.at || Date.now(); }
      render(false);
      schedulePoll(v);
    } else if (msg.kind === 'team') {
      if (!v || v.type !== 'team' || v.league !== msg.league || v.id !== String(msg.id)) return;
      if (msg.error) v.error = String(msg.error); else { v.data = { team: msg.team, events: msg.events || [], card: msg.card }; v.error = ''; }
      render(false);
    } else if (msg.kind === 'teams') {
      if (!msg.error && Array.isArray(msg.teams)) S.teamsCache[msg.league] = msg.teams;
      if (!v || v.type !== 'picker' || v.league !== msg.league) return;
      if (msg.error) v.error = String(msg.error); else { v.teams = msg.teams; v.error = ''; }
      render(false);
    } else if (msg.kind === 'standings') {
      if (!msg.error) S.standingsCache[msg.league] = { at: Date.now(), data: msg };
      if (!v || v.type !== 'standings' || v.league !== msg.league) return;
      if (msg.error) v.error = String(msg.error); else { v.data = msg; v.error = ''; }
      render(false);
    } else if (msg.kind === 'open') {
      closeAll();
      openGame({ league: msg.league, id: msg.id });
    }
  };
  // the e2e and the score pins' route: open a game page by league + id
  window.__lumenOpenGame = function (league, id) { openGame({ league: league, id: id }); };

  window.LumenSports = {
    isFav: isFav, isBig: isBig, liveOnTop: liveOnTop, sortLive: sortLive,
    myTeamsRow: myTeamsRow, rowSig: rowSig, teamCardEl: teamCardEl, rowSub: rowSub, headChips: headChips,
    stageTeam: stageTeam, stageActs: stageActs, cardFoot: cardFoot,
    openGame: openGame, openTeam: openTeam, openStandings: openStandings, openPicker: openPicker,
    isOpen: function () { return S.views.length > 0; }, close: closeAll,
    _state: function () { var v = cur(); return { views: S.views.map(function (x) { return x.type; }), favs: S.favs.length, my: S.my ? S.my.length : null, poll: !!S.pollTimer, pollMs: v && v.type === 'game' ? pollMs(v) : null, myTimer: !!S.myTimer }; }
  };
  send('hello', {});
})();
