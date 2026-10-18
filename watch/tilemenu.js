/*
 * watch/tilemenu.js -- the menu on Lumen's playable tiles (watch.html): "Play" and "Add to multiview".
 *
 * Right-click a tile (a title card or a game card), or press the Menu key / Shift+F10 on the one in
 * focus. "Add to multiview" goes through watch.js's own open (window.__watchOpenCard(card, true)),
 * so it is routed exactly like a click -- the player layer, or the reason it can't play here -- and
 * marked multi: the layer adds it as a tile beside what is playing (watch-player-multi.js).
 *
 * Like watch.js, this page has no preload and draws with createElement + textContent only.
 */
(function () {
  'use strict';
  var menu = null, forCard = null, items = [];
  var last = null;   // the e2e's view: { key, items, at }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function urlOf(card) {
    var x = card && (card._item || card._event);
    var u = x && typeof x.url === 'string' ? x.url : '';
    return /^https:\/\//i.test(u) ? u : '';
  }
  /** The playable tile under a node: a card with a title, or a game card with a watch link. */
  function cardOf(node) {
    for (var n = node; n && n !== document.body; n = n.parentNode) {
      if (n._item || n._event) return urlOf(n) ? n : null;
    }
    return null;
  }

  function close(back) {
    if (!menu) return;
    var c = forCard;
    menu.remove();
    menu = null;
    forCard = null;
    items = [];
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    window.removeEventListener('wheel', onBlur, true);
    if (back && c && c.isConnected) { try { c.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function outside(e) { if (menu && !menu.contains(e.target)) close(false); }
  function onBlur() { close(false); }

  function act(multi) {
    var c = forCard;
    close(true);
    if (c && typeof window.__watchOpenCard === 'function') window.__watchOpenCard(c, multi);
  }

  function open(card, x, y) {
    close(false);
    forCard = card;
    menu = el('div', 'tmenu');
    menu.setAttribute('role', 'menu');
    var name = (card._item && card._item.title) || (card._event && (card._event.name || card._event.title)) || '';
    if (name) menu.setAttribute('aria-label', name);
    var play = el('button', 'tm-item', 'Play');
    var add = el('button', 'tm-item', 'Add to multiview');
    add.appendChild(el('span', 'tm-hint', 'beside what’s playing'));
    [play, add].forEach(function (b, i) {
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); act(i === 1); });
      menu.appendChild(b);
    });
    items = [play, add];
    menu.addEventListener('keydown', function (e) {
      var i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });
    document.body.appendChild(menu);
    // Inside the window, below-right of the pointer when it fits.
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var left = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    var top = y + h + 8 > window.innerHeight ? Math.max(8, y - h) : y;
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    window.addEventListener('wheel', onBlur, true);
    last = { key: card.dataset ? card.dataset.key || '' : '', items: ['Play', 'Add to multiview'], at: Date.now() };
    try { play.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  }

  document.addEventListener('contextmenu', function (e) {
    var card = cardOf(e.target);
    if (!card) return;
    e.preventDefault();
    open(card, e.clientX, e.clientY);
  });
  document.addEventListener('keydown', function (e) {
    if (menu) return;
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    var card = cardOf(document.activeElement);
    if (!card) return;
    e.preventDefault();
    var r = card.getBoundingClientRect();
    open(card, r.left + 12, r.top + Math.min(r.height - 8, 40));
  });

  window.LumenTileMenu = {
    open: function (card, x, y) { if (cardOf(card) === card) { open(card, x || 0, y || 0); return true; } return false; },
    close: function () { close(false); },
    _state: function () { return { open: !!menu, last: last, items: items.map(function (b) { return b.firstChild ? b.firstChild.textContent : ''; }) }; }
  };
})();
