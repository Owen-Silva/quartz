# Phone mirroring — optimize plan (lane P5, 2026-09-13, READ-ONLY analysis)

Baseline (measured live today): Tailscale-on-LAN 7-13 ms; H.264 560×1280 @ 8 Mb/s + opus;
painted 55-59 fps; hw decode ~1 ms; queue 0; 0 dropped; frame age ~20 ms. Raw throughput is
already excellent — the wins are codec efficiency, away/cellular usability, and UI, not latency.

Already done (NOT re-proposed): TCP-RTT auto profile, still≠stall, RESET_VIDEO on drop,
Wi-Fi-change reconnect, paint-in-decoder-callback, decoder warm-up + heal-shed, hw-decode
preference w/ sw fallback, per-viewer occlusion *detection*, clipboard both ways (Ctrl+C/V +
rail buttons, `navigator.clipboard`), keyboard-capture pill (Ctrl+Alt+K) + `keys` readout.

Coordination: the **Screen off/on power path + black lock-screen mirroring** and the
`screenOffWhileMirroring` wiring are an in-flight lane's — DO NOT TOUCH here.
**If the power-bug lane bumps the scrcpy server version, re-pin `SERVER_VERSION`/`SERVER_SHA256`/
`SERVER_URL` in phone.js and re-verify the `video_codec=h265` arg + codec ids against that tag's
`Options.java`/`VideoCodec.java`** (at v4.1 both are confirmed present — no change needed at 4.1).

## Ranked table

| # | Item | Expected gain | Effort | File(s) | Risk | How to verify live |
|---|------|---------------|--------|---------|------|--------------------|
| 1 | **Real Away/cellular ladder** — drop size+fps+bitrate *together* per tier, not bitrate-only. Add away caps (≈960 px / 30 fps) alongside `awayBitrate`; `chooseBitrate()`→`chooseProfileParams()` returns {bitrate,maxSize,maxFps,codec,tier}; `startStream` uses them. Plus a visible **"Away — reduced quality"** badge in the rail/status. | Cellular goes from blocky (2 Mb/s spread over 1280/60 = 0.043 bpp) to genuinely usable; the user always knows they're degraded | M | phone.js (`chooseBitrate` ~1755-1764, server args ~1868-1885, defaults ~478-490, `sanitise` ~590-595, stream state), phone-page.js (badge), settings.js (`renderPhoneQuality` ~4202) | restart flash on tier change (inherent to scrcpy); away caps too aggressive | Set profile=Away; confirm args show the smaller size/fps/bitrate and picture is clean not smeary; `stream.profile` badge shows Away |
| 2 | **H.265 / HEVC opt-in** — `video_codec=h265` behind a Settings toggle, gated by `VideoDecoder.isConfigSupported({codec:'hev1.1.6.L120.90'})` at page load, **auto-fallback to H.264, never silent default**. Page branches on `video.codecName` (already carried in `onStreamMeta` ~837); add `hevcCodecString()` (config = VPS/SPS/PPS, 2-byte NAL, types 32/33/34) or a static `hev1.1.6.L120.90`. | ~½ the bitrate for equal quality (or sharper text at equal bitrate) — the biggest technical lever; compounds with #1 on cellular | M | phone.js (codec arg + `videoCodec` setting + `VIDEO_CODECS` already maps h265), phone-page.js (`ensureDecoder` ~1232-1296, `spsCodecString` ~1226 is **H.264-only**), settings.js | **decode support uncertain on this Win+Chromium 140 box**; phone hw-encode support unknown | Do the `isConfigSupported` check FIRST; then `list_encoders` on the test phone for `hevc`; toggle on, confirm codec readout says h265 + still 55-59 fps + lower kbps |
| 3 | **Fullscreen + fit/100% control** on the stage (currently fit-to-stage only; no fullscreen, no actual-size). `requestFullscreen()` on stage; a fit/100% toggle; Esc exits. | Biggest daily-usability win; makes the phone usable full-window | S | phone.html (control), phone-page.js (`layoutFrame` ~1888, rail), phone-page.css | none material | Click fullscreen → fills screen at true aspect; 100% → 1:1 pixels; Esc restores |
| 4 | **Phone workspace reopens `phone.html` on restart** (known bug: comes back as blank new-tab). | Removes a confusing blank-page + a cold-start every restart | S | app.js (`raiseCurrentWorkspace` ~5021, `restoreSession`/`sanitiseSession` ~7900-8100) — **L3 glue lane** | must keep Ctrl+T = new tab in that workspace | Restart browser; Phone workspace shows phone.html, not new-tab |
| 5 | **Hidden/occluded → pause the SOURCE.** Today `document.hidden` pauses *decode* only; the phone keeps encoding at 60 fps and the wire keeps flowing, and occlusion (`notPainting`) does nothing but warn. Ask main to stop/trickle the stream after hidden or `notPainting` > ~3 s; resume + key frame on return. | Real phone-battery / laptop-CPU / bandwidth savings during normal multitasking (terminal over browser was measured decoding 60 fps, painting 0) | M | phone.js (pause/resume stream cmd), phone-page.js (`onVisibility` ~1955, `tick`/`notPainting` ~1930-1946) | re-show adds a ~1 s restart unless "trickle" instead of "stop" | Cover the window 5 s → `stream` goes idle + says why; uncover → picture back within ~1 s |
| 6 | **Clickable capture pill + canvas capture-glow** (pill is Ctrl+Alt+K-only today). | Cheap clarity: the user sees + clicks where keys go | S | phone-page.js (`setCaptured` ~1697), phone-page.css | none | Click pill toggles keys→phone/browser; canvas rim lights when captured |
| 7 | **Prominent "reconnecting…" banner** (retry logic exists in `scheduleRetry`; surface it big, with reason + attempt count). | No-silent-failures; away-link drops read as "working on it" not frozen | S | phone-page.js (`connectWire`/`scheduleRetry` ~725-798) | none | Drop the link → banner names the reason + counts attempts |
| 8 | **Home bitrate default / presets** — 8 Mb/s at 560×1280 (0.19 bpp) is generous for a phone panel in a window; a "Sharp text / Balanced / Data-saver" preset row over the existing raw selects, default likely **Balanced ≈ 1280 / 6 Mb/s**. | ~25-30% less data at home for no visible loss on a windowed panel | S (UI) | settings.js (`renderPhoneQuality` ~4202) | subjective; text sharpness | **Needs A/B**: side-by-side 4/6/8 Mb/s at window size — pick lowest that keeps text crisp |
| 9 | **Frame-pacing / 1-frame jitter buffer** — painted 55-59 vs sent 58-64: a few frames/s are over-drawn before compositing (`video.skipped`). A rAF-paced 1-frame buffer evens cadence but adds ~8-16 ms latency, undoing the proven paint-on-arrival win. | Marginally smoother cadence | M | phone-page.js (`onDecodedFrame`/`paintFrame` ~1312-1366) | reintroduces the exact latency/drop the paint-on-arrival fix removed | **Needs measurement first**: read `video.skipped`/s and `video.screenHz` (both already computed). If screenHz is 120/144 and skipped low → no problem, SKIP. If skipped ≥2/s steadily → revisit |
| 10 | **AV1** | — | — | — | phone almost certainly has **no hw AV1 encoder** (a midrange phone); sw encode at 60 fps would cook it | **SKIP with reason** — confirm absence in the same `list_encoders` pass as #2 |
| 11 | **File drag-and-drop → phone** (adb push on drop). | Nice-to-have transfer | L | phone.js (push), phone-page.js (drop) | new surface, error paths | Drop a file → lands in phone Downloads with visible progress |

## Recommended first round (once the power-bug lane lands + the user is free)

Implement in file-scoped lanes, split by owner:
1. **#1 Real Away/cellular ladder** (phone.js + phone-page.js badge + settings.js) — biggest *guaranteed* win, no external dependency.
2. **#3 Fullscreen + fit/100%** (phone.html + phone-page.js + css) — cheap, biggest usability lift.
3. **#2 H.265 opt-in** — *first task in the lane is the `isConfigSupported` decode check + `list_encoders`*; only build the toggle if decode passes. Biggest technical lever, gated.
4. **#4 Workspace reopens phone.html** (app.js, L3 glue) — cheap correctness/startup fix.
5. **#5 Hidden/occluded → pause source** (phone.js + phone-page.js) — battery/CPU, if round has room.

Split so no two lanes edit the same file at once: L-main=phone.js, L-page=phone-page.js/.css/.html,
L-glue=settings.js/app.js. #1 spans main+page+settings, so sequence it or hand each file its slice.

## Later / opt-in / measurement-gated
- **#8 bitrate defaults / presets** — do the A/B first, then reframe UI as "Sharp text vs low data".
- **#9 jitter buffer** — decide only after reading skipped/screenHz live; likely SKIP.
- **#6 clickable pill**, **#7 reconnect banner** — tiny polish, fold into any page-side round.
- **#11 file drag-drop** — separate feature round.
- **AV1 (#10)** — skip; log the `list_encoders` result for the record.

## Notes on things that are already good (leave alone)
- Paint-on-arrival + 2D desynchronized canvas + `optimizeForLatency:true` — measured optimal; do not swap for rAF pacing (that's exactly what #9 warns against).
- Idle-fps "drop when nothing moves" — **not needed**: scrcpy encodes only on change, so a still screen already sends nothing. The only idle waste is an *animating* hidden/occluded screen → that's #5, not a per-frame idle cap.
- Clipboard both-ways is fully wired AND surfaced — no work needed.
- adb connection warmth: `autoConnect` already keeps it warm; jar push is skipped on size match — startup is already near-minimal apart from the server JVM boot on the phone (inherent) and bug #4.
