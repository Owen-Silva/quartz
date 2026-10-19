'use strict';

/*
 * notes-pane.js — the notes pane: a split pane beside the tab well that shows
 * one note from the configured notes folder, the subject chips (one per notes
 * file), and the auto-jump to the section the question on screen belongs to.
 *
 * HOST. app.js owns <aside id="sidepane"> (index.html): it shows and sizes it
 * for the current workspace's pane kind, sets #sidepane.dataset.kind, and
 * dispatches `sidepane` on document with detail { kind, open, width } on every
 * change (and once after init); window.sidePane = { kind(), isOpen(), width() }.
 * This file fills #sidepane-body while kind === 'notes' and empties it
 * otherwise. Owns every .notes-* class and everything inside #sidepane-body.
 * The one thing it says about the host itself is a min-width floor in
 * notes-pane.css, and only while the notes pane is up: notes can carry
 * fixed-width cards that cannot reflow under ~305px of page width. The width,
 * the drag handle and the real clamp stay app.js's.
 *
 * CONFIG. Main reads <userData>\notes-pane.json; Settings > Notes pane picks
 * its folder. state.configured is false while no folder is set (or the folder
 * is missing): app.js then never shows the pane at all, and if a harness forces
 * it up anyway the pane says plainly that it is off and why. state.dir is the
 * folder, and every note URL is built from it (fileUrl below). The reader app
 * (the program that shows the questions) is optional on top of that: with
 * state.reader.configured false its policy button is hidden, the strip says no
 * reader app is set, and picking a subject by hand keeps working.
 *
 * DATA. window.api.notes.describe() / command(name, arg) / onUpdate(cb) — the
 * state shape is documented in notes-pane-main.js. Every state and reason
 * string main reports is shown in the pane: nothing here fails silently.
 *
 * THE THREE THINGS THIS FILE HAS TO GET RIGHT
 *  1. It must be harmless before its host exists. The pane HOST (app.js) and the
 *     brain (notes-pane-main.js) were built in parallel with this file, so every
 *     reach for them is guarded: no host -> stay dormant, no api.notes -> say so
 *     in the pane rather than throw. A scaffold state (ready:false) is not an
 *     error, it is a state, and it renders as one.
 *  2. Nothing fails quietly. Every command answer, every refused jump, every
 *     fallback (iframe instead of <webview>, a missing "Open in a tab") writes
 *     plain words into the pane, next to the control it belongs to AND in the
 *     status strip. A console line does not count. The strip is compact — one
 *     row per status — but never at the cost of a reason: a FAILURE row is
 *     never clamped, a clamped row carries its whole text as its tooltip, and
 *     "Show all" appears the moment any row is actually cut short (checkClip).
 *  3. The notes view is reloaded only when the SUBJECT changes. State pushes
 *     land every few seconds; re-setting src would restart a 300KB page each
 *     time and throw away the reader's scroll position.
 */

(function () {
  // ---------------------------------------------------------------- constants

  /** A refused command's reason stays next to its control this long. */
  const REASON_MS = 6000;

  /** A jump the guest refused ("you are scrolling") is retried this often. */
  const JUMP_RETRY_MS = 700;

  // ------------------------------------------------------------------- state

  /** The last state we painted. window.NotesPane.state() hands this back. */
  let last = null;

  /** Live element handles, rebuilt by build(). Null while unmounted. */
  let els = null;

  /** onUpdate's unsubscribe, kept so unmount() can stop the push feed. */
  let stopUpdates = null;

  /**
   * Which note the view currently holds: the subject id plus its URL (noteKey),
   * so we reload only on change. The URL is part of it because the folder can
   * change under the same subject id (Settings > Notes pane > Change folder).
   */
  let notesId = null;

  /** 'webview' | 'iframe' | null — which element the notes are in right now. */
  let viewKind = null;

  /** dom-ready has fired for the current notes document. */
  let viewReady = false;

  /** Why we are on the iframe fallback, in plain words (''  = not on it). */
  let viewFallbackReason = '';

  /** hash|sectionId|classId of the last jump we asked for: never repeat one. */
  let lastJumpKey = '';

  /** setTimeout handle for the "you were scrolling, try again" retry. */
  let jumpRetry = 0;

  /** Text under the notes bar: what the deep link last did. */
  let jumpNote = '';

  /** Timers for the inline command reasons, keyed by control name. */
  const reasonTimers = new Map();

  /** localStorage key for "the strip prints every row in full". */
  const STRIP_FULL_KEY = 'notes-pane.strip-full';

  /** true: every status row in full; false: one row each, with "Show all". */
  let stripFull = readStripFull();

  /** Watches the strip's size so a pane resize re-checks the cut-short rows. */
  let stripObserver = null;

  /** setTimeout handle for the pending cut-short check (0 = none). */
  let clipFrame = 0;

  // ------------------------------------------------------------------ helpers

  const $ = (sel, root) => (root || document).querySelector(sel);

  /** The side pane shell app.js owns. Absent until that lane lands. */
  function paneEl() { return document.getElementById('sidepane'); }
  function bodyEl() { return document.getElementById('sidepane-body'); }

  /**
   * Should the pane be filled right now? Three sources, in order of freshness:
   * the detail of the `sidepane` event we just heard, window.sidePane (the host's
   * accessor), and finally #sidepane's own data-kind — which is what a harness
   * sets when it forces the host state by hand. `open` defaults to true: a host
   * that reports a kind without an open flag is showing it.
   */
  function showing(detail) {
    if (detail && typeof detail === 'object') {
      return detail.kind === 'notes' && detail.open !== false;
    }
    const host = window.sidePane;
    if (host && typeof host.kind === 'function') {
      const open = typeof host.isOpen === 'function' ? host.isOpen() : true;
      return host.kind() === 'notes' && open !== false;
    }
    const pane = paneEl();
    if (pane && pane.dataset && pane.dataset.kind) {
      return pane.dataset.kind === 'notes' && !pane.hidden;
    }
    return false;
  }

  /** window.api.notes, or null while preload/main have not wired it. */
  function bridge() {
    const api = window.api;
    return api && api.notes && typeof api.notes.describe === 'function' ? api.notes : null;
  }

  const text = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

  const show = (el, on) => { if (el && el.hidden === !!on) el.hidden = !on; };

  function klass(el, name, on) {
    if (el && el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
  }

  /** '' for null/undefined, trimmed, so a missing reason never prints "undefined". */
  function reasonOf(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * The reader app is the program that shows the questions (notes-pane.json
   * names it; main reports it as state.reader). Two questions are asked of it:
   *   readerOn  — main says one IS configured (reader.configured === true).
   *               Strict on purpose: the debug-port policy button writes a
   *               machine policy, so it never appears on a guess.
   *   readerOff — main says plainly that NONE is configured (=== false). Only
   *               then does the strip and the Auto chip say so; a state with no
   *               word either way (the no-bridge fallbacks below) keeps the
   *               wording it always had.
   */
  function readerOn(state) {
    return !!(state && state.reader && state.reader.configured === true);
  }
  function readerOff(state) {
    return !!(state && state.reader && state.reader.configured === false);
  }

  /** The reader app's name for a label: its exe name without ".exe". */
  function readerName(state) {
    const app = state && state.reader && typeof state.reader.app === 'string' ? state.reader.app.trim() : '';
    return app ? app.replace(/\.exe$/i, '') : 'the reader app';
  }

  /** "Reader: CDP" + " · connected to <the reader app>" only when there IS a reason. */
  function withReason(head, reason) {
    const why = reasonOf(reason);
    if (!why) return head;
    // main sometimes sends reason 'idle' beside state 'idle'; "Helper: idle \u00b7
    // idle" is noise, not information. Anything that adds something is kept.
    const tail = head.slice(head.indexOf(':') + 1).replace(/\u2026/g, '').trim().toLowerCase();
    if (why.toLowerCase() === tail) return head;
    // Likewise a reason that OPENS with the state ("idle \u00b7 last 3.6 s \u00b7 \u2026"
    // beside state 'idle'): say the state once, keep every word after it.
    if (tail && why.toLowerCase().startsWith(tail + ' \u00b7 ')) return head + ' \u00b7 ' + why.slice(tail.length + 3);
    return head + ' \u00b7 ' + why;
  }

  /**
   * The notes folder from the last state (state.dir, an absolute path main
   * validated), with forward slashes and one trailing slash, ready to have a
   * bare file name glued on: 'C:\Users\you\Documents\notes' ->
   * 'C:/Users/you/Documents/notes/'. '' while no folder is configured; no
   * subject rows exist then, so nothing below ever needs it.
   */
  function notesBase() {
    const dir = last && typeof last.dir === 'string' ? last.dir.trim() : '';
    if (!dir) return '';
    const fwd = dir.replace(/\\/g, '/');
    return fwd.endsWith('/') ? fwd : fwd + '/';
  }

  /**
   * A subject row's notes file as a URL the guest can load. Main hands us a bare
   * file name inside state.dir, but a Windows path, a posix path or a file://
   * URL work too; an empty `file` falls back to the id, which is how the files
   * are actually named on disk.
   */
  function fileUrl(subj) {
    const raw = subj && typeof subj.file === 'string' ? subj.file.trim() : '';
    const base = notesBase();
    let path = raw;
    if (/^file:\/\//i.test(raw)) return raw;
    if (!path) path = base + String(subj && subj.id ? subj.id : '') + '.html';
    path = path.replace(/\\/g, '/');
    if (!/^[a-zA-Z]:\//.test(path) && !path.startsWith('/')) path = base + path;
    // Percent-encode the few characters that would otherwise end the path or
    // start a fragment. encodeURI would also mangle an already-encoded path.
    return 'file:///' + path.replace(/^\//, '').replace(/[#?%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  /** What notesId holds for a subject: its id and the URL it loads from. */
  function noteKey(subj) {
    return subj ? String(subj.id) + '|' + fileUrl(subj) : null;
  }

  // --------------------------------------------------------- the guest script

  /*
   * Injected once per notes document, into the <webview> only. It owns two
   * things the chrome cannot see from out here: the guest's own scroll events
   * (so we can tell OUR scroll from the user's) and the highlight.
   *
   * __notesJump(id) answers with a word, and every word becomes a visible line
   * under the notes bar: 'jumped', 'busy' (he is scrolling — we retry), or
   * 'missing' (that section id is not in this file).
   */
  const GUEST_SCRIPT = `(function () {
    if (window.__notesJump) return 'ready';
    var lastUserScroll = 0;
    var suppressUntil = 0;
    var clear = 0;
    var marked = null;
    window.addEventListener('scroll', function () {
      // Our own scrollIntoView fires this too; the suppression window is what
      // keeps a programmatic jump from counting as "the user is scrolling".
      if (Date.now() < suppressUntil) return;
      lastUserScroll = Date.now();
    }, { passive: true });
    var style = document.createElement('style');
    style.textContent =
      '.__notes-hit{outline:2px solid rgba(114,173,202,.95);outline-offset:6px;border-radius:6px}' +
      '.__notes-hit-soft{outline:2px solid rgba(114,173,202,.45);outline-offset:6px;border-radius:6px}';
    (document.head || document.documentElement).appendChild(style);
    window.__notesJump = function (id) {
      var el = document.getElementById(id);
      if (!el) return 'missing';
      // Never yank the page out from under a hand that is on the scrollbar.
      if (Date.now() - lastUserScroll < 2000) return 'busy';
      suppressUntil = Date.now() + 1500;
      try { el.scrollIntoView({ block: 'start' }); } catch (e) { el.scrollIntoView(); }
      if (marked) { marked.classList.remove('__notes-hit', '__notes-hit-soft'); }
      if (clear) { clearTimeout(clear); clear = 0; }
      marked = el;
      el.classList.add('__notes-hit');
      // Stepped, not eased: full for 750ms, half for 750ms, then gone.
      clear = setTimeout(function () {
        el.classList.remove('__notes-hit');
        el.classList.add('__notes-hit-soft');
        clear = setTimeout(function () {
          el.classList.remove('__notes-hit-soft');
          if (marked === el) marked = null;
          clear = 0;
        }, 750);
      }, 750);
      return 'jumped';
    };
    return 'ready';
  })()`;

  // ------------------------------------------------------------------ the DOM

  /**
   * Builds the pane once. Everything after this is text and class updates, so a
   * push every second costs a handful of property writes and no layout thrash.
   */
  function build() {
    const body = bodyEl();
    if (!body) return false;
    body.textContent = '';

    const root = document.createElement('div');
    root.className = 'notes-pane';
    root.innerHTML = [
      // ready:false, a missing bridge, or no notes folder (configured:false):
      // the loudest thing in the pane.
      '<div class="notes-alert" hidden></div>',

      '<div class="notes-head">',
      '  <div class="notes-chips" role="group" aria-label="Subject"></div>',
      '  <div class="notes-why" hidden></div>',
      '</div>',

      '<div class="notes-strip">',
      '  <div class="notes-line" data-line="reader"><span class="notes-pip"></span><span class="notes-text"></span></div>',
      '  <div class="notes-line" data-line="helper"><span class="notes-pip"></span><span class="notes-text"></span></div>',
      '  <div class="notes-line" data-line="match"><span class="notes-pip"></span><span class="notes-text"></span></div>',
      '  <div class="notes-controls">',
      '    <span class="notes-ctl"><button type="button" class="notes-btn" data-cmd="set-helper"></button><span class="notes-inline" data-for="set-helper" hidden></span></span>',
      '    <span class="notes-ctl"><button type="button" class="notes-btn" data-cmd="pin"></button><span class="notes-inline" data-for="pin" hidden></span></span>',
      '    <span class="notes-ctl"><button type="button" class="notes-btn" data-cmd="probe">Retry</button><span class="notes-inline" data-for="probe" hidden></span></span>',
      '    <span class="notes-ctl" data-wrap="install-policy" hidden><button type="button" class="notes-btn" data-cmd="install-policy">Install debug-port policy</button><span class="notes-inline" data-for="install-policy" hidden></span></span>',
      '    <span class="notes-toggles">',
      '      <button type="button" class="notes-toggle" data-toggle="full" aria-expanded="false" hidden>Show all</button>',
      '      <button type="button" class="notes-toggle" data-toggle="ask" aria-expanded="false" aria-controls="notes-ask">Paste a question</button>',
      '    </span>',
      '  </div>',
      '  <div class="notes-note" data-note="policy" hidden></div>',
      '  <div class="notes-ask" id="notes-ask" hidden>',
      '    <textarea class="notes-ask-text" rows="3" spellcheck="false" placeholder="Paste a question here to match it without the reader app"></textarea>',
      '    <div class="notes-ask-row">',
      '      <button type="button" class="notes-btn" data-cmd="ask">Ask</button>',
      '      <span class="notes-inline" data-for="ask" hidden></span>',
      '    </div>',
      '  </div>',
      '</div>',

      '<div class="notes-doc">',
      '  <div class="notes-doc-bar">',
      '    <span class="notes-doc-title"></span>',
      '    <button type="button" class="notes-btn notes-open">Open in a tab</button>',
      '  </div>',
      '  <div class="notes-doc-note" hidden></div>',
      '  <div class="notes-view"></div>',
      '  <div class="notes-empty" hidden></div>',
      '</div>'
    ].join('\n');

    body.appendChild(root);

    els = {
      root,
      alert: $('.notes-alert', root),
      chips: $('.notes-chips', root),
      why: $('.notes-why', root),
      strip: $('.notes-strip', root),
      reader: $('[data-line="reader"] .notes-text', root),
      readerRow: $('[data-line="reader"]', root),
      helper: $('[data-line="helper"] .notes-text', root),
      helperRow: $('[data-line="helper"]', root),
      match: $('[data-line="match"] .notes-text', root),
      matchRow: $('[data-line="match"]', root),
      helperBtn: $('[data-cmd="set-helper"]', root),
      pinBtn: $('[data-cmd="pin"]', root),
      probeBtn: $('[data-cmd="probe"]', root),
      policyWrap: $('[data-wrap="install-policy"]', root),
      policyNote: $('[data-note="policy"]', root),
      fullToggle: $('[data-toggle="full"]', root),
      askToggle: $('[data-toggle="ask"]', root),
      ask: $('.notes-ask', root),
      askText: $('.notes-ask-text', root),
      notes: $('.notes-doc', root),
      notesTitle: $('.notes-doc-title', root),
      notesNote: $('.notes-doc-note', root),
      view: $('.notes-view', root),
      empty: $('.notes-empty', root),
      openBtn: $('.notes-open', root),
      chipFor: new Map(),
      chipIds: ''
    };

    root.addEventListener('click', onClick);
    els.askText.addEventListener('keydown', (e) => {
      // Ctrl+Enter sends, so the textarea can still hold a multi-line question.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAsk(); }
    });

    klass(els.strip, 'is-full', stripFull);
    // A narrower pane cuts rows short that fitted a moment ago, and a wider one
    // un-cuts them: re-check on every size change, not only on a state push.
    if (stripObserver) { stripObserver.disconnect(); stripObserver = null; } // a rebuild, not a mount
    if (typeof ResizeObserver === 'function') {
      stripObserver = new ResizeObserver(() => scheduleClipCheck());
      stripObserver.observe(els.strip);
    }
    return true;
  }

  // ----------------------------------------------------- the compact strip

  /**
   * Whether the strip prints every status row in full (true) or one row each.
   * The user's own choice, remembered per profile. Storage can be blocked; then the
   * choice lasts this run, and the strip starts compact next time.
   */
  function readStripFull() {
    try { return window.localStorage.getItem(STRIP_FULL_KEY) === '1'; } catch (err) { return false; }
  }

  function setStripFull(on) {
    stripFull = !!on;
    try { window.localStorage.setItem(STRIP_FULL_KEY, stripFull ? '1' : '0'); } catch (err) { /* see readStripFull */ }
    if (!els) return;
    klass(els.strip, 'is-full', stripFull);
    scheduleClipCheck();
  }

  function setAskOpen(open) {
    if (!els) return;
    show(els.ask, open);
    els.askToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    els.askToggle.title = open ? 'Hide the question box' : 'Match a pasted question without the reader app';
    if (open) { try { els.askText.focus(); } catch (err) { /* a detached pane has nothing to focus */ } }
  }

  /**
   * One measurement per task, however many pushes and resizes asked for it. A
   * timer, not requestAnimationFrame: an occluded window runs no frames at all
   * (seen on a test instance sent to the back, 2026-09-14), and the check must
   * not wait for someone to look before the tooltips and "Show all" are right.
   */
  function scheduleClipCheck() {
    if (clipFrame || !els) return;
    clipFrame = setTimeout(checkClip, 0);
  }

  /**
   * The compact strip must never cut a row short without saying so. Every row's
   * whole text is its tooltip, and "Show all" appears exactly when a row IS cut
   * short (its text is wider than its box); once expanded, "Show less" appears
   * when a row actually wraps. A failure row is never clamped (CSS), so it is
   * left out of both checks.
   */
  function checkClip() {
    clipFrame = 0;
    if (!els || !els.root.isConnected) return;
    let cut = false;
    let wraps = false;
    for (const row of [els.readerRow, els.helperRow, els.matchRow]) {
      const t = row.querySelector('.notes-text');
      if (!t) continue;
      const whole = t.textContent || '';
      if (t.title !== whole) t.title = whole;
      if (row.dataset.level === 'bad') continue;
      if (stripFull) {
        const lh = parseFloat(getComputedStyle(t).lineHeight) || 16;
        if (t.offsetHeight > lh * 1.5) wraps = true;
      } else if (t.scrollWidth > t.clientWidth + 1) {
        cut = true;
      }
    }
    const need = stripFull ? wraps : cut;
    show(els.fullToggle, need);
    text(els.fullToggle, stripFull ? 'Show less' : 'Show all');
    els.fullToggle.setAttribute('aria-expanded', stripFull ? 'true' : 'false');
    els.fullToggle.title = stripFull
      ? 'Back to one row per status'
      : 'A status row is cut short: show every row in full';
  }

  // ----------------------------------------------------------------- commands

  /**
   * Every command goes through here so that every answer — refused, thrown, or
   * simply absent — ends up in front of the user. `where` names the control the
   * reason belongs next to.
   */
  async function run(name, arg, where) {
    const api = bridge();
    if (!api || typeof api.command !== 'function') {
      showReason(where, 'the browser has no notes bridge (window.api.notes)');
      return;
    }
    showReason(where, '\u2026', 0);
    let answer;
    try {
      answer = await api.command(name, arg);
    } catch (err) {
      showReason(where, 'the browser did not answer: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    if (!answer) {
      showReason(where, 'no answer came back from "' + name + '"');
      return;
    }
    if (answer.ok === false) {
      showReason(where, reasonOf(answer.reason) || 'refused, with no reason given');
      return;
    }
    clearReason(where);
    // A state push normally follows; ask for one anyway so a main that forgot
    // to push still leaves the pane telling the truth.
    refresh();
  }

  /**
   * Shows a refused command's words next to its control AND in the status strip,
   * for ~6 s. ms = 0 keeps it up (used for the "…" while the call is in flight).
   */
  function showReason(where, why, ms) {
    if (!els) return;
    const slot = els.root.querySelector('.notes-inline[data-for="' + where + '"]');
    if (slot) {
      text(slot, why);
      show(slot, true);
    }
    if (why !== '\u2026') {
      // The strip is the one place that always carries the last thing that went
      // wrong, even after the inline note has timed out.
      setStripReason(where + ': ' + why);
    }
    const old = reasonTimers.get(where);
    if (old) clearTimeout(old);
    if (ms !== 0) {
      reasonTimers.set(where, setTimeout(() => clearReason(where), ms || REASON_MS));
    }
  }

  function clearReason(where) {
    const old = reasonTimers.get(where);
    if (old) { clearTimeout(old); reasonTimers.delete(where); }
    if (!els) return;
    const slot = els.root.querySelector('.notes-inline[data-for="' + where + '"]');
    if (slot) { text(slot, ''); show(slot, false); }
  }

  /** The strip's own line for the last refusal. Cleared on the next good push. */
  let stripReason = '';
  function setStripReason(s) {
    stripReason = s;
    paintStripReason();
  }
  function paintStripReason() {
    if (!els) return;
    let row = els.root.querySelector('.notes-refusal');
    if (!stripReason) { if (row) row.remove(); return; }
    if (!row) {
      row = document.createElement('div');
      row.className = 'notes-refusal';
      els.strip.appendChild(row);
    }
    text(row, stripReason);
  }

  function sendAsk() {
    const value = els && els.askText ? els.askText.value.trim() : '';
    if (!value) { showReason('ask', 'type or paste a question first'); return; }
    run('ask', { text: value }, 'ask');
  }

  function onClick(e) {
    const toggle = e.target.closest ? e.target.closest('.notes-toggle[data-toggle]') : null;
    if (toggle && els.root.contains(toggle)) {
      if (toggle.dataset.toggle === 'full') setStripFull(!stripFull);
      else if (toggle.dataset.toggle === 'ask') setAskOpen(els.ask.hidden);
      return;
    }
    const chip = e.target.closest ? e.target.closest('.notes-chip') : null;
    if (chip && els.root.contains(chip)) {
      const id = chip.dataset.id ? chip.dataset.id : null;
      run('set-subject', { id }, 'set-subject');
      return;
    }
    const open = e.target.closest ? e.target.closest('.notes-open') : null;
    if (open) { openInTab(); return; }
    const btn = e.target.closest ? e.target.closest('.notes-btn[data-cmd]') : null;
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (cmd === 'set-helper') {
      const on = !(last && last.helper && last.helper.enabled);
      run('set-helper', { on }, 'set-helper');
    } else if (cmd === 'pin') {
      const on = !(last && last.pinned);
      run('pin', { on }, 'pin');
    } else if (cmd === 'probe') {
      run('probe', null, 'probe');
    } else if (cmd === 'install-policy') {
      run('install-policy', null, 'install-policy');
    } else if (cmd === 'ask') {
      sendAsk();
    }
  }

  /**
   * app.js does not export a way to open a tab yet (reader.js and bookmarks.js
   * both guard for the same thing), so this button says why it cannot rather
   * than doing nothing when pressed.
   */
  function openInTab() {
    const subj = currentSubject(last);
    if (!subj) { showReason('open', 'there is no subject to open'); return; }
    if (typeof window.createTab !== 'function') {
      showReason('open', 'this build has no way to open a tab from the pane yet');
      return;
    }
    window.createTab(fileUrl(subj), { background: false });
  }

  // -------------------------------------------------------------- notes view

  function currentSubject(state) {
    if (!state || !Array.isArray(state.subjects) || !state.subjects.length) return null;
    const want = state.subject ? state.subject.id : null;
    if (want) {
      const hit = state.subjects.find((c) => c && c.id === want);
      if (hit) return hit;
    }
    return state.subjects[0];
  }

  /**
   * Tears the current guest down, whichever kind it is.
   *
   * Taking a live <webview> out of the document raises one "Invalid
   * guestInstanceId: N" in the console, from Electron, not from here. closeTab()
   * in app.js (~7400) carries the full write-up: the guest's registry entry is
   * already gone by the time the element's queued disconnectedCallback sends its
   * detach, no sequence on this side avoids it, and it cannot be caught either —
   * it is thrown inside Electron's own custom-element reaction, so the try below
   * only covers an ordinary DOM failure. It leaves nothing behind. Every tab
   * close in this browser does the same thing; the fix belongs upstream.
   *
   * What we CAN do is remove the element as rarely as possible, and the normal
   * path does: a subject change navigates the guest we already have (loadNotes),
   * so this runs only when the pane closes or the subject list empties.
   */
  function dropView() {
    if (!els) return;
    try { els.view.textContent = ''; } catch (err) { /* see above */ }
    viewKind = null;
    viewReady = false;
    notesId = null;
    if (jumpRetry) { clearTimeout(jumpRetry); jumpRetry = 0; }
  }

  /**
   * Loads a subject's notes. Called only when the subject (or its URL)
   * changes, so a state push every second never restarts a 300KB page.
   *
   * A subject change NAVIGATES the guest we already have rather than building a
   * new one: it is cheaper, it keeps the element's listeners, and it is the
   * only way to switch subjects without risking the attach/detach race above.
   */
  function loadNotes(subj) {
    if (!els || !subj) return;
    notesId = noteKey(subj);
    lastJumpKey = '';
    jumpNote = '';
    viewReady = false;
    if (jumpRetry) { clearTimeout(jumpRetry); jumpRetry = 0; }

    const url = fileUrl(subj);
    const existing = els.view.firstElementChild;
    if (existing && viewKind) {
      // Reuse. The iframe fallback stays the fallback: once file:// was refused
      // for one subject it will be refused for the next, and the pane keeps
      // saying so rather than silently flipping back.
      existing.setAttribute('src', url);
      paintNotesNote();
      return;
    }

    viewFallbackReason = '';
    const view = document.createElement('webview');
    view.className = 'notes-guest';
    view.setAttribute('src', url);
    viewKind = 'webview';

    view.addEventListener('dom-ready', () => {
      viewReady = true;
      // Injected once per DOCUMENT: a subject switch navigates this same element,
      // so dom-ready fires again and the new page gets its own copy.
      let pending;
      try {
        pending = view.executeJavaScript(GUEST_SCRIPT, false);
      } catch (err) {
        setJumpNote('the deep link is off: ' + (err && err.message ? err.message : String(err)));
        return;
      }
      pending.then(() => {
        setJumpNote('');
        maybeJump(last);
      }).catch((err) => {
        setJumpNote('the deep link is off: the notes page refused the helper script (' +
          (err && err.message ? err.message : String(err)) + ')');
      });
    });

    view.addEventListener('did-fail-load', (e) => {
      // -3 is ABORTED, which a same-document navigation reports; it is not a
      // failure worth swapping the whole view for.
      if (e && (e.errorCode === -3 || (e.isMainFrame === false))) return;
      const why = 'error ' + (e && e.errorCode) + (e && e.errorDescription ? ' ' + e.errorDescription : '');
      useIframe(subj, 'the <webview> would not load the file (' + why + ')');
    });

    els.view.appendChild(view);
    paintNotesNote();
  }

  /**
   * Fallback: a plain sandboxed iframe. It CAN show the notes, but a file://
   * document is an opaque origin from here, so we cannot inject anything into
   * it — the deep link becomes a plain #anchor load, with no highlight. That
   * loss is printed in the pane, not swallowed.
   */
  function useIframe(subj, why) {
    if (!els) return;
    try { els.view.textContent = ''; } catch (err) { /* see dropView */ }
    viewKind = 'iframe';
    viewReady = false;
    viewFallbackReason = why;
    const frame = document.createElement('iframe');
    frame.className = 'notes-guest';
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = fileUrl(subj);
    frame.addEventListener('load', () => { viewReady = true; maybeJump(last); });
    els.view.appendChild(frame);
    paintNotesNote();
  }

  function setJumpNote(s) {
    if (jumpNote === s) return;
    jumpNote = s;
    paintNotesNote();
  }

  function paintNotesNote() {
    if (!els) return;
    const bits = [];
    if (viewFallbackReason) {
      bits.push('Showing the notes in a plain frame instead \u00b7 ' + viewFallbackReason +
        '. The jump still scrolls, but cannot highlight.');
    }
    if (jumpNote) bits.push(jumpNote);
    const s = bits.join(' ');
    text(els.notesNote, s);
    show(els.notesNote, !!s);
  }

  /**
   * The deep link. Runs on every push, but only actually jumps when the match's
   * hash+section is one we have not jumped to in this document.
   */
  function maybeJump(state) {
    if (!els || !state) return;
    if (state.pinned) { return; }
    const match = state.match;
    if (!match || !match.sectionId) return;
    if (!viewKind || !viewReady) return;
    const key = String(match.hash || '') + '|' + match.sectionId + '|' + notesId;
    if (key === lastJumpKey) return;
    lastJumpKey = key;
    doJump(match.sectionId, key);
  }

  function doJump(sectionId, key) {
    if (jumpRetry) { clearTimeout(jumpRetry); jumpRetry = 0; }
    const view = els && els.view.firstElementChild;
    if (!view) return;
    if (viewKind === 'iframe') {
      // No injection possible across a file:// opaque origin: an anchor load is
      // the whole of what a plain frame can do.
      try {
        const base = String(view.src).split('#')[0];
        view.src = base + '#' + sectionId;
        setJumpNote('Jumped to "' + sectionId + '" (no highlight in the plain frame).');
      } catch (err) {
        setJumpNote('could not jump: ' + (err && err.message ? err.message : String(err)));
      }
      return;
    }
    let pending;
    try {
      pending = view.executeJavaScript('window.__notesJump && window.__notesJump(' + JSON.stringify(String(sectionId)) + ')', false);
    } catch (err) {
      setJumpNote('could not reach the notes page to jump: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    pending
      .then((answer) => {
        if (answer === 'jumped') {
          setJumpNote('');
        } else if (answer === 'busy') {
          setJumpNote('Waiting to jump to "' + sectionId + '" \u2014 you are scrolling.');
          // Retry the SAME section until the page has been still for 2 s. A new
          // match overwrites lastJumpKey and this retry stands itself down.
          jumpRetry = setTimeout(() => {
            jumpRetry = 0;
            if (lastJumpKey === key) doJump(sectionId, key);
          }, JUMP_RETRY_MS);
        } else if (answer === 'missing') {
          setJumpNote('"' + sectionId + '" is not a section in this notes file.');
        } else {
          setJumpNote('the notes page did not answer the jump (' + String(answer) + ').');
        }
      })
      .catch((err) => {
        setJumpNote('could not reach the notes page to jump: ' +
          (err && err.message ? err.message : String(err)));
      });
  }

  // -------------------------------------------------------------- the render

  /** Subject chips + the Auto chip. Rebuilt only when the subject LIST changes. */
  function paintChips(state) {
    const subjects = Array.isArray(state.subjects) ? state.subjects.filter(Boolean) : [];
    const ids = subjects.map((c) => c.id + ':' + (c.name || '')).join('|');
    if (ids !== els.chipIds) {
      els.chipIds = ids;
      els.chips.textContent = '';
      els.chipFor.clear();
      for (const subj of subjects) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'notes-chip';
        b.dataset.id = subj.id;
        b.textContent = subj.name || subj.id;
        b.title = 'Show ' + (subj.name || subj.id) + "'s notes";
        els.chips.appendChild(b);
        els.chipFor.set(subj.id, b);
      }
      const auto = document.createElement('button');
      auto.type = 'button';
      auto.className = 'notes-chip notes-chip-auto';
      auto.dataset.id = '';
      auto.textContent = 'Auto';
      els.chips.appendChild(auto);
      els.chipFor.set('', auto);
    }

    // The Auto chip's tooltip names the reader app, which a state push can
    // change, so it is set on every paint rather than once at build. With no
    // reader app configured, Auto still means "not picked by hand"; it just has
    // nothing to follow, and the tooltip says so.
    const autoTitle = readerOff(state)
      ? 'Follow whatever the reader app is showing (no reader app is configured, so pick a subject by hand)'
      : 'Follow whatever ' + readerName(state) + ' is showing';
    const autoChip = els.chipFor.get('');
    if (autoChip && autoChip.title !== autoTitle) autoChip.title = autoTitle;

    const subject = state.subject || { id: null, source: 'none', reason: '' };
    for (const [id, b] of els.chipFor) {
      if (id === '') {
        const on = subject.source !== 'manual';
        klass(b, 'is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      } else {
        const on = id === subject.id;
        klass(b, 'is-on', on);
        klass(b, 'is-detected', on && subject.source === 'reader');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    // Why nothing is picked. Only shown when main says it has no subject.
    const why = subject.source === 'none' ? reasonOf(subject.reason) : '';
    text(els.why, why);
    show(els.why, !!why);
  }

  function paintStrip(state) {
    const reader = state.reader || {};
    if (readerOff(state)) {
      // No reader app at all: an off row that says so in plain words (main's
      // reason when it gave one), never a bare "Reader: off" that reads as a
      // fault. Picking a subject by hand and the paste box still work.
      text(els.reader, withReason('Reader: none', reasonOf(reader.reason) || 'no reader app is configured'));
      setLevel(els.readerRow, 'off');
    } else {
      const mode = reader.mode === 'off' || !reader.mode ? 'off' : String(reader.mode).toUpperCase();
      text(els.reader, withReason('Reader: ' + mode, reader.reason));
      setLevel(els.readerRow, reader.state === 'error' ? 'bad'
        : reader.state === 'waiting' ? 'wait'
          : mode === 'off' ? 'off' : 'ok');
    }

    const helper = state.helper || {};
    const hs = helper.state || 'off';
    const label = hs === 'thinking' ? 'thinking\u2026' : hs;
    text(els.helper, withReason('Helper: ' + label, helper.reason));
    setLevel(els.helperRow, hs === 'error' ? 'bad'
      : (hs === 'thinking' || hs === 'paused') ? 'wait'
        : hs === 'off' ? 'off' : 'ok');

    const match = state.match;
    if (!match) {
      text(els.match, 'Section: nothing matched yet');
      setLevel(els.matchRow, 'off');
    } else if (match.sectionId) {
      const conf = typeof match.confidence === 'number' ? match.confidence.toFixed(2) : '?';
      const head = 'Section: ' + (match.title || match.sectionId) + ' \u00b7 ' + conf;
      text(els.match, state.pinned ? head + ' \u00b7 pinned' : head);
      setLevel(els.matchRow, state.pinned ? 'wait' : 'ok');
    } else {
      text(els.match, withReason('Nothing in your notes yet', match.reason));
      setLevel(els.matchRow, 'wait');
    }

    const helperOn = !!helper.enabled;
    text(els.helperBtn, helperOn ? 'Helper on' : 'Helper off');
    els.helperBtn.setAttribute('aria-pressed', helperOn ? 'true' : 'false');
    els.helperBtn.title = helperOn ? 'Turn the helper off' : 'Turn the helper on';
    klass(els.helperBtn, 'is-on', helperOn);

    const pinned = !!state.pinned;
    text(els.pinBtn, pinned ? 'Pinned' : 'Pin');
    els.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    els.pinBtn.title = pinned ? 'Unpin: follow the question again' : 'Pin: stop the notes jumping on their own';
    klass(els.pinBtn, 'is-on', pinned);

    // The debug-port policy belongs to the reader app, so with none configured
    // the whole row (button and note) stays hidden: there is nothing to install.
    const policy = readerOn(state) ? (state.policy || {}) : {};
    show(els.policyWrap, readerOn(state) && policy.installed === false);
    const policyBtn = els.policyWrap.querySelector('[data-cmd="install-policy"]');
    const policyTitle = 'Write the machine policy that opens ' + readerName(state) +
      "'s debug port, so the pane can read the question it shows";
    if (policyBtn && policyBtn.title !== policyTitle) policyBtn.title = policyTitle;
    const notes = [];
    if (policy.needsRestart) notes.push('The policy is written, but ' + readerName(state) + ' needs a restart for it to take.');
    if (reasonOf(policy.reason) && policy.installed === false) notes.push(reasonOf(policy.reason));
    const noteText = notes.join(' ');
    text(els.policyNote, noteText);
    show(els.policyNote, !!noteText);

    // A new reason can be longer (or shorter) than the row: re-measure.
    scheduleClipCheck();
  }

  function setLevel(row, level) {
    if (!row) return;
    if (row.dataset.level !== level) row.dataset.level = level;
  }

  function paintNotes(state) {
    const subjects = Array.isArray(state.subjects) ? state.subjects.filter(Boolean) : [];
    const subj = currentSubject(state);

    // Empty and broken are real UI, not a blank box.
    let empty = '';
    if (!subjects.length) {
      empty = state.ready === false
        ? 'No subjects yet \u2014 ' + (reasonOf(state.reason) || 'the notes index has not reported any.')
        : 'No notes found in ' + ((typeof state.dir === 'string' && state.dir.trim()) || 'the notes folder');
    }
    text(els.empty, empty);
    show(els.empty, !!empty);
    show(els.view, !empty);
    show(els.notesTitle.parentElement, !empty);

    if (!subj) { if (notesId !== null) dropView(); paintNotesNote(); return; }

    text(els.notesTitle, subj.name || subj.id);
    const sections = Array.isArray(subj.sections) ? subj.sections.length : 0;
    els.notesTitle.title = (subj.name || subj.id) + ' \u2014 ' + sections + ' sections \u00b7 ' + fileUrl(subj);

    const canOpen = typeof window.createTab === 'function';
    klass(els.openBtn, 'is-off', !canOpen);
    els.openBtn.title = canOpen
      ? 'Open these notes in a normal tab'
      : 'This build has no way to open a tab from the pane yet';

    if (noteKey(subj) !== notesId) loadNotes(subj);
    else paintNotesNote();
  }

  /**
   * The words for a pane that is switched off (state.configured false): no
   * notes folder is set, or the one set is gone. Main's reason says which; the
   * way back on is added unless main already named it.
   */
  function offText(state) {
    const why = reasonOf(state.reason) || 'no notes folder is set';
    const how = /settings/i.test(why) ? '' : ' Pick a folder in Settings › Notes pane.';
    return 'The notes pane is off: ' + why.replace(/[.\s]+$/, '') + '.' + how;
  }

  /**
   * One entry point for every paint. Idempotent: called with the same state it
   * changes nothing. window.NotesPane.render() is this, so a harness can drive
   * the pane without main.
   */
  function render(state) {
    if (!state || typeof state !== 'object') return;
    // A harness may render before the host event lands; build on demand rather
    // than dropping the state on the floor.
    if (!els || !els.root || !els.root.isConnected) {
      if (!bodyEl()) return;
      if (!build()) return;
    }
    last = state;

    // Switched off (no notes folder): app.js normally never shows the pane in
    // this state, but a harness or a folder deleted mid-session can. Then the
    // pane is one plain banner saying it is off and why; the chips, strip and
    // notes view are hidden (.is-off in notes-pane.css) and the guest is torn
    // down, so a stale note never sits under an "off" banner.
    const off = state.configured === false;
    klass(els.root, 'is-off', off);
    if (off) {
      text(els.alert, offText(state));
      show(els.alert, true);
      klass(els.root, 'is-unready', true);
      if (notesId !== null) dropView();
      paintStripReason();
      return;
    }

    const alert = state.ready === false
      ? (reasonOf(state.reason) || 'The notes pane is not ready and did not say why.')
      : '';
    text(els.alert, alert);
    show(els.alert, !!alert);
    klass(els.root, 'is-unready', !!alert);

    paintChips(state);
    paintStrip(state);
    paintNotes(state);
    paintStripReason();
    maybeJump(state);
  }

  /** Pulls a fresh state, and says so in the pane when it cannot. */
  function refresh() {
    const api = bridge();
    if (!api) {
      render({
        ready: false,
        reason: 'The browser has no notes bridge yet (window.api.notes is missing), so nothing can load.',
        subjects: [],
        subject: { id: null, source: 'none', reason: 'no bridge' },
        reader: { mode: 'off', state: 'error', reason: 'no bridge', port: 0, lastReadAt: 0, question: null },
        helper: { enabled: false, state: 'off', reason: 'no bridge', model: '', sessionId: null, lastMs: 0 },
        match: null,
        pinned: false,
        policy: { installed: false, needsRestart: false, port: 0, reason: 'no bridge' }
      });
      return;
    }
    Promise.resolve(api.describe()).then((state) => {
      if (state) render(state);
      else render({
        ready: false,
        reason: 'The notes pane got no answer from the browser (it refused the request).',
        subjects: [], subject: { id: null, source: 'none', reason: 'no answer' },
        reader: { mode: 'off', state: 'error', reason: 'no answer', port: 0, lastReadAt: 0, question: null },
        helper: { enabled: false, state: 'off', reason: 'no answer', model: '', sessionId: null, lastMs: 0 },
        match: null, pinned: false, policy: { installed: false, needsRestart: false, port: 0, reason: 'no answer' }
      });
    }).catch((err) => {
      render({
        ready: false,
        reason: 'Could not read the notes pane state: ' + (err && err.message ? err.message : String(err)),
        subjects: [], subject: { id: null, source: 'none', reason: 'error' },
        reader: { mode: 'off', state: 'error', reason: 'error', port: 0, lastReadAt: 0, question: null },
        helper: { enabled: false, state: 'error', reason: 'error', model: '', sessionId: null, lastMs: 0 },
        match: null, pinned: false, policy: { installed: false, needsRestart: false, port: 0, reason: 'error' }
      });
    });
  }

  // ------------------------------------------------------------ mount points

  function mount() {
    if (els && els.root && els.root.isConnected) return;
    if (!build()) return;
    const api = bridge();
    if (api && typeof api.onUpdate === 'function') {
      try {
        stopUpdates = api.onUpdate((state) => { if (state) render(state); });
      } catch (err) {
        stopUpdates = null;
        setStripReason('live updates are off: ' + (err && err.message ? err.message : String(err)));
      }
    }
    refresh();
  }

  function unmount() {
    if (stopUpdates) { try { stopUpdates(); } catch (e) { /* already gone */ } stopUpdates = null; }
    for (const t of reasonTimers.values()) clearTimeout(t);
    reasonTimers.clear();
    if (stripObserver) { stripObserver.disconnect(); stripObserver = null; }
    if (clipFrame) { clearTimeout(clipFrame); clipFrame = 0; }
    dropView();
    const body = bodyEl();
    if (body) body.textContent = '';
    els = null;
    stripReason = '';
  }

  function sync(detail) {
    if (showing(detail)) mount();
    else unmount();
  }

  document.addEventListener('sidepane', (e) => sync(e && e.detail));

  function boot() { sync(null); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // The harness contract: inject a state, read back what was painted.
  window.NotesPane = {
    render,
    state: () => last,
    refresh,
    mounted: () => !!(els && els.root && els.root.isConnected)
  };
})();
