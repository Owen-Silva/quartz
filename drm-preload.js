'use strict';
/*
 * drm-preload.js -- tells Quartz when a page's video needs DRM it cannot play.
 *
 * Registered by drm-main.js as a SESSION preload (type 'frame'), the same
 * mechanism spell-preload.js and Ghostery use: it reaches every frame of every
 * guest without going near will-attach-webview, which strips any preload a
 * page asks for and must keep doing so. It runs in the ISOLATED world, so the
 * page never sees ipcRenderer or this file's state.
 *
 * Two observations, reported to main once each per document:
 *
 *   'request'    the page asked navigator.requestMediaKeySystemAccess() for a
 *                PROTECTED key system (Widevine, PlayReady, FairPlay) and was
 *                granted or refused. Watched by wrapping the main world's
 *                function in a Proxy installed with
 *                contextBridge.executeInMainWorld before any page script runs.
 *                The Proxy passes every call straight through and hands back
 *                the page's own promise untouched; it only adds a listener.
 *                A callable Proxy still prints as native code, so a page that
 *                checks for tampering sees nothing different.
 *   'encrypted'  a <video>/<audio> in this document received encrypted media
 *                (the trusted 'encrypted' event, heard in the capture phase).
 *
 * Neither is a verdict on its own -- see emeVerdict() in drm-sites.js. Most
 * refusals are probes from pages that then play plain video. The chrome puts
 * the two together per tab.
 *
 * Costs nothing on a page that never touches EME: one wrapped function and
 * one capture listener. Skips non-web frames (Quartz's own pages, about:,
 * data:) entirely.
 */
const { ipcRenderer, contextBridge } = require('electron');

const PROTECTED = /^(?:com\.widevine\.alpha(?:\..*)?|com\.microsoft\.playready(?:\..*)?|com\.youtube\.playready|com\.chromecast\.playready|com\.apple\.fps(?:\..*)?)$/i;

function isWebFrame() {
  try { return location.protocol === 'http:' || location.protocol === 'https:'; } catch (err) { return false; }
}

if (isWebFrame()) {
  const told = new Set();
  const tell = (payload) => {
    const key = payload.kind + ':' + (payload.keySystem || '') + ':' + (payload.granted ? 1 : 0);
    if (told.has(key) || told.size > 16) return; // once each; a page cannot flood main
    told.add(key);
    try { ipcRenderer.send('drm:eme', payload); } catch (err) { /* the browser is going away */ }
  };

  // Called FROM the main world through the bridge: only strings and booleans
  // cross, and anything else is refused here.
  const onRequest = (keySystem, granted) => {
    if (typeof keySystem !== 'string' || !PROTECTED.test(keySystem)) return;
    tell({ kind: 'request', keySystem: keySystem.slice(0, 100), granted: granted === true });
  };

  /*
   * Runs in the MAIN world. Serialised by contextBridge, so it must be
   * self-contained: no closures over this file.
   */
  function installHook(report) {
    try {
      const proto = window.Navigator && Navigator.prototype;
      if (!proto) return 'no-eme';
      const desc = Object.getOwnPropertyDescriptor(proto, 'requestMediaKeySystemAccess');
      if (!desc || typeof desc.value !== 'function') return 'no-eme'; // insecure context: no EME at all
      const original = desc.value;
      const wrapped = new Proxy(original, {
        apply(target, self, args) {
          const pending = Reflect.apply(target, self, args);
          let ks = '';
          try { ks = typeof args[0] === 'string' ? args[0] : ''; } catch (err) { ks = ''; }
          if (ks) {
            try {
              Promise.prototype.then.call(pending,
                () => { try { report(ks, true); } catch (err) { /* bridge gone */ } },
                () => { try { report(ks, false); } catch (err) { /* bridge gone */ } });
            } catch (err) { /* not a promise: nothing to watch */ }
          }
          return pending;
        }
      });
      Object.defineProperty(proto, 'requestMediaKeySystemAccess', {
        value: wrapped, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable
      });
      return 'ok';
    } catch (err) {
      return 'failed';
    }
  }

  let hooked = 'failed';
  try {
    if (typeof contextBridge.executeInMainWorld === 'function') {
      hooked = String(contextBridge.executeInMainWorld({ func: installHook, args: [onRequest] }));
    }
  } catch (err) {
    hooked = 'failed';
  }
  // The address-based bar still works without the hook; main says in Settings
  // that the behaviour-based one is off, and why, from this one line.
  if (hooked !== 'ok' && hooked !== 'no-eme' && window === window.top) {
    try { ipcRenderer.send('drm:hook', { ok: false, result: hooked.slice(0, 40) }); } catch (err) { /* going away */ }
  }

  window.addEventListener('encrypted', (event) => {
    if (!event || !event.isTrusted) return;
    tell({ kind: 'encrypted', initDataType: String(event.initDataType || '').slice(0, 20) });
  }, true);
}
