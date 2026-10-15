/* ============================================================
   firstrun.js - the chrome's side of the first-run welcome.

   welcome.html is a bundled, preload-less guest like the history
   page: it shows the steps, and every choice comes back here as a
   console line, `welcome:<verb> {json}`, answered by pushing the
   whole state into window.__applyWelcome(state). Nothing on the
   page decides anything; this file applies the choice through the
   same public setters Settings uses, so a choice made here is the
   same choice made there:

     look     QuartzTheme.setMode('system'|'light'|'dark')  (Look Sync)
     engine   Settings.set({ searchEngine })
     default  api.firstrun.makeDefault()  (register-default-browser.ps1
              + Windows Settings), then api.firstrun.defaultStatus()
     finish   api.firstrun.done('finished'|'skipped'), then the tab
              closes and Home takes the front

   WHEN it shows: main (firstrun-main.js) owns the flag in the
   profile. boot() asks once after the strip is built; main answers
   show only for a brand-new profile (or one that quit halfway
   through the welcome). Settings > About "Show welcome again" calls
   open() at any time.

   window.FirstRun: boot(session) open() isWelcomeUrl(url)
   welcomeUrl() handleLine(tab, viewEl, text) state() _debug()
   ============================================================ */
(function () {
  'use strict';

  var WELCOME_URL = (function () {
    try { return new URL('welcome.html', window.location.href).href; } catch (err) { return 'welcome.html'; }
  })();
  var LINE = /^welcome:([a-z-]+)\s*(\{.*\})?\s*$/;
  var MODES = ['system', 'light', 'dark'];
  var POLL_MS = 2500;
  var POLL_FOR_MS = 3 * 60 * 1000;

  var st = {
    booted: false,
    decision: null,       // main's answer to firstrun:state, or null
    opened: 0,            // how many times a welcome tab was opened this run
    finished: null,       // { how, ok, reason } once done was asked for
    defaultBrowser: { state: 'idle', reason: '', app: '' },
    braveKey: null,       // true/false once main said, null = unknown
    lastPush: null,
    lines: []             // the last few lines heard, for the harness
  };
  var pollTimer = 0;
  var pollUntil = 0;

  function api() {
    var a = window.api && window.api.firstrun;
    return a && typeof a.state === 'function' ? a : null;
  }

  function isWelcomeUrl(url) {
    return typeof url === 'string' && url.indexOf(WELCOME_URL) === 0;
  }

  function allTabs() {
    try { return Array.isArray(window.tabs) ? window.tabs : (typeof tabs !== 'undefined' ? tabs : []); } catch (err) { return []; }
  }

  function welcomeTabs() {
    return allTabs().filter(function (t) { return t && t.kind === 'page' && isWelcomeUrl(t.url); });
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /** The page wears the look from its first frame: theme, palette and hue ride in the URL. */
  function welcomeUrl() {
    var p = new URLSearchParams();
    p.set('theme', currentTheme());
    var s = window.Settings;
    if (s && typeof s.all === 'function') {
      try {
        var all = s.all() || {};
        if (typeof all.accentHue === 'number' && isFinite(all.accentHue)) p.set('hue', String(all.accentHue));
        if (all.palette && all.palette !== 'aurora') p.set('palette', String(all.palette));
      } catch (err) { /* the authored look is fine */ }
    }
    return WELCOME_URL + '?' + p.toString();
  }

  /* ---- the state the page renders -------------------------------------------------------- */

  function engineList() {
    var s = window.Settings;
    if (!s || typeof s.engines !== 'function') return [];
    try {
      return (s.engines() || []).map(function (e) { return { id: e.id, name: e.name }; });
    } catch (err) { return []; }
  }

  function state() {
    var theme = window.QuartzTheme;
    var s = window.Settings;
    var ls = window.LookSync;
    var engine = '';
    try { engine = s && typeof s.get === 'function' ? String(s.get('searchEngine') || '') : ''; } catch (err) { engine = ''; }
    return {
      mode: theme && typeof theme.mode === 'function' ? theme.mode() : null,
      resolved: currentTheme(),
      themeReason: theme && typeof theme.reason === 'function' ? (theme.reason() || '') : '',
      canSetLook: !!(theme && typeof theme.setMode === 'function'),
      lookSync: !!(ls && typeof ls.enabled === 'function' && ls.enabled()),
      engines: engineList(),
      engine: engine,
      braveKey: st.braveKey,
      defaultBrowser: st.defaultBrowser,
      canDefault: !!(api() && typeof api().makeDefault === 'function'),
      finished: st.finished,
      reopened: st.opened > 1 || !!(st.decision && !st.decision.show)
    };
  }

  function pushTo(tab) {
    if (!tab || !tab.viewEl || typeof tab.viewEl.executeJavaScript !== 'function') return;
    if (typeof window.isViewUsable === 'function' && !window.isViewUsable(tab)) return;
    var payload = state();
    st.lastPush = payload;
    try {
      var pending = tab.viewEl.executeJavaScript('window.__applyWelcome && window.__applyWelcome(' + JSON.stringify(payload) + ')');
      if (pending && typeof pending.catch === 'function') pending.catch(function () { /* the page went away */ });
    } catch (err) { /* not dom-ready yet; the page says hello when it is */ }
  }

  function pushAll() {
    welcomeTabs().forEach(pushTo);
  }

  function refreshBraveKey() {
    var b = window.api && window.api.braveSearch;
    if (!b || typeof b.describe !== 'function') { st.braveKey = null; return Promise.resolve(); }
    return Promise.resolve().then(function () { return b.describe(); }).then(function (d) {
      st.braveKey = d && typeof d === 'object' ? !!d.hasKey : null;
    }).catch(function () { st.braveKey = null; });
  }

  /* ---- the default browser -------------------------------------------------------------- */

  function stopPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
  }

  /** After Windows Settings opened: ask Windows again every few seconds until it says Quartz. */
  function pollDefault() {
    stopPoll();
    if (!welcomeTabs().length || Date.now() > pollUntil) return;
    pollTimer = setTimeout(function () {
      pollTimer = 0;
      checkDefault(true).then(function () {
        if (st.defaultBrowser.state === 'settings-opened' || st.defaultBrowser.state === 'registered') pollDefault();
      });
    }, POLL_MS);
  }

  function checkDefault(quiet) {
    var a = api();
    if (!a || typeof a.defaultStatus !== 'function') return Promise.resolve();
    return Promise.resolve().then(function () { return a.defaultStatus(); }).then(function (r) {
      if (!r || typeof r !== 'object') return;
      var db = st.defaultBrowser;
      if (r.isDefault === true) {
        st.defaultBrowser = { state: 'confirmed', reason: '', app: 'Quartz' };
        stopPoll();
        pushAll();
      } else if (db.state === 'idle' || db.state === 'unknown') {
        st.defaultBrowser = { state: r.isDefault === false ? 'idle' : 'unknown', reason: r.reason || '', app: r.app || '' };
        pushAll();
      } else if (!quiet) {
        st.defaultBrowser = Object.assign({}, db, { checked: Date.now(), app: r.app || db.app || '' });
        pushAll();
      }
    }).catch(function (err) {
      if (!quiet) {
        st.defaultBrowser = Object.assign({}, st.defaultBrowser, { checkError: (err && err.message) || String(err) });
        pushAll();
      }
    });
  }

  function makeDefault() {
    var a = api();
    if (!a || typeof a.makeDefault !== 'function') {
      st.defaultBrowser = { state: 'failed', reason: 'this window predates the welcome; restart Quartz and try again' };
      pushAll();
      return;
    }
    if (st.defaultBrowser.state === 'working') return;
    st.defaultBrowser = { state: 'working', reason: '' };
    pushAll();
    Promise.resolve().then(function () { return a.makeDefault(); }).then(function (r) {
      if (!r || typeof r !== 'object') {
        st.defaultBrowser = { state: 'failed', reason: 'Quartz did not answer' };
      } else {
        st.defaultBrowser = { state: r.state || (r.ok ? 'registered' : 'failed'), reason: r.reason || '', simulated: !!r.simulated };
      }
      pushAll();
      if (st.defaultBrowser.state === 'settings-opened' || st.defaultBrowser.state === 'registered') {
        pollUntil = Date.now() + POLL_FOR_MS;
        pollDefault();
      }
    }).catch(function (err) {
      st.defaultBrowser = { state: 'failed', reason: (err && err.message) || String(err) };
      pushAll();
    });
  }

  /* ---- open, finish ----------------------------------------------------------------------- */

  function activate(tab) {
    if (tab && typeof window.activateTab === 'function') {
      try { window.activateTab(tab.id); } catch (err) { /* gone */ }
    }
  }

  function open() {
    var have = welcomeTabs();
    st.opened++;
    st.finished = null;
    if (have.length) {
      activate(have[0]);
      pushTo(have[0]);
      return have[0];
    }
    if (typeof window.createTab !== 'function') return null;
    refreshBraveKey().then(pushAll);
    checkDefault(true);
    return window.createTab(welcomeUrl());
  }

  function homeInFront() {
    var list = allTabs();
    var home = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t.kind === 'page' && typeof window.isNewTabUrl === 'function' && window.isNewTabUrl(t.url)
        && (typeof window.visibleTabs !== 'function' || window.visibleTabs().indexOf(t) >= 0)) { home = t; break; }
    }
    if (home) activate(home);
    else if (typeof window.createTab === 'function') window.createTab('');
    if (typeof window.focusOmnibox === 'function') {
      try { window.focusOmnibox(); } catch (err) { /* nothing to focus */ }
    }
  }

  function finish(how) {
    var h = how === 'skipped' ? 'skipped' : 'finished';
    var a = api();
    stopPoll();
    var close = function () {
      var list = welcomeTabs();
      homeInFront();
      list.forEach(function (t) {
        if (typeof window.closeTab === 'function') { try { window.closeTab(t.id); } catch (err) { /* gone */ } }
      });
    };
    if (!a || typeof a.done !== 'function') {
      st.finished = { how: h, ok: false, reason: 'this window predates the welcome; it may show again after a restart' };
      pushAll();
      return;
    }
    Promise.resolve().then(function () { return a.done(h); }).then(function (r) {
      if (r && r.ok) {
        st.finished = { how: h, ok: true };
        close();
      } else {
        // Said out loud on the page, with a way out: never a silent stay-put.
        st.finished = { how: h, ok: false, reason: (r && r.reason) || 'Quartz did not answer' };
        pushAll();
      }
    }).catch(function (err) {
      st.finished = { how: h, ok: false, reason: (err && err.message) || String(err) };
      pushAll();
    });
  }

  /* ---- the page's console lines ----------------------------------------------------------- */

  function handleLine(tab, viewEl, text) {
    if (!tab || tab.viewEl !== viewEl || !isWelcomeUrl(tab.url)) return false;
    if (typeof text !== 'string' || text.indexOf('welcome:') !== 0) return false;
    var m = LINE.exec(text.trim());
    if (!m) return false;
    var verb = m[1];
    var arg = {};
    if (m[2]) { try { arg = JSON.parse(m[2]) || {}; } catch (err) { return false; } }
    st.lines.push(verb);
    if (st.lines.length > 40) st.lines.shift();

    if (verb === 'hello') {
      pushTo(tab);
      refreshBraveKey().then(function () { pushTo(tab); });
      if (st.defaultBrowser.state === 'idle' || st.defaultBrowser.state === 'unknown') checkDefault(true);
      return true;
    }
    if (verb === 'look') {
      var theme = window.QuartzTheme;
      if (MODES.indexOf(arg.mode) < 0 || !theme || typeof theme.setMode !== 'function') { pushTo(tab); return false; }
      Promise.resolve(theme.setMode(arg.mode)).then(function () { pushAll(); }, function () { pushAll(); });
      return true;
    }
    if (verb === 'engine') {
      var s = window.Settings;
      var ok = engineList().some(function (e) { return e.id === arg.id; });
      if (!ok || !s || typeof s.set !== 'function') { pushTo(tab); return false; }
      s.set({ searchEngine: arg.id });
      if (arg.id === 'brave-api') refreshBraveKey().then(pushAll);
      pushAll();
      return true;
    }
    if (verb === 'default') { makeDefault(); return true; }
    if (verb === 'default-check') { checkDefault(false); return true; }
    if (verb === 'settings') {
      var set = window.Settings;
      if (set && typeof set.open === 'function') { try { set.open(String(arg.section || '')); } catch (err) { return false; } }
      return true;
    }
    if (verb === 'finish') { finish(arg.how); return true; }
    return false;
  }

  /* ---- boot -------------------------------------------------------------------------------- */

  /** True when this renderer already holds signs of use (the main check's second opinion). */
  function profileLooksUsed(session) {
    if (session && Array.isArray(session.tabs) && session.tabs.some(function (t) { return t && !isWelcomeUrl(t.url); })) return 'session';
    try {
      var h = JSON.parse(window.localStorage.getItem('history') || 'null');
      if (Array.isArray(h) && h.length) return 'history';
      if (h && Array.isArray(h.items) && h.items.length) return 'history';
    } catch (err) { /* unreadable: no opinion */ }
    return '';
  }

  function boot(session) {
    if (st.booted) return Promise.resolve(st.decision);
    st.booted = true;
    var a = api();
    if (!a) { st.decision = { show: false, reason: 'no-api' }; return Promise.resolve(st.decision); }
    return Promise.resolve().then(function () { return a.state(); }).then(function (d) {
      st.decision = d || { show: false, reason: 'no-answer' };
      if (!d || !d.show) return st.decision;
      if (d.reason === 'new-profile') {
        var used = profileLooksUsed(session);
        if (used) {
          st.decision = Object.assign({}, d, { show: false, reason: 'existing-profile', chromeEvidence: used });
          if (typeof a.done === 'function') a.done('existing-profile');
          return st.decision;
        }
      }
      open();
      return st.decision;
    }).catch(function (err) {
      st.decision = { show: false, reason: 'error', error: (err && err.message) || String(err) };
      return st.decision;
    });
  }

  // A theme flip from anywhere (the toolbar, Look Sync, Windows) re-renders the page's picks.
  document.addEventListener('quartzthemechange', function () { pushAll(); });

  window.FirstRun = {
    boot: boot,
    open: open,
    isWelcomeUrl: isWelcomeUrl,
    welcomeUrl: welcomeUrl,
    handleLine: handleLine,
    state: state,
    _debug: function () {
      return {
        booted: st.booted,
        decision: st.decision,
        opened: st.opened,
        finished: st.finished,
        defaultBrowser: st.defaultBrowser,
        braveKey: st.braveKey,
        lines: st.lines.slice(),
        welcomeTabs: welcomeTabs().map(function (t) { return { id: t.id, url: t.url }; })
      };
    }
  };
})();
