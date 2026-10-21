// tests/watch-yt-stills.js -- YouTube's stills, drawn here: what i.ytimg.com would send, at its real
// sizes and formats, so an e2e never asks the real CDN (the rule: tests use fixtures and local mocks only)
// and still decodes what the real Watch decodes (a 1280x720 webp costs what a 1280x720 webp costs; an SVG
// title card is rasterized at the tile's size and hides that cost).
//
//   const Stills = require('./tests/watch-yt-stills');
//   const r = await Stills.answer(page, url, title);   // { mime, body: Buffer, w, h } | null (not i.ytimg.com)
//
//   maxresdefault.webp / .jpg  1280x720
//   sddefault.jpg              640x480, the 16:9 picture letterboxed (black bars, as YouTube sends it)
//   hqdefault.jpg              480x360, letterboxed
//   mqdefault.jpg              320x180
//   default.jpg                120x90, letterboxed
// Each is a title card with detail (shapes and grain, so it compresses and decodes like a photo, not
// like a flat gradient), encoded by the page's own canvas (OffscreenCanvas.convertToBlob) the first
// time and kept on disk (%TEMP%\quartz-watch-yt-stills-v1), so A/B runs decode byte-identical files.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.tmpdir(), 'quartz-watch-yt-stills-v1');
const SIZES = {
  maxresdefault: [1280, 720, 0], hq720: [1280, 720, 0], sddefault: [640, 480, 60], hqdefault: [480, 360, 45],
  mqdefault: [320, 180, 0], default: [120, 90, 11],
};
const mem = new Map();
const busy = new Map();

/** { id, name, ext, live } of an i.ytimg.com still URL, or null. */
function parse(url) {
  let u; try { u = new URL(url); } catch (e) { return null; }
  if (!/^i\d?\.ytimg\.com$/.test(u.hostname)) return null;
  const m = /^\/(vi|vi_webp)\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_]+)\.(jpg|webp)$/.exec(u.pathname);
  if (!m) return null;
  const live = /_live$/.test(m[3]);
  return { id: m[2], name: m[3].replace(/_live$/, ''), ext: m[4], live };
}

function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }

/* Runs in the page: draws one still and returns it base64. */
const DRAW = `async (s) => {
  const c = new OffscreenCanvas(s.w, s.h); const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, s.w, s.h);
  const ph = s.h - 2 * s.bar;
  let seed = s.seed >>> 0; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  x.save(); x.translate(0, s.bar); x.scale(s.w / 1280, ph / 720);
  const g = x.createRadialGradient(280, 130, 0, 280, 130, 1300);
  g.addColorStop(0, 'hsl(' + s.h1 + ',38%,46%)'); g.addColorStop(1, 'hsl(' + s.h2 + ',30%,12%)');
  x.fillStyle = g; x.fillRect(0, 0, 1280, 720);
  for (let i = 0; i < 320; i++) {
    x.fillStyle = 'hsla(' + ((s.h1 + rnd() * 140) | 0) + ',' + ((25 + rnd() * 45) | 0) + '%,' + ((15 + rnd() * 65) | 0) + '%,' + (0.08 + rnd() * 0.3).toFixed(2) + ')';
    x.beginPath(); x.ellipse(rnd() * 1280, rnd() * 720, 6 + rnd() * 150, 6 + rnd() * 90, rnd() * 3.14, 0, 6.283); x.fill();
  }
  for (let i = 0; i < 90; i++) { x.strokeStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.2).toFixed(2) + ')'; x.lineWidth = 1 + rnd() * 3;
    x.beginPath(); x.moveTo(rnd() * 1280, rnd() * 720); x.lineTo(rnd() * 1280, rnd() * 720); x.stroke(); }
  const fade = x.createLinearGradient(0, 0, 0, 720); fade.addColorStop(0.45, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = fade; x.fillRect(0, 0, 1280, 720);
  x.fillStyle = '#f4f3ef'; x.font = '700 ' + (s.title.length > 24 ? 64 : 92) + 'px "Segoe UI Variable Display", "Segoe UI", sans-serif';
  x.fillText(s.title, 80, 620);
  x.font = '600 30px "Segoe UI", sans-serif'; x.fillStyle = 'rgba(244,243,239,.8)'; x.fillText(s.id + '  ' + s.name, 80, 670);
  x.restore();
  const d = x.getImageData(0, s.bar, s.w, ph); const a = d.data;
  for (let i = 0; i < a.length; i += 4) { const n = (rnd() - 0.5) * 18; a[i] += n; a[i + 1] += n; a[i + 2] += n; }
  x.putImageData(d, 0, s.bar);
  const b = await c.convertToBlob({ type: s.mime, quality: s.q });
  const u8 = new Uint8Array(await b.arrayBuffer()); let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { type: b.type, b64: btoa(bin) };
}`;

/**
 * The still for `url` (an i.ytimg.com URL), drawn by `page` (a CDP client with ev()) the first time.
 * null for any other URL. A name it doesn't know gets the hq size.
 */
async function answer(page, url, title) {
  const p = parse(url);
  if (!p) return null;
  const [w, h, bar] = SIZES[p.name] || SIZES.hqdefault;
  const mime = p.ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const t = String(title || 'Untitled');
  const key = crypto.createHash('sha1').update([p.id, t, p.name, p.ext, w, h, bar].join('|')).digest('hex').slice(0, 20);
  if (mem.has(key)) return mem.get(key);
  const file = path.join(DIR, key + '.' + p.ext);
  try { const body = fs.readFileSync(file); const r = { mime, body, w, h }; mem.set(key, r); return r; } catch (e) { /* not drawn yet */ }
  if (!busy.has(key)) {
    busy.set(key, (async () => {
      const h1 = hue(t), spec = { w, h, bar, id: p.id, name: p.name + (p.live ? '_live' : ''), title: t, h1, h2: (h1 + 40) % 360, seed: parseInt(key.slice(0, 8), 16),
        mime, q: mime === 'image/webp' ? 0.8 : 0.86 };
      const out = await page.ev('(' + DRAW + ')(' + JSON.stringify(spec) + ')');
      const body = Buffer.from(out.b64, 'base64');
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, body); } catch (e) { /* memory only */ }
      const r = { mime: out.type || mime, body, w, h };
      mem.set(key, r);
      return r;
    })().finally(() => busy.delete(key)));
  }
  return busy.get(key);
}

/** Draw every size of these videos now (before a measurement), so none is drawn mid-run. */
async function prepare(page, list) {
  const names = ['/vi_webp/%/maxresdefault.webp', '/vi/%/maxresdefault.jpg', '/vi/%/sddefault.jpg', '/vi/%/hqdefault.jpg'];
  for (const { id, title } of list) for (const n of names) await answer(page, 'https://i.ytimg.com' + n.replace('%', id), title);
}

module.exports = { answer, prepare, parse, DIR };
