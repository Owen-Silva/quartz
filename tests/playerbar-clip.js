// tests/playerbar-clip.js -- a SYNTHETIC test clip for the play bar e2e (never a recording of anyone's):
// colour bars (bright, so the bar's legibility over bright video is tested), a box sweeping across, and a
// 7-segment MM:SS clock in the middle so a seek shows in a shot; a 440 Hz tone. Painted here as BMP frames
// and piped into ffmpeg (the stripped build Remotion ships has no testsrc2), H.264 + AAC, 2 min, made once
// and cached. Exports ensureClip(file) -> Promise<true|false>.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const W = 640, H = 360, FPS = 24, SECS = 120;
const FFMPEG = [process.env.QUARTZ_FFMPEG, path.join(os.homedir(), 'reddit-builds', 'video', 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe')].filter(Boolean);
// 75% bars, SMPTE order (BGR in the file).
const BARS = [[191, 191, 191], [191, 191, 0], [0, 191, 191], [0, 191, 0], [191, 0, 191], [191, 0, 0], [0, 0, 191], [40, 40, 40]];
// 7-segment: a b c d e f g
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

function header() {
  const b = Buffer.alloc(54);
  const size = 54 + W * H * 3;
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(W, 18); b.writeInt32LE(-H, 22);   // top-down rows
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(W * H * 3, 34);
  return b;
}
function rowOf(fn) { const r = Buffer.alloc(W * 3); for (let x = 0; x < W; x++) { const c = fn(x); r[x * 3] = c[2]; r[x * 3 + 1] = c[1]; r[x * 3 + 2] = c[0]; } return r; }
const TOP = rowOf((x) => { const c = BARS[Math.min(7, Math.floor(x / (W / 8)))]; return [c[0], c[1], c[2]]; });
const LOW = rowOf((x) => { const g = Math.round(20 + 200 * x / W); return [g, g, g]; });
function rect(f, x0, y0, w, h, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) { const i = (y * W + x) * 3; f[i] = rgb[2]; f[i + 1] = rgb[1]; f[i + 2] = rgb[0]; }
  }
}
function digit(f, d, x, y, s) {
  const on = SEG[d], k = [24, 24, 24], t = 4 * s, l = 16 * s;
  if (on.includes('a')) rect(f, x + t, y, l, t, k);
  if (on.includes('g')) rect(f, x + t, y + t + l, l, t, k);
  if (on.includes('d')) rect(f, x + t, y + 2 * (t + l), l, t, k);
  if (on.includes('f')) rect(f, x, y + t, t, l, k);
  if (on.includes('b')) rect(f, x + t + l, y + t, t, l, k);
  if (on.includes('e')) rect(f, x, y + 2 * t + l, t, l, k);
  if (on.includes('c')) rect(f, x + t + l, y + 2 * t + l, t, l, k);
}
function frame(n) {
  const f = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) (y < H * 0.72 ? TOP : LOW).copy(f, y * W * 3);
  const t = n / FPS;
  rect(f, Math.round((t * 160) % (W + 60)) - 60, Math.round(H * 0.74), 60, 60, [250, 250, 250]);
  const s = Math.floor(t), mm = Math.floor(s / 60), ss = s % 60, sc = 2;
  const dw = 24 * sc + 10, x0 = Math.round(W / 2 - (4 * dw + 16) / 2), y0 = Math.round(H * 0.36 - 22 * sc);
  rect(f, x0 - 14, y0 - 12, 4 * dw + 16 + 18, 2 * (4 * sc + 16 * sc) + 4 * sc + 24, [236, 236, 236]);
  [Math.floor(mm / 10), mm % 10].forEach((d, i) => digit(f, d, x0 + i * dw, y0, sc));
  rect(f, x0 + 2 * dw + 2, y0 + 12 * sc, 4 * sc, 4 * sc, [24, 24, 24]);
  rect(f, x0 + 2 * dw + 2, y0 + 28 * sc, 4 * sc, 4 * sc, [24, 24, 24]);
  [Math.floor(ss / 10), ss % 10].forEach((d, i) => digit(f, d, x0 + 2 * dw + 16 + i * dw, y0, sc));
  return f;
}

function ensureClip(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 100000) return Promise.resolve(true);
  const exe = FFMPEG.find((p) => fs.existsSync(p));
  if (!exe) return Promise.resolve(false);
  const part = file + '.part.mp4';
  return new Promise((resolve) => {
    const c = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'bmp', '-framerate', String(FPS), '-i', '-',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(SECS), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', String(FPS),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', '-threads', '2', part], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
    try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* stays normal */ }
    const hd = header();
    let n = 0;
    const N = FPS * SECS;
    c.stdin.on('error', () => { /* ffmpeg gone: exit says */ });
    const pump = () => {
      while (n < N) {
        const ok = c.stdin.write(Buffer.concat([hd, frame(n)]));
        n++;
        if (!ok) { c.stdin.once('drain', pump); return; }
      }
      c.stdin.end();
    };
    pump();
    c.on('exit', (code) => { try { if (code === 0) fs.renameSync(part, file); } catch (e) { /* below */ } resolve(code === 0 && fs.existsSync(file)); });
  });
}

module.exports = { ensureClip, W, H, FPS, SECS };
if (require.main === module) {
  const out = process.argv[2] || path.join(os.tmpdir(), 'lumen-playerbar-testclip.mp4');
  const t0 = Date.now();
  ensureClip(out).then((ok) => { console.log((ok ? 'made ' : 'FAILED ') + out + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'); process.exit(ok ? 0 : 1); });
}
