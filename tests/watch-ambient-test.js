// tests/watch-ambient-test.js -- Lumen's ambient field's pure parts, no Electron, no network:
//   watch-ambient.js:       the YouTube id and its still, the key per video (a Short that moves is a new key),
//                           the sample signature and its change, when the refresh may run (reduced motion,
//                           battery saver, hidden, background) and which slot the field dresses (single view only:
//                           never multiview, the corner, fullscreen or the full page);
//   watch-ambient-main.js:  the battery-saver gate (chrome only, null with its reason when it can't say);
//   the CSS:                no backdrop-filter and no endless animation in the look's files, the field under
//                           the view, and the hooks in place (index.html, watch-playview.js, main.js, preload.js).
// One summary line: "watch-ambient-test: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'watch-ambient'));
const Main = require(path.join(ROOT, 'watch-ambient-main'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---- ids, stills, keys ---------------------------------------------------------------------- */
check(A.ytId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s') === 'dQw4w9WgXcQ', 'a watch page: its v=');
check(A.ytId('https://www.youtube.com/shorts/Xk3pQ9vLm2A') === 'Xk3pQ9vLm2A' && A.ytId('https://m.youtube.com/shorts/Xk3pQ9vLm2A/') === 'Xk3pQ9vLm2A', 'a Short: its id');
check(A.ytId('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ' && A.ytId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'youtu.be and an embed');
check(A.ytId('https://www.youtube.com/feed/subscriptions') === '' && A.ytId('nonsense') === '' && A.ytId('https://www.youtube.com/watch?v=<script>') === '', 'no id: nothing (and nothing odd passes)');
check(A.stillUrl('dQw4w9WgXcQ') === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', 'the still: YouTube’s own mqdefault for the id');
check(A.stillUrl('../x') === '' && A.stillUrl('') === '', 'a bad id: no still URL');
check(A.keyOf('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s') === A.keyOf('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=99s'), 'the same video at another time: the same key (no repaint)');
check(A.keyOf('youtube', 'https://www.youtube.com/shorts/Xk3pQ9vLm2A') !== A.keyOf('youtube', 'https://www.youtube.com/shorts/Rt7nB2wQe5Z'), 'the next Short: a new key');
check(A.keyOf('disney', 'https://www.disneyplus.com/play/abc#x') === 'disney:https://www.disneyplus.com/play/abc', 'another service: its page address');

/* ---- the avatar's fallback ------------------------------------------------------------------- */
check(A.placeholder(1, 1) && A.placeholder(0, 0) && A.placeholder(2, 88) && !A.placeholder(88, 88), 'a 1 x 1 (or 0 x 0) avatar is YouTube’s lazy placeholder; a real one is kept');
check(A.initialOf('@guitarcoachryan') === 'G' && A.initialOf('  ') === '' && A.initialOf('ärzte') === 'Ä', 'the fallback initial: the first letter, no @');

/* ---- the sample's signature ---------------------------------------------------------------------- */
function solid(w, h, rgb, stride) { const st = stride || 3, px = new Uint8Array(w * h * st); for (let i = 0; i < w * h; i++) { px[i * st] = rgb[0]; px[i * st + 1] = rgb[1]; px[i * st + 2] = rgb[2]; if (st === 4) px[i * st + 3] = 255; } return px; }
const s1 = A.signature(solid(48, 27, [200, 100, 50]), 48, 27);
check(s1.length === 36 && Math.abs(s1[0] - 200) < 0.01 && Math.abs(s1[35] - 50) < 0.01, 'a signature: 4 x 3 cells of mean RGB', s1.slice(0, 3));
const s4 = A.signature(solid(27, 48, [200, 100, 50], 4), 27, 48, 4);
check(A.diff(s1, s4) < 0.01, 'RGB and RGBA, landscape and portrait, give the same signature for the same colour');
check(A.diff(s1, A.signature(solid(48, 27, [204, 104, 54]), 48, 27)) < A.DELTA, 'a near-identical frame is under DELTA: it paints nothing');
check(A.diff(s1, A.signature(solid(48, 27, [40, 160, 200]), 48, 27)) > A.DELTA, 'a new scene is over DELTA: it paints');
check(A.diff(null, s1) === Infinity, 'no previous signature: always paints');

/* ---- when the refresh may run ------------------------------------------------------------------ */
check(A.refreshOff({ reduced: false, saver: false, hidden: false, focused: true }) === '', 'all clear: it refreshes');
check(/reduce motion/.test(A.refreshOff({ reduced: true })), 'reduced motion: no refresh');
check(/battery saver/.test(A.refreshOff({ saver: true })), 'battery saver: no refresh');
check(A.refreshOff({ saver: null }) === '', 'battery saver unknown (not Windows, koffi missing): it refreshes');
check(/hidden/.test(A.refreshOff({ hidden: true })) && /background/.test(A.refreshOff({ focused: false })), 'hidden or in the background: no refresh');
check(A.EVERY >= 3000 && A.EVERY_IDLE >= A.EVERY, 'at most one sample every few seconds (' + A.EVERY + ' ms), slower while paused (' + A.EVERY_IDLE + ' ms)');

/* ---- which slot the field dresses ---------------------------------------------------------------- */
function cls(list) { const set = new Set(list); return { contains: (c) => set.has(c) }; }
function slot(tileCls) { return { tile: { classList: cls(tileCls) }, view: {} }; }
const L = (o) => Object.assign({ open: true, el: { hidden: false, classList: cls(o.layer || []) }, slots: o.slots }, {});
check(A.pick(L({ slots: [slot(['pv'])] })).mode === 'pv', 'the playback view: dressed');
check(A.pick(L({ slots: [slot(['sh'])] })).mode === 'sh', 'the Shorts view: dressed');
check(/multiview/.test(A.pick(L({ slots: [slot(['pv']), slot(['pv'])] })).why), 'multiview: no field');
check(/corner/.test(A.pick(L({ layer: ['mv-mini'], slots: [slot(['pv'])] })).why) && /fullscreen/.test(A.pick(L({ layer: ['wp-fs'], slots: [slot(['pv'])] })).why), 'the corner and fullscreen: no field');
check(/full page/.test(A.pick(L({ slots: [slot([])] })).why), 'the service’s full page: no field');
check(/state/.test(A.pick(L({ slots: [slot(['pv', 'has-state'])] })).why), 'a slot showing a state (DRM, failed): no field');
check(/closed/.test(A.pick({ open: false, el: { hidden: true, classList: cls([]) }, slots: [] }).why), 'the player closed: no field');

/* ---- main's gate ------------------------------------------------------------------------------- */
const handlers = {};
const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
let saver = true;
Main.create({ ipcMain: ipc, isChromeSender: (e) => !!(e && e.chrome), saverOn: () => saver }).registerIpc();
check(typeof handlers['lumen-ambient:gate'] === 'function', 'main answers lumen-ambient:gate');
check(handlers['lumen-ambient:gate']({ chrome: false }).ok === false, 'only the chrome may ask');
check(handlers['lumen-ambient:gate']({ chrome: true }).saver === true, 'battery saver on: saver true');
saver = false;
check(handlers['lumen-ambient:gate']({ chrome: true }).saver === false, 'battery saver off: saver false');
saver = null;
const g = Main.create({ saverOn: () => null }).gate();
check(g.ok && g.saver === null && typeof g.why === 'string', 'can’t say: null, with its reason', g);

/* ---- the CSS and the hooks ------------------------------------------------------------------- */
const css = ['watch-ambient.css', 'watch-playview.css', 'watch-shorts.css', 'watch-comments.css'].map((f) => [f, read(f)]);
for (const [f, t] of css) {
  const body = t.replace(/\/\*[\s\S]*?\*\//g, '');
  check(!/backdrop-filter/.test(body), f + ': no backdrop-filter (tall blurred layers drop tiles)');
  check(!/filter\s*:\s*blur/.test(body), f + ': no CSS blur filter (the field is blurred once, in a canvas)');
}
const amb = read('watch-ambient.css').replace(/\/\*[\s\S]*?\*\//g, '');
check(/\.amb\s*\{[^}]*z-index:\s*-1/.test(amb) && /pointer-events:\s*none/.test(amb), 'the field is under the view and never takes a click');
check(!/infinite/.test(amb), 'no endless animation in the field (only a cross-fade and the sink)');
// lumen-n-perf2: the scroll-driven sink repainted the whole window on every scroll step (watch-look-e2e)
check(!/animation-timeline|scroll-timeline|view-timeline|timeline-scope/.test(amb), 'nothing in the field is linked to scrolling (no scroll- or view-driven animation)');
check(/\.amb\s*\{[^}]*will-change:\s*transform/.test(amb) && /\.amb-f\s*\{[^}]*will-change:\s*opacity/.test(amb), 'the field is its own composited layer, and its sink fades on the compositor');
check(/\.amb-sunk[^{]*\.amb-f\s*\{\s*opacity:\s*\.2/.test(amb) && /new IntersectionObserver\(/.test(read('watch-ambient.js')) && /classList\.toggle\('amb-sunk'/.test(read('watch-ambient.js')),
  'the sink is one class (.amb-sunk) that an IntersectionObserver flips: no script while scrolling');
check(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.amb-c(?:,\s*\.amb-f)?\s*\{\s*transition:\s*none/.test(amb), 'reduced motion: the colours change without a fade');
const idx = read('index.html');
check(/<link rel="stylesheet" href="watch-ambient.css">/.test(idx) && /<script src="watch-ambient.js"><\/script>/.test(idx), 'index.html loads the field');
check(/LumenAmbient\.attach\(ctx, s, v\)/.test(read('watch-playview.js')) && /LumenAmbient\.destroy\(ctx, s\)/.test(read('watch-playview.js')), 'the playback view hands the field each slot (attach / destroy)');
check(/watch-ambient-main/.test(read('main.js')) && /lumen-ambient:gate/.test(read('preload.js')), 'main and the preload carry the battery-saver gate');

console.log('watch-ambient-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
