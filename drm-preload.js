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
 *                The wrapper only OBSERVES EME status: which key system was
 *                asked for, granted or refused, whether a licence was accepted,
 *                and key status names. It never reads licence bytes, keys or
 *                media, and never changes what the page sends or receives.
 *   'encrypted'  a <video>/<audio> in this document received encrypted media
 *                (the trusted 'encrypted' event, heard in the capture phase).
 *   'licence'    a build WITH Widevine, and the service still refused: its
 *                licence was rejected, a key came back unusable, or no licence
 *                arrived 15 s after the request (see installHook).
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
    const key = payload.kind + ':' + (payload.keySystem || payload.outcome || '') + ':' + (payload.granted ? 1 : 0);
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
  const LICENCE = ['refused', 'no-licence', 'key-error'];
  const onLicence = (outcome, detail) => {
    if (typeof outcome !== 'string' || LICENCE.indexOf(outcome) === -1) return;
    tell({ kind: 'licence', outcome, detail: typeof detail === 'string' ? detail.slice(0, 80) : '' });
  };

  /*
   * Runs in the MAIN world. Serialised by contextBridge, so it must be
   * self-contained: no closures over this file.
   */
  function installHook(report, licence) {
    /*
     * A build WITH Widevine: the key system is granted, and then the service
     * may still refuse. Each MediaKeySession is watched (listeners only, the
     * page's objects and promises are handed back untouched):
     *   'refused'     update() with the service's licence was rejected
     *   'key-error'   a key came back internal-error or output-restricted
     *   'no-licence'  a licence request went out and no update() followed
     *                 within 15 s (a licence server that answered with an error)
     */
    try {
      const say = (outcome, detail) => { try { licence(outcome, String(detail || '').slice(0, 80)); } catch (err) { /* bridge gone */ } };
      const MK = window.MediaKeys && MediaKeys.prototype;
      const MKS = window.MediaKeySession && MediaKeySession.prototype;
      const cs = MK && Object.getOwnPropertyDescriptor(MK, 'createSession');
      const up = MKS && Object.getOwnPropertyDescriptor(MKS, 'update');
      if (cs && typeof cs.value === 'function' && up && typeof up.value === 'function') {
        const waits = new WeakMap(); // session -> timer of a licence request not yet answered
        const watch = (session) => {
          try {
            session.addEventListener('message', (event) => {
              try {
                const t = String(event && event.messageType || '');
                if (t !== 'license-request' && t !== 'individualization-request') return;
                if (waits.has(session)) return;
                waits.set(session, setTimeout(() => { waits.delete(session); say('no-licence', t); }, 15000));
              } catch (err) { /* nothing to watch */ }
            });
            session.addEventListener('keystatuseschange', () => {
              try {
                session.keyStatuses.forEach((status) => {
                  if (status === 'internal-error' || status === 'output-restricted') say('key-error', status);
                });
              } catch (err) { /* nothing to read */ }
            });
          } catch (err) { /* not a session */ }
        };
        const csWrapped = new Proxy(cs.value, {
          apply(target, self, args) {
            const session = Reflect.apply(target, self, args);
            watch(session);
            return session;
          }
        });
        const upWrapped = new Proxy(up.value, {
          apply(target, self, args) {
            try { const t = waits.get(self); if (t) { clearTimeout(t); waits.delete(self); } } catch (err) { /* fine */ }
            const pending = Reflect.apply(target, self, args);
            try {
              Promise.prototype.then.call(pending, null, (err) => say('refused', (err && err.name) || 'rejected'));
            } catch (err) { /* not a promise */ }
            return pending;
          }
        });
        Object.defineProperty(MK, 'createSession', { value: csWrapped, writable: cs.writable, enumerable: cs.enumerable, configurable: cs.configurable });
        Object.defineProperty(MKS, 'update', { value: upWrapped, writable: up.writable, enumerable: up.enumerable, configurable: up.configurable });
      }
    } catch (err) { /* the request hook below still works */ }
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
      hooked = String(contextBridge.executeInMainWorld({ func: installHook, args: [onRequest, onLicence] }));
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
