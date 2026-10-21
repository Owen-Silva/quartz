'use strict';
/*
 * drm.js -- the chrome half of "this video needs DRM Quartz does not have".
 *
 * 2026-10-14: Prime Video would not play in Quartz and played fine in
 * Edge. Stock Electron has no Widevine, so that is true of every big streaming
 * service. Until Quartz has its own Widevine (see next-week/quartz-drm.md),
 * the honest thing is to say so the moment it matters and offer the browser
 * that can play it, the way Chrome or Edge put an info bar over a page:
 *
 *   [i] Prime Video uses DRM-protected video, which Quartz can't play yet.
 *                         [Open in Edge]  Always use Edge for Prime Video   [x]
 *
 * WHEN the bar goes up (drm-sites.js has the rules and the reasons):
 *   - the tab is on a known streaming service (by address), or
 *   - the page asked for a protected key system, was refused, AND its video
 *     got encrypted media (drm-preload.js reports both). A refusal alone is a
 *     probe that YouTube, Twitch and many scripts make; it never shows a bar.
 *   - never when this build can play real services: Widevine installed AND
 *     Quartz.exe signed for streaming (drm-main.js widevine().services). The
 *     bar says WHY it cannot ("this build of Quartz has no Widevine", "this
 *     copy of Quartz isn't signed for streaming services yet", ...).
 *   - on a build WITH Widevine, when the service still refused: its licence was
 *     rejected, a key came back unusable, or no licence came (drm-preload.js
 *     'licence'). Then the bar says that, with the same Edge buttons.
 *
 * WHAT the buttons do:
 *   Open in Edge          the same URL in Microsoft Edge (main launches
 *                         msedge.exe with it); the bar then says it opened,
 *                         or exactly why it did not.
 *   Always use Edge for X stores the rule (Settings > Protected video lists
 *                         it with a remove button) and opens Edge now. From
 *                         then on a navigation to X in Quartz is stopped and
 *                         sent to Edge, and the bar says so with Turn off.
 *                         A tab RESTORED at startup is never sent anywhere:
 *                         Edge must not pop up because Quartz started.
 *   x                     hides it for this site in this tab, until the tab
 *                         leaves the site.
 *
 * The bar is the tab's note slot (tab.noteEl, see showAppNote in app.js): it
 * sits OVER the top of the tab's well, so nothing on the page moves when it
 * appears, and app.js already shows/hides it with the tab and insets it in a
 * split. Loaded BEFORE app.js; everything of app.js's it uses is looked up at
 * call time.
 */
(function () {
  var Sites = window.DrmSites;
  var api = window.api && window.api.drm;

  var st = null; // the last DrmState from main (see preload.js), or null before the first

  function extra() { return st && Array.isArray(st.extraSites) ? st.extraSites : []; }
  function wv() { return (st && st.widevine) || {}; }
  // Real services play here: the CDM is in AND Quartz.exe is signed for streaming.
  function servicesHere() { var w = wv(); return w.services === true; }
  function alwaysOn(key) {
    if (!st || !Array.isArray(st.alwaysEdge) || !key) return false;
    for (var i = 0; i < st.alwaysEdge.length; i++) if (st.alwaysEdge[i].key === key) return true;
    return false;
  }

  function liveTabs() { try { return tabs; } catch (err) { return []; } }
  function isLive(tab) { return liveTabs().indexOf(tab) !== -1; }
  function currentUrl(tab) {
    var u = '';
    try { if (tab.viewEl && typeof tab.viewEl.getURL === 'function') u = tab.viewEl.getURL(); } catch (err) { u = ''; }
    return u || tab.url || '';
  }
  function freshSeen() { return { denied: [], granted: [], encrypted: false, licence: null }; }

  /* ---- the bar ------------------------------------------------------ */

  function ourBar(tab) {
    return tab && tab.noteEl && tab.noteEl.classList && tab.noteEl.classList.contains('drm-bar') ? tab.noteEl : null;
  }

  function clearBar(tab) {
    var bar = ourBar(tab);
    if (!bar) return;
    try { bar.remove(); } catch (err) { /* detached */ }
    tab.noteEl = null;
    tab.drmBar = null;
  }

  function button(label, cls, onClick, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'drm-bar-btn ' + (cls || '');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', function (event) { event.stopPropagation(); onClick(b); });
    return b;
  }

  /**
   * Puts up (or rewrites) the bar on one tab.
   * @param {Object} tab
   * @param {Object} m { mode: 'need'|'opening'|'opened'|'sent'|'failed'|'off',
   *                     key, name, url, reason }
   */
  function render(tab, m) {
    var views = null;
    try { views = viewsEl; } catch (err) { views = null; }
    if (!tab || !views || tab.kind !== 'page') return;
    var sig = [m.mode, m.key, m.name, m.url, m.reason || '', m.outcome || ''].join('|');
    var existing = ourBar(tab);
    if (existing && tab.drmBar && tab.drmBar.sig === sig) return; // already says exactly this

    var bar = existing;
    if (!bar) {
      // One note per tab: whatever else was there gives way (it is never
      // more urgent than "this page cannot play").
      if (tab.noteEl) { try { tab.noteEl.remove(); } catch (err) { /* detached */ } tab.noteEl = null; }
      bar = document.createElement('div');
      bar.className = 'app-note drm-bar';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      var shown = true;
      try { shown = isTabOnScreen(tab); } catch (err) { shown = true; }
      bar.style.display = shown ? 'flex' : 'none';
      views.appendChild(bar);
      tab.noteEl = bar;
      try { syncSplitOverlays(); } catch (err) { /* no split support */ }
    }
    bar.textContent = '';
    bar.setAttribute('data-drm-mode', m.mode);
    bar.setAttribute('data-drm-key', m.key || '');
    tab.drmBar = { sig: sig, mode: m.mode, key: m.key, name: m.name, url: m.url };

    var icon = document.createElement('span');
    icon.className = 'drm-bar-icon glyph';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = (m.mode === 'failed' || m.mode === 'refused') ? '' : (m.mode === 'opened' || m.mode === 'sent' ? '' : '');
    bar.appendChild(icon);

    var text = document.createElement('span');
    text.className = 'drm-bar-text';
    var line = '';
    if (m.mode === 'need') line = Sites.barText(m.name, m.reason || '');
    else if (m.mode === 'refused') line = Sites.refusedText(m.name, m.outcome, m.reason || '');
    else if (m.mode === 'opening') line = 'Opening in Microsoft Edge…';
    else if (m.mode === 'opened') line = 'Opened in Microsoft Edge.';
    else if (m.mode === 'sent') line = Sites.sentText(m.name);
    else if (m.mode === 'off') line = (m.name || 'This site') + ' will open in Quartz from now on.';
    else if (m.mode === 'failed') line = 'Microsoft Edge didn’t open: ' + String(m.reason || 'no reason was given').replace(/[.\s]+$/, '') + '.';
    text.textContent = line;
    text.title = line;
    bar.appendChild(text);

    var acts = document.createElement('span');
    acts.className = 'drm-bar-acts';
    var offer = m.mode === 'need' || m.mode === 'refused';
    if (offer || m.mode === 'failed') {
      acts.appendChild(button(m.mode === 'failed' ? 'Try again' : 'Open in Edge', 'drm-bar-primary', function (b) {
        openInEdge(tab, m, false, b);
      }, 'Open this page in Microsoft Edge'));
      if (offer && m.key && !alwaysOn(m.key)) {
        var label = m.name ? 'Always use Edge for ' + m.name : 'Always use Edge for this site';
        acts.appendChild(button(label, 'drm-bar-quiet', function (b) { openInEdge(tab, m, true, b); },
          'Open ' + (m.name || 'this site') + ' in Microsoft Edge every time. You can undo this in Settings.'));
      }
      if (offer && tab.drmDesktopId) {
        acts.appendChild(button('Open the desktop app', 'drm-bar-quiet', function () {
          try { launchDesktopApp(tab.drmDesktopId); } catch (err) { /* no apps bridge */ }
        }));
      }
    } else if (m.mode === 'sent') {
      acts.appendChild(button('Turn off', 'drm-bar-quiet', function (b) { turnOff(tab, m, b); },
        'Stop opening ' + (m.name || 'this site') + ' in Microsoft Edge'));
    }
    bar.appendChild(acts);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'drm-bar-close glyph';
    close.textContent = '';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      tab.drmDismissedKey = m.key || '*';
      clearBar(tab);
    });
    bar.appendChild(close);
  }

  /* ---- actions ------------------------------------------------------ */

  function openInEdge(tab, m, always, btn) {
    if (!api) { render(tab, Object.assign({}, m, { mode: 'failed', reason: 'this window has no channel to the browser' })); return; }
    if (btn) btn.disabled = true;
    var url = m.url || currentUrl(tab);
    var step = always
      ? api.setAlways(m.key, true).then(function (r) {
        if (r && r.state) applyState(r.state);
        if (!r || !r.ok) throw new Error((r && r.reason) || 'the setting could not be saved');
      })
      : Promise.resolve();
    render(tab, Object.assign({}, m, { mode: 'opening' }));
    step.then(function () { return api.openInEdge(url); }).then(function (r) {
      if (!isLive(tab)) return;
      if (r && r.ok) render(tab, Object.assign({}, m, { url: url, mode: always ? 'sent' : 'opened' }));
      else render(tab, Object.assign({}, m, { url: url, mode: 'failed', reason: (r && r.reason) || 'no reason was given' }));
    }, function (err) {
      if (!isLive(tab)) return;
      render(tab, Object.assign({}, m, { url: url, mode: 'failed', reason: err && err.message }));
    });
  }

  function turnOff(tab, m, btn) {
    if (!api) return;
    if (btn) btn.disabled = true;
    api.setAlways(m.key, false).then(function (r) {
      if (r && r.state) applyState(r.state);
      if (!isLive(tab)) return;
      if (!r || !r.ok) {
        render(tab, Object.assign({}, m, { mode: 'failed', reason: 'the setting could not be changed: ' + ((r && r.reason) || 'no reason was given') }));
        return;
      }
      // Still on the page: the ordinary bar, so Open in Edge is one click away.
      // Stopped short of it (the usual case): say what will happen next time.
      if (Sites.ruleKeyFor(currentUrl(tab), extra()) === m.key) render(tab, Object.assign({}, m, { mode: 'need' }));
      else render(tab, Object.assign({}, m, { mode: 'off' }));
    }, function (err) {
      if (isLive(tab)) render(tab, Object.assign({}, m, { mode: 'failed', reason: err && err.message }));
    });
  }

  /* ---- deciding ----------------------------------------------------- */

  /** Re-reads one tab and puts the bar up, keeps it, or takes it down. */
  function evaluate(tab) {
    if (!tab || tab.kind !== 'page' || !Sites) return;
    var url = currentUrl(tab);
    var bar = tab.drmBar;
    var w = wv();
    var seen = tab.drmSeen || freshSeen();
    var site = Sites.siteForUrl(url, extra());
    var key = Sites.ruleKeyFor(url, extra());
    // Widevine is here and the service still refused: say so, whatever the address.
    var refused = !!(w.available && seen.licence && seen.licence.outcome);
    var need = !refused && !servicesHere() && (!!site || Sites.emeVerdict(seen).need);
    if (!refused && !need) {
      // "Sent to Edge" / "Edge didn't open" belong to the attempt, not the
      // page, and stay until the tab goes somewhere new (did-navigate).
      if (bar && tab.drmKeepSent) return;
      tab.drmDismissedKey = '';
      clearBar(tab);
      return;
    }
    if (tab.drmDismissedKey && tab.drmDismissedKey === key) return;
    // A bar that already reports an Edge attempt for this site stays as it is.
    if (bar && bar.key === key && bar.mode !== 'need' && bar.mode !== 'refused') return;
    var name = site ? site.name : '';
    render(tab, {
      mode: refused ? 'refused' : 'need', key: key, name: name, url: url,
      reason: w.short || '', outcome: refused ? seen.licence.outcome : ''
    });
  }

  function onSignal(sig) {
    if (!sig || typeof sig !== 'object') return;
    var tab = null;
    try { tab = tabForWebContentsId(sig.wcId); } catch (err) { tab = null; }
    if (!tab) return;
    var seen = tab.drmSeen || (tab.drmSeen = freshSeen());
    if (sig.kind === 'request' && typeof sig.keySystem === 'string') {
      var list = sig.granted ? seen.granted : seen.denied;
      if (list.indexOf(sig.keySystem) === -1 && list.length < 8) list.push(sig.keySystem);
    } else if (sig.kind === 'encrypted') {
      seen.encrypted = true;
    } else if (sig.kind === 'licence' && Sites.isLicenceOutcome(sig.outcome)) {
      // The first refusal says the most; a later one never replaces it.
      if (!seen.licence) seen.licence = { outcome: sig.outcome, detail: String(sig.detail || '').slice(0, 80) };
    } else {
      return;
    }
    evaluate(tab);
  }

  /**
   * app.js calls this once per guest element (wireViewEvents). The listeners
   * are added after app.js's own, so tab.url is already the new address.
   */
  function attach(tab, viewEl, stale) {
    if (!tab || !viewEl || !Sites) return;
    var gone = function () { return (typeof stale === 'function' && stale()) || !isLive(tab); };
    // A tab built while the session is being restored loads its page without
    // anyone asking for it right now; it must never launch Edge on startup.
    var r = false;
    try { r = !!restoring; } catch (err) { r = false; }
    tab.drmRestoredLoad = r;

    viewEl.addEventListener('did-start-navigation', function (event) {
      if (gone() || !event || !event.isMainFrame || event.isInPlace) return;
      var url = String(event.url || '');
      var key = Sites.ruleKeyFor(url, extra());
      // The person's own rule wins even on a build that can play: they chose Edge.
      if (!key || !alwaysOn(key)) return;
      if (tab.drmRestoredLoad) return; // the bar will offer Edge instead
      if (tab.drmAllowOnce && tab.drmAllowOnce === url) { tab.drmAllowOnce = ''; return; }
      try { viewEl.stop(); } catch (err) { /* already stopped */ }
      var site = Sites.siteForUrl(url, extra());
      var m = { mode: 'need', key: key, name: site ? site.name : Sites.ruleKeyName(key, extra()), url: url, reason: '' };
      tab.drmKeepSent = true;
      render(tab, Object.assign({}, m, { mode: 'opening' }));
      if (!api) { render(tab, Object.assign({}, m, { mode: 'failed', reason: 'this window has no channel to the browser' })); return; }
      api.openInEdge(url).then(function (res) {
        if (!isLive(tab)) return;
        if (res && res.ok) render(tab, Object.assign({}, m, { mode: 'sent' }));
        else render(tab, Object.assign({}, m, { mode: 'failed', reason: (res && res.reason) || 'no reason was given' }));
      }, function (err) {
        if (isLive(tab)) render(tab, Object.assign({}, m, { mode: 'failed', reason: err && err.message }));
      });
    });

    viewEl.addEventListener('did-navigate', function () {
      if (gone()) return;
      tab.drmSeen = freshSeen();     // a new document: its own EME story
      tab.drmRestoredLoad = false;   // only the first load after a restore
      tab.drmKeepSent = false;
      var bar = tab.drmBar;
      // A new address: an old Edge attempt's message no longer applies.
      if (bar && bar.mode !== 'need' && bar.key !== Sites.ruleKeyFor(currentUrl(tab), extra())) clearBar(tab);
      evaluate(tab);
    });
    viewEl.addEventListener('did-navigate-in-page', function (event) {
      if (gone() || (event && event.isMainFrame === false)) return;
      evaluate(tab); // a single-page app moving onto (or off) its video pages
    });
  }

  /**
   * app.js's syncAppNote hands a catalogue app tab with drm:true here, with
   * the installed desktop twin's id when there is one ('' when not).
   */
  function syncAppTab(tab, desktopId) {
    if (!tab) return;
    tab.drmDesktopId = desktopId || '';
    if (tab.drmBar) tab.drmBar.sig = ''; // re-render: the desktop button may have arrived
    evaluate(tab);
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    st = next;
    liveTabs().forEach(function (t) { if (t.kind === 'page') evaluate(t); });
    // Settings > Protected video redraws from this.
    try { document.dispatchEvent(new CustomEvent('drmchange')); } catch (err) { /* no listeners */ }
  }

  if (api) {
    api.onSignal(onSignal);
    api.onChanged(applyState);
    api.state().then(applyState, function () { /* main not ready: the first push brings it */ });
  }

  window.Drm = {
    attach: attach,
    evaluate: evaluate,
    syncAppTab: syncAppTab,
    state: function () { return st; },
    refresh: function () { return api ? api.state().then(function (s) { applyState(s); return s; }) : Promise.resolve(null); },
    // test seam: what one tab has seen and shows
    _tab: function (tab) {
      if (!tab) return null;
      var bar = ourBar(tab);
      return {
        seen: tab.drmSeen || freshSeen(),
        bar: bar ? { mode: bar.getAttribute('data-drm-mode'), key: bar.getAttribute('data-drm-key'), text: (bar.querySelector('.drm-bar-text') || {}).textContent || '', buttons: Array.prototype.map.call(bar.querySelectorAll('.drm-bar-btn'), function (b) { return b.textContent; }), display: bar.style.display } : null,
        restored: !!tab.drmRestoredLoad
      };
    }
  };
})();
