'use strict';
/*
 * score-pin-preload.js -- the only bridge a pinned score card has (score-pin.html, sandboxed,
 * contextIsolation on). It can say four things about ITS OWN pin -- ready, close, open the
 * game, mute -- report its height and a drag, and note a sound it played; main
 * (score-pins-main.js) knows which pin each card is from the sender, so a card can never
 * touch another card's pin. Nothing here reaches the network, the disk or another window.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: () => ipcRenderer.send('scorepin:ready'),
  // { key, pin, reading, health, muted, sound, lastOkAt, nextAt, look, events, flash? }
  onState: (fn) => { ipcRenderer.on('scorepin:state', (_e, s) => { try { fn(s); } catch (err) { console.error(err); } }); },
  // { theme, hue, palette } whenever Quartz's look changes
  onLook: (fn) => { ipcRenderer.on('scorepin:look', (_e, l) => { try { fn(l); } catch (err) { console.error(err); } }); },
  close: () => ipcRenderer.send('scorepin:close'),
  open: () => ipcRenderer.send('scorepin:open'),
  mute: (muted) => ipcRenderer.send('scorepin:mute', !!muted),
  height: (px) => ipcRenderer.send('scorepin:height', Number(px)),
  // phase 'start' | 'move' | 'end'; dx/dy in px from where the drag began
  drag: (phase, dx, dy) => ipcRenderer.send('scorepin:drag', { phase: String(phase), dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  played: (kind) => ipcRenderer.send('scorepin:played', String(kind))
});
