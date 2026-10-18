'use strict';
/**
 * The e2e fixtures' playing video: a synthetic clip, so no test ever serves a real recording.
 *
 * tests/media/lumen-test-clip.mp4 is 30 s of ffmpeg's testsrc2 pattern (640x360, 24 fps, H.264)
 * with a 440 Hz sine tone (AAC, stereo). 30 s, because watch-playview-e2e seeks to 20 s and 15 s
 * and checks J/L's 10 s steps. Made with:
 *
 *   ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=24:duration=30" \
 *     -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" -map 0:v -map 1:a \
 *     -c:v libx264 -preset veryfast -crf 36 -pix_fmt yuv420p -profile:v high -g 48 \
 *     -c:a aac -b:a 48k -ac 2 -shortest -movflags +faststart tests/media/lumen-test-clip.mp4
 *
 * QUARTZ_PLAYER_CLIP points the e2es at another local file (an .mp4) instead.
 */
const fs = require('fs');
const path = require('path');

const CLIP = process.env.QUARTZ_PLAYER_CLIP || path.join(__dirname, 'media', 'lumen-test-clip.mp4');

/** Serves CLIP with byte ranges, the way a video host does (the <video> seeks and loops on them). */
function sendClip(req, res) {
  let st;
  try { st = fs.statSync(CLIP); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, st.size - 1);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 });
    fs.createReadStream(CLIP, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
  fs.createReadStream(CLIP).pipe(res);
}

module.exports = { CLIP, sendClip };
