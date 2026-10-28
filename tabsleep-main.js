'use strict';
// tabsleep-main.js -- the main-process half of tab sleep. app.js decides WHICH background tab
// to put down and WHEN; it needs two things only main can do:
//
//   1. Memory figures ('tabs:memory'): free/total system memory, and how much each <webview>
//      guest's renderer is holding, so a tab can be slept sooner than the user's timer when the
//      machine is short of memory or the tab is very heavy. app.getAppMetrics() is cheap (no
//      child process, unlike the typeperf path stats.js uses); the answer is still cached for
//      MEMORY_CACHE_MS so a burst of asks costs one read.
//   2. A "safe to sleep?" probe ('tabs:prepare-sleep'), run in an ISOLATED world of the guest's
//      main frame: the page's own scripts cannot see it, patch the DOM methods it calls, or lie to
//      it. It reports typed text the user has not sent or saved, and live media (a call, the
//      camera or microphone, picture-in-picture). It has PROBE_TIMEOUT_MS to answer; a page that
//      does not answer is reported as such and app.js keeps it awake (the safe rule).
//
// Plus one push: each guest's 'audio-state-changed' (Chromium's own audibility, the signal behind
// Chrome's speaker icon) is forwarded to the chrome as 'tabs:audio-state', so the speaker on a
// chip follows real sound instead of the per-element media-started-playing / media-paused events.
//
// Nothing here throws at the renderer: every answer is a value with a plain-words reason.

/** Isolated world for the probe and its input tracker. 0 is the page; Electron's preload world is 999. */
const PROBE_WORLD_ID = 1717;
const PROBE_TIMEOUT_MS = 1500;
const MEMORY_CACHE_MS = 20000;

/*
 * Installed at every dom-ready, in the probe's world. It marks the fields and editors the USER
 * typed into (trusted input events only), so text a script prefilled -- a search box showing the
 * current query, a form filled from the server -- never counts as unsaved. A form that is
 * submitted drops its marks: what was typed has been sent. Same-origin frames are watched too
 * (their events never reach the top document); cross-origin frames cannot be seen from here.
 */
const TRACKER = `(() => {
  if (window.__quartzEdits) return 1;
  const marks = window.__quartzEdits = [];
  const mark = (t) => {
    if (!t || t.nodeType !== 1) return;
    const host = t.isContentEditable && t.closest ? (t.closest('[contenteditable]:not([contenteditable="false"])') || t) : t;
    for (const r of marks) if (r.deref() === host) return;
    if (marks.length >= 200) marks.shift();
    marks.push(new WeakRef(host));
  };
  const onInput = (e) => { if (e.isTrusted) mark(e.composedPath ? e.composedPath()[0] : e.target); };
  const onSubmit = (e) => {
    const form = e.target;
    for (let i = marks.length - 1; i >= 0; i--) { const el = marks[i].deref(); if (!el || (form && form.contains && form.contains(el))) marks.splice(i, 1); }
  };
  const watch = (doc) => {
    try {
      if (!doc || doc.__quartzWatched) return;
      doc.__quartzWatched = true;
      doc.addEventListener('input', onInput, true);
      doc.addEventListener('submit', onSubmit, true);
      doc.addEventListener('load', (e) => { const f = e.target; if (f && (f.tagName === 'IFRAME' || f.tagName === 'FRAME')) { try { watch(f.contentDocument); } catch (err) {} } }, true);
      for (const f of doc.querySelectorAll('iframe, frame')) { try { watch(f.contentDocument); } catch (err) {} }
    } catch (err) {}
  };
  watch(document);
  return 1;
})()`;

/*
 * The probe. Answers { busy: '' | plain words, tracked: bool }.
 * - Typed text: a field or editor the tracker saw the user type into, still on the page and still
 *   holding text. Search boxes and passwords are not "work". Without the tracker (it could not be
 *   installed, or the page loaded before this build) the fallback is the cautious one: any text
 *   field whose value differs from the value it was loaded with counts.
 * - Live media: a <video>/<audio> fed by a live MediaStream (a call, the camera, the microphone,
 *   a screen share), a picture-in-picture video, or a page telling the OS media controls it is
 *   playing. Sound itself is not asked here: app.js already reads Chromium's audibility.
 */
const PROBE = `(() => {
  const skipType = /^(hidden|password|search|checkbox|radio|range|button|submit|reset|file|image|color|date|datetime-local|month|week|time)$/i;
  const isSearch = (el) => el.getAttribute && (/^(searchbox|combobox)$/i.test(el.getAttribute('role') || '') || !!(el.closest && el.closest('[role="search"], search')));
  const editorText = (root) => {
    let text = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && text.length < 4; n = w.nextNode()) {
      const p = n.parentElement;
      if (p && p.closest('[contenteditable="false"], [aria-hidden="true"], [data-slate-placeholder], [data-placeholder]')) continue;
      text += (n.nodeValue || '').trim();
    }
    return text;
  };
  const fieldText = (el) => {
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && !skipType.test(el.type || ''))) {
      if (isSearch(el)) return '';
      return String(el.value || '').trim() ? 'form' : '';
    }
    if (el.isContentEditable) return editorText(el) ? 'editor' : '';
    return '';
  };
  let busy = '';
  const marks = window.__quartzEdits;
  if (marks) {
    for (const r of marks) {
      const el = r.deref();
      if (!el || !el.isConnected) continue;
      const kind = fieldText(el);
      if (kind) { busy = kind === 'editor' ? 'unsaved text in an editor' : 'unsaved text in a form'; break; }
    }
  } else {
    for (const el of document.querySelectorAll('input, textarea')) {
      if (fieldText(el) && el.value !== el.defaultValue) { busy = 'unsaved text in a form'; break; }
    }
  }
  if (!busy && document.designMode === 'on' && document.body && editorText(document.body)) busy = 'unsaved text in an editor';
  if (!busy) {
    for (const m of document.querySelectorAll('video, audio')) {
      const s = m.srcObject;
      if (s && typeof s.getTracks === 'function' && s.getTracks().some((t) => t.readyState === 'live')) { busy = 'a live call, camera or microphone'; break; }
    }
  }
  if (!busy && document.pictureInPictureElement) busy = 'a picture-in-picture video';
  if (!busy) { try { if (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing') busy = 'media that is playing'; } catch (err) {} }
  return { busy, tracked: !!marks };
})()`;

/**
 * Pure: free/total memory and each guest's share of its renderer's working set.
 * A renderer shared by several guests (same-site tabs can share one) is split evenly between
 * them: sleeping one tab of a shared process frees only its part.
 * @param {{ wcIds: number[], metrics: Array<{pid:number, memory?:{workingSetSize:number}}>,
 *           pidOf: (wcId:number) => number, system: {totalBytes:number, freeBytes:number} }} input
 * @returns {{ totalBytes:number, freeBytes:number, tabs: Object<string, {bytes:number, sharedWith:number}> }}
 */
function tabMemory({ wcIds, metrics, pidOf, system }) {
  const byPid = new Map();
  for (const m of metrics || []) {
    const kb = m && m.memory && Number(m.memory.workingSetSize);
    if (m && Number.isInteger(m.pid) && Number.isFinite(kb)) byPid.set(m.pid, kb * 1024);
  }
  const pids = new Map();
  for (const id of wcIds || []) {
    let pid = 0;
    try { pid = Number(pidOf(id)) || 0; } catch { pid = 0; }
    if (pid > 0 && byPid.has(pid)) pids.set(id, pid);
  }
  const count = new Map();
  for (const pid of pids.values()) count.set(pid, (count.get(pid) || 0) + 1);
  const tabs = {};
  for (const [id, pid] of pids) {
    const n = count.get(pid);
    tabs[id] = { bytes: Math.round(byPid.get(pid) / n), sharedWith: n - 1 };
  }
  return { totalBytes: system.totalBytes, freeBytes: system.freeBytes, tabs };
}

/** Electron's figures where they exist (kB), Node's otherwise; the same reading stats.js uses. */
function defaultSystemMemory() {
  const os = require('os');
  let totalBytes = os.totalmem();
  let freeBytes = os.freemem();
  try {
    if (typeof process.getSystemMemoryInfo === 'function') {
      const info = process.getSystemMemoryInfo();
      if (info && Number.isFinite(info.total) && info.total > 0) {
        totalBytes = info.total * 1024;
        if (Number.isFinite(info.free)) freeBytes = info.free * 1024;
      }
    }
  } catch { /* not Electron: os.* already answered */ }
  return { totalBytes, freeBytes };
}

/** Resolve within `ms` or reject with a plain-words reason. */
function withTimeout(promise, ms, words) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(words)), ms); })
  ]);
}

/**
 * Wire the IPC. `d`: { app, ipcMain, webContents, isChromeSender, chromeContents, systemMemory }.
 * chromeContents() returns the chrome window's webContents (or null) for the audio push.
 */
function install(d) {
  let cache = null; // { at, metrics, system }

  /** A <webview> guest by id, or null: never the chrome itself, never a dead or foreign id. */
  function guest(wcId) {
    if (!Number.isInteger(wcId)) return null;
    let c = null;
    try { c = d.webContents.fromId(wcId); } catch { c = null; }
    if (!c || c.isDestroyed() || c.getType() !== 'webview') return null;
    return c;
  }

  d.ipcMain.handle('tabs:memory', (event, payload) => {
    if (!d.isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
    const ids = (payload && Array.isArray(payload.wcIds) ? payload.wcIds : []).filter(Number.isInteger).slice(0, 500);
    try {
      const now = Date.now();
      if (!cache || now - cache.at > MEMORY_CACHE_MS) cache = { at: now, metrics: d.app.getAppMetrics(), system: (d.systemMemory || defaultSystemMemory)() };
      const out = tabMemory({ wcIds: ids, metrics: cache.metrics, system: cache.system, pidOf: (id) => { const g = guest(id); return g ? g.getOSProcessId() : 0; } });
      return Object.assign({ ok: true, at: cache.at }, out);
    } catch (err) {
      return { ok: false, reason: 'memory figures unavailable (' + String(err && err.message || err).slice(0, 80) + ')' };
    }
  });

  d.ipcMain.handle('tabs:prepare-sleep', async (event, payload) => {
    if (!d.isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
    const p = payload || {};
    const g = guest(p.wcId);
    if (!g) return { ok: false, reason: 'the page is not running' };
    // Electron holds any executeJavaScript* until the page stops loading, so asking a page that
    // is still loading would only time out (and leave a waiter behind). Say so instead.
    let loading = false;
    try { loading = g.isLoadingMainFrame(); } catch { loading = false; }
    if (loading) return { ok: true, probe: { ok: false, reason: 'it was still loading' } };
    try {
      const r = await withTimeout(g.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: PROBE }]),
        PROBE_TIMEOUT_MS, 'the page did not answer within ' + (PROBE_TIMEOUT_MS / 1000) + ' s');
      return { ok: true, probe: { ok: true, busy: r && typeof r.busy === 'string' ? r.busy.slice(0, 60) : '', tracked: !!(r && r.tracked) } };
    } catch (err) {
      return { ok: true, probe: { ok: false, reason: String(err && err.message || err).slice(0, 80) || 'the check failed' } };
    }
  });

  d.app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('dom-ready', () => {
      // Best effort: without the tracker the probe falls back to its cautious rule.
      try { contents.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: TRACKER }]).catch(() => {}); } catch { /* gone */ }
    });
    contents.on('audio-state-changed', (ev) => {
      const chrome = d.chromeContents();
      if (!chrome || chrome.isDestroyed()) return;
      try { chrome.send('tabs:audio-state', { wcId: contents.id, audible: !!(ev && ev.audible) }); } catch { /* window closing */ }
    });
  });
}

module.exports = { install, tabMemory, PROBE, TRACKER, PROBE_WORLD_ID, PROBE_TIMEOUT_MS, MEMORY_CACHE_MS };
