/*
 * phone-page.js — the Phone tab's own script (a bundled, preload-less guest:
 * no window.api, no require). It mirrors the user's Android phone: H.264 from the
 * scrcpy server, decoded here with WebCodecs onto the canvas at true aspect;
 * pointer -> touch, wheel -> scroll, keys -> keycodes/text; a rail of hardware
 * keys and readouts. The wire contract (console bootstrap, then a localhost
 * WebSocket with JSON text frames and channel-prefixed binary frames) is the
 * header of phone.js — that file is the single source of truth.
 *
 * SCAFFOLD: bootstrap only. Shows the state main hands it, and says plainly
 * when main never answers. phone-page.js proper replaces this file wholesale.
 */
(function () {
  'use strict';

  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const frameNote = document.getElementById('frame-note');

  let answered = false;

  function show(kind, text) {
    if (statusDot) statusDot.dataset.kind = kind;
    if (statusText) statusText.textContent = text;
  }

  /**
   * main's answer to `phone:hello` and every later push. { ws, state }: ws is
   * the token-bearing WebSocket URL (first call only), state the phone.js state.
   */
  window.__applyPhone = function (data) {
    answered = true;
    const state = data && data.state;
    if (!state) { show('error', 'the browser answered without a state'); return; }
    if (!state.ready) {
      show('off', state.reason || 'not ready (no reason given)');
      if (frameNote) frameNote.textContent = state.reason || 'not ready';
      return;
    }
    show('ok', 'ready');
  };

  document.addEventListener('DOMContentLoaded', function () {
    show('off', 'waiting for the browser…');
    // The bootstrap line phone.js listens for on this guest's console.
    console.log('phone:hello');
    setTimeout(function () {
      if (answered) return;
      show('error', 'the browser did not answer: phone.js is not wired to this page');
      if (frameNote) frameNote.textContent = 'no answer from the browser';
    }, 2000);
  });
})();
