'use strict';

/*
 * welcome.js - the first-run welcome, as a page.
 *
 * Runs inside a <webview> on file://, with no node and no preload (the same
 * arrangement as historypage.js). Loaded from <head> above the stylesheet so
 * window.__applyWelcome exists before the chrome can call it.
 *
 * THE CONTRACT, both ways (the chrome half is firstrun.js):
 *
 *   out  console.log('welcome:<verb> ' + JSON.stringify(arg))
 *          hello {}                 send me the state
 *          look {mode}              'system' | 'light' | 'dark'
 *          engine {id}              one of state.engines
 *          default {}               register with Windows + open Settings
 *          default-check {}         ask Windows again
 *          settings {section}       open Settings at a section
 *          finish {how}             'finished' | 'skipped'
 *
 *   in   window.__applyWelcome(state), after every change, with
 *          { mode, resolved, themeReason, canSetLook, lookSync, engines:[{id,name}],
 *            engine, braveKey, defaultBrowser:{state,reason,app}, canDefault,
 *            finished:{how,ok,reason}|null, reopened }
 *
 * The page never decides anything: it shows what the chrome says is true, so
 * a choice the browser could not take shows as not taken, with the reason.
 *
 * MOTION. A step fades in over 240 ms and stops; the progress fills in 200 ms.
 * Nothing loops. prefers-reduced-motion turns both off.
 */

(function () {
  var STEPS = ['welcome', 'look', 'search', 'default', 'tour'];
  var NO_ANSWER_MS = 4000;

  /* Plain, true one-liners for the engines Settings knows. An engine added
     later still shows, just without a line under its name. */
  var ENGINE_LINES = {
    google: 'The results most people know.',
    duckduckgo: 'Private search from DuckDuckGo.',
    bing: 'Microsoft’s search engine.',
    brave: 'Brave’s own index, on search.brave.com. No key needed.',
    startpage: 'Google’s results, with Startpage in between for privacy.',
    'brave-api': 'Results on Quartz’s own page, from the Brave Search API. Needs a key.'
  };

  var state = null;
  var step = 0;
  var answered = false;
  var els = {};

  function say(verb, arg) {
    try { console.log('welcome:' + verb + ' ' + JSON.stringify(arg || {})); } catch (err) { /* nothing to say it to */ }
  }

  function $(id) { return document.getElementById(id); }

  /* ---- steps -------------------------------------------------------------- */

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll('.wc-step'));
  }

  function focusStep(sec) {
    var target = sec.querySelector('[role="radio"][aria-checked="true"]')
      || sec.querySelector('[data-focus]')
      || (STEPS[step] === 'default' ? (els.makeDefault && !els.makeDefault.hidden && !els.makeDefault.disabled ? els.makeDefault : $('default-next')) : null)
      || (STEPS[step] === 'tour' ? $('finish') : null)
      || sec.querySelector('[role="radio"]')
      || sec.querySelector('.wc-h');
    if (target) { try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); } }
  }

  function go(n) {
    var to = Math.max(0, Math.min(STEPS.length - 1, n));
    step = to;
    var secs = sections();
    secs.forEach(function (sec, i) {
      var on = i === to;
      sec.hidden = !on;
      sec.classList.toggle('is-on', on);
    });
    document.documentElement.setAttribute('data-step', STEPS[to]);
    // Progress: hidden on the hello, then 1..4.
    var prog = els.progress;
    if (prog) {
      prog.hidden = to === 0;
      prog.setAttribute('aria-valuenow', String(Math.max(1, to)));
      Array.prototype.forEach.call(prog.querySelectorAll('.wc-seg'), function (seg, i) {
        seg.classList.toggle('is-done', i < to);
        seg.classList.toggle('is-now', i === to - 1);
      });
    }
    // Nothing left to skip on the last step.
    if (els.skip) els.skip.hidden = to === STEPS.length - 1;
    var h = secs[to] && secs[to].querySelector('.wc-h');
    if (els.announce && h) els.announce.textContent = (to ? 'Step ' + to + ' of 4: ' : '') + h.textContent;
    window.scrollTo(0, 0);
    if (secs[to]) focusStep(secs[to]);
  }

  /* ---- radio groups (look, engines): roving tabindex, arrows move AND pick -- */

  function wireRadioGroup(group, pick) {
    group.addEventListener('click', function (ev) {
      var r = ev.target && ev.target.closest && ev.target.closest('[role="radio"]');
      if (!r || !group.contains(r) || r.disabled) return;
      pick(r);
    });
    group.addEventListener('keydown', function (ev) {
      var radios = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]')).filter(function (r) { return !r.disabled; });
      if (!radios.length) return;
      var i = radios.indexOf(document.activeElement);
      var next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % radios.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + radios.length) % radios.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = radios.length - 1;
      else if ((ev.key === ' ' || ev.key === 'Enter') && i >= 0) { ev.preventDefault(); pick(radios[i]); return; }
      if (next < 0) return;
      ev.preventDefault();
      radios[next].focus();
      pick(radios[next]);
    });
  }

  function markRadios(group, isOn) {
    var radios = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
    var any = false;
    radios.forEach(function (r) {
      var on = !!isOn(r);
      any = any || on;
      r.setAttribute('aria-checked', on ? 'true' : 'false');
      r.classList.toggle('is-on', on);
      r.tabIndex = on ? 0 : -1;
    });
    if (!any && radios[0]) radios[0].tabIndex = 0;
  }

  /* ---- rendering what the chrome says ------------------------------------- */

  function renderLook() {
    var group = els.looks;
    if (!group) return;
    var mode = state ? state.mode : null;
    markRadios(group, function (r) { return r.getAttribute('data-mode') === mode; });
    var sub = $('system-sub');
    if (sub) {
      if (mode === 'system' && state.themeReason) {
        sub.textContent = 'Windows didn’t say, so dark for now';
      } else if (mode === 'system') {
        sub.textContent = 'Windows is using ' + (state.resolved === 'light' ? 'light' : 'dark') + ' mode';
      } else {
        sub.textContent = 'Follows your Windows app mode';
      }
    }
    var note = $('look-note');
    if (note) {
      var parts = [];
      if (mode === 'system' && state.themeReason) parts.push('Windows didn’t say which mode its apps use (' + state.themeReason + ').');
      if (state && state.lookSync) parts.push('Helm and Mantle wear the same look through Look Sync, if you use them.');
      parts.push('Accent colours and backgrounds are in Settings › Look.');
      note.textContent = parts.join(' ');
    }
    group.setAttribute('aria-disabled', state && state.canSetLook === false ? 'true' : 'false');
  }

  function buildEngines() {
    var group = els.engines;
    if (!group || !state || !Array.isArray(state.engines)) return;
    var have = Array.prototype.map.call(group.querySelectorAll('[role="radio"]'), function (r) { return r.getAttribute('data-id'); }).join('|');
    var want = state.engines.map(function (e) { return e.id; }).join('|');
    if (have === want) return;
    var focusedId = document.activeElement && group.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
    group.textContent = '';
    state.engines.forEach(function (e) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wc-engine';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('data-id', String(e.id));
      b.tabIndex = -1;
      var dot = document.createElement('span');
      dot.className = 'wc-dot';
      dot.setAttribute('aria-hidden', 'true');
      var text = document.createElement('span');
      text.className = 'wc-engine-text';
      var name = document.createElement('span');
      name.className = 'wc-engine-name';
      name.textContent = String(e.name || e.id);
      text.appendChild(name);
      var line = ENGINE_LINES[e.id];
      if (line) {
        var sub = document.createElement('span');
        sub.className = 'wc-engine-sub';
        sub.textContent = line;
        text.appendChild(sub);
      }
      b.appendChild(dot);
      b.appendChild(text);
      group.appendChild(b);
    });
    if (focusedId) {
      var back = group.querySelector('[data-id="' + focusedId + '"]');
      if (back) back.focus();
    }
  }

  function renderSearch() {
    buildEngines();
    var group = els.engines;
    if (!group || !state) return;
    markRadios(group, function (r) { return r.getAttribute('data-id') === state.engine; });
    var note = $('brave-note');
    var text = $('brave-text');
    var btn = $('brave-settings');
    if (!note || !text) return;
    if (state.engine === 'brave-api') {
      note.hidden = false;
      if (state.braveKey === true) {
        note.setAttribute('data-tone', 'ok');
        text.textContent = 'A Brave Search API key is already saved, so Quartz results are ready to use.';
        if (btn) btn.hidden = true;
      } else {
        note.setAttribute('data-tone', 'warn');
        text.textContent = 'Quartz results needs a Brave Search API key. Get one at brave.com/search/api, then paste it into Settings › Search. '
          + 'Until then, a search shows a page that says so, with plain Brave Search one click away.';
        if (btn) btn.hidden = false;
      }
    } else {
      note.hidden = true;
    }
  }

  var DEFAULT_COPY = {
    idle: {
      title: 'Quartz isn’t your default browser',
      text: 'Windows asks you to confirm this yourself. Quartz opens the right page in Windows Settings for you.'
    },
    unknown: {
      title: 'Make links open in Quartz',
      text: 'Windows asks you to confirm this yourself. Quartz opens the right page in Windows Settings for you.'
    },
    working: {
      title: 'Adding Quartz to Windows…',
      text: 'Registering Quartz as a browser, so Windows lists it. This takes a few seconds.'
    },
    'settings-opened': {
      title: 'One more step, in Windows',
      text: 'Windows only lets you change the default browser yourself, so its Settings just opened on Quartz’s page.'
    },
    registered: {
      title: 'One more step, in Windows',
      text: ''
    },
    confirmed: {
      title: 'Quartz is your default browser',
      text: 'Links from other apps open here now. You can change this any time in Windows Settings › Apps › Default apps.'
    },
    failed: {
      title: 'Windows didn’t take it',
      text: ''
    }
  };

  function renderDefault() {
    var card = $('default-card');
    if (!card || !state) return;
    var db = state.defaultBrowser || { state: 'idle' };
    var s = DEFAULT_COPY[db.state] ? db.state : 'idle';
    if (state.canDefault === false && s !== 'confirmed') s = 'failed';
    card.setAttribute('data-state', s);
    var copy = DEFAULT_COPY[s];
    $('default-title').textContent = copy.title;
    var text = copy.text;
    if (s === 'registered') {
      text = 'Quartz is in Windows’ list of browsers, but Windows Settings didn’t open'
        + (db.reason ? ' (' + db.reason + ')' : '') + '. Open Settings › Apps › Default apps › Quartz and press Set default.';
    } else if (s === 'failed') {
      text = state.canDefault === false
        ? 'This window can’t reach Windows’ default-app settings. Restart Quartz and try again.'
        : 'Quartz couldn’t add itself to Windows’ list of browsers: ' + (db.reason || 'no reason given') + '. You can try again, or skip this; nothing else depends on it.';
    }
    $('default-text').textContent = text;
    $('default-steps').hidden = s !== 'settings-opened';

    var make = els.makeDefault;
    var check = $('check-default');
    make.hidden = s === 'confirmed';
    make.disabled = s === 'working';
    make.textContent = s === 'failed' ? 'Try again'
      : (s === 'settings-opened' || s === 'registered') ? 'Open Windows Settings again'
        : s === 'working' ? 'Working…' : 'Make Quartz the default';
    make.classList.toggle('wc-primary', s === 'idle' || s === 'unknown' || s === 'failed' || s === 'working');
    make.classList.toggle('wc-ghost', s === 'settings-opened' || s === 'registered');
    if (check) check.hidden = !(s === 'settings-opened' || s === 'registered');

    var next = $('default-next');
    var acted = s === 'confirmed' || s === 'settings-opened' || s === 'registered';
    next.textContent = acted ? 'Continue' : 'Not now';
    next.classList.toggle('wc-primary', acted);
    next.classList.toggle('wc-ghost', !acted);
  }

  function renderBanner() {
    var banner = els.banner;
    if (!banner) return;
    var f = state && state.finished;
    if (f && f.ok === false) {
      banner.hidden = false;
      $('banner-text').textContent = 'Quartz couldn’t save that setup is ' + (f.how === 'skipped' ? 'skipped' : 'done')
        + ': ' + (f.reason || 'no reason given') + '. The welcome may show again next time.';
      $('banner-retry').hidden = false;
      $('banner-retry').setAttribute('data-how', f.how || 'finished');
    } else if (!answered) {
      banner.hidden = false;
      $('banner-text').textContent = 'Quartz isn’t answering this page, so choices here can’t be saved. Restart Quartz, then open Settings › About › Show welcome again.';
      $('banner-retry').hidden = true;
    } else {
      banner.hidden = true;
    }
  }

  function render() {
    if (!state) return;
    renderLook();
    renderSearch();
    renderDefault();
    renderBanner();
    document.documentElement.classList.toggle('is-reopened', !!state.reopened);
  }

  /* ---- the chrome's side ------------------------------------------------------ */

  window.__applyWelcome = function (next) {
    if (!next || typeof next !== 'object') return false;
    state = next;
    answered = true;
    if (document.readyState === 'loading') return true; // DOMContentLoaded renders it
    render();
    return true;
  };

  /* Test seam: which step, and a way to reach any step without walking. */
  window.__welcome = {
    step: function () { return STEPS[step]; },
    go: function (name) { var i = STEPS.indexOf(name); if (i >= 0) go(i); return STEPS[step]; },
    state: function () { return state; },
    answered: function () { return answered; }
  };

  /* ---- wiring ---------------------------------------------------------------- */

  function init() {
    els.progress = $('progress');
    els.skip = $('skip');
    els.looks = $('looks');
    els.engines = $('engines');
    els.makeDefault = $('make-default');
    els.banner = $('banner');
    els.announce = $('announce');

    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('[data-go]');
      if (!b) return;
      var dir = b.getAttribute('data-go');
      go(dir === 'back' ? step - 1 : step + 1);
    });

    wireRadioGroup(els.looks, function (r) {
      var mode = r.getAttribute('data-mode');
      // Wear the pick at once; the chrome's answer confirms (or puts it back).
      if (state) { state.mode = mode; renderLook(); }
      say('look', { mode: mode });
    });
    wireRadioGroup(els.engines, function (r) {
      var id = r.getAttribute('data-id');
      if (state) { state.engine = id; renderSearch(); }
      say('engine', { id: id });
    });

    $('brave-settings').addEventListener('click', function () { say('settings', { section: 'Search' }); });
    els.makeDefault.addEventListener('click', function () {
      if (state && state.defaultBrowser) state.defaultBrowser = { state: 'working', reason: '' };
      renderDefault();
      say('default', {});
    });
    $('check-default').addEventListener('click', function () { say('default-check', {}); });
    $('finish').addEventListener('click', function () { say('finish', { how: 'finished' }); });
    els.skip.addEventListener('click', function () { say('finish', { how: 'skipped' }); });
    $('banner-retry').addEventListener('click', function () {
      say('finish', { how: $('banner-retry').getAttribute('data-how') || 'finished' });
    });

    go(0);
    answered = !!state;
    if (state) render();
    say('hello', {});
    // No answer at all means an old chrome: say so rather than pretend.
    setTimeout(function () { if (!answered) renderBanner(); }, NO_ANSWER_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
