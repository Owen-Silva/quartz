# Changelog

This is the record of what changed in the browser, written so you can catch up without reading
diffs. Everything below landed overnight, commit by commit, on the local `master` branch (the table
at the end lists them; `git log --oneline` is always current) — there is no
remote, so the repo in `C:\Users\you\browser` is the only copy. Run it with `npm start` or the
taskbar pin; a copy that is already open keeps running the old code, so close it and launch again —
or use Restart browser in Settings → About — to pick any of this up.

## What's new, by area

### Claude tabs

- A Claude tab now carries a working folder. Shift+click the Claude button, press Ctrl+Shift+`, or
  use the bare-strip menu to pick one through the native dialog; the tab title is the folder name.
  A folder that has been deleted or mistyped falls back to the default rather than failing the tab.
- Settings has a Claude section: a default folder with a picker and validation, a resume switch,
  and a skip-permissions switch.
- Claude tabs skip permission prompts. Every chamber starts
  `claude --dangerously-skip-permissions`; Settings → Claude has a "Skip permission prompts"
  switch, on by default, and with it off a new tab starts plain `claude`. pty.js allowlists the
  flag alongside `--continue` and `--resume`, and the Enter-to-restart path keeps it through a
  pushed pref.
- Resume a conversation opens Claude Code's own picker, from the strip menu, the Claude chip menu,
  Ctrl+click on the Claude button, or the command palette. Restarting after the picker does not
  re-pass the flag.
- Claude tabs survive a restart. They are saved with their folder and come back as fresh sessions
  launched with `--continue` when resume is on.
- Needs-you indicator: a hidden or unfocused Claude tab that goes quiet after a burst of output
  gets an amber pulse and glyph, the Claude button pulses with it, and there is an optional Windows
  notification. It clears when you activate the tab or focus the window.
- Ask Claude about this: Ctrl+Shift+K or the page context menu hands the page URL, and whatever is
  selected, to a Claude tab stood up beside the page. The text is pasted into the input box unsent,
  and queues until the session is quiet if it is still booting.
- Show Claude this page: Ctrl+Alt+K, the page context menu, the tab menu or the command palette
  takes a screenshot of the page into Downloads and pastes its path, unsent, into a Claude tab
  beside the page, so Claude can look at what you see.
- Ask Claude about this article: Ctrl+Alt+Shift+K, the page context menu, the tab menu or the
  command palette reads the page through Reader view and pastes the article's own text — up to
  12,000 characters of it, quoted and unsent — into a Claude tab beside the page, so the session
  can summarise or answer without going to fetch the page. A page with no article in it says so
  and falls back to sending the link.
- A Claude tab can sit beside a page in split view — Ctrl+Shift+\, Alt+click the Claude button, or
  the chip menu. The terminal refits when you drag the divider.
- Recent Claude folders: the last eight folders a session actually started in are remembered, so
  the bare-strip menu lists the top five as "Claude in <folder>" (full path on hover) and the
  command palette offers every one of them — one click instead of the folder picker. The default
  folder from Settings is always in the list, and it all survives a restart.

### Tabs

- Drag tabs to reorder, including into the outermost slot.
- Right-click a tab for Duplicate, Move to workspace, Close, Close other tabs, Close tabs to the
  right, Reopen closed tab, and Sleep/Wake. The bare strip has its own menu.
- Pinned tabs: icon-only, held in a left group, drag-clamped, and remembered across restarts.
- Audio: a playing or muted tab shows a chip glyph you can click to mute.
- Sleeping: idle background tabs detach their webview and keep a placeholder, waking when you
  activate them. Pinned, audible and new-tab pages never sleep. The delay is in Settings → Tabs.
- Split view pairs the active tab with the next one (Ctrl+\) without re-parenting the webviews, so
  nothing reloads. The divider drags and focus follows whichever side you click.
- Workspaces: named and coloured, shown in the strip and in a titlebar pill with a switcher
  popover for switch, rename, recolour, delete, create and move. Tabs remember their workspace and
  the session persists the lot.
- Tab search (Ctrl+Shift+A) filters open tabs and recently closed ones as you type.
- Command palette (Ctrl+K, or a `>` prefix in tab search) lists 30+ of the browser's own verbs with
  keycaps that read your current bindings.
- Crash and unreachable-site cards replace the blank page when a guest dies or a load fails.
- Popups open as tabs again, which is what fixed "Add another account" in Gmail doing nothing. Two
  failures were stacked: the `new-window` DOM event app.js listened for was removed from
  `<webview>` in Electron 22, so that listener had been dead code, and `will-attach-webview`
  stripped `allowpopups`, so Chromium killed every `window.open` and `target=_blank` before any
  handler could run. Only `target=_top` navigations worked, which is why the rest of Google was
  fine. Guests keep `allowpopups` now, and main's `setWindowOpenHandler` denies the popup window
  and sends `open-url` to the chrome, which opens a tab — a background tab for background-tab
  dispositions. `javascript:`, `data:`, `file:` and custom schemes stay blocked, and the rest of
  the guest hardening is untouched. All nine popup cases on a test page open a tab. Known limit:
  the new tab has no `window.opener`, so an OAuth popup that posts a result back to its opener
  still will not work.

### Address bar and pages

- History suggestions in the omnibox, with keyboard navigation.
- A full history page on Ctrl+H: search, day groups, remove single entries, and clear the last
  hour, today or everything.
- Find on page (Ctrl+F) with a live match count.
- Reader view (Ctrl+Shift+R) parses the article in the chrome and pushes it into a glass reading
  page with adjustable text size and column width that follows the theme.
- Site info popover behind the lock button: connection state, per-permission Ask/Allow/Block, zoom
  controls and a two-step clear-site-data button.
- Per-host zoom is remembered and shown as a badge; Ctrl+= / Ctrl+- / Ctrl+0.
- Print the active page through Chromium's own preview (Ctrl+P).
- Screenshot the page into Downloads (Ctrl+Shift+S).
- Picture in picture (Alt+P) for any page with a video.

### Blocking and privacy

- Ad and tracker blocking through Ghostery's engine, with a shield button in the address bar
  carrying a blocked count and a popover for per-site and global toggles. The allowlist is written
  as engine exception filters; cosmetic filtering is kept out of the chrome.
- Site data can be cleared per site from the site info popover, behind a two-step confirm.
- Permissions are persisted per origin in `permissions.json` and are deny-by-default; the site info
  popover is where you change or reset them.

### Look

- Light and dark themes, plus a site theme setting that follows through to pages.
- Palette presets — ember, forest, ocean, midnight and mono — stamped before first paint, applied
  to the chrome, the new tab page and the circuit board's colours alike.
- An accent hue slider that still wins over a preset if you set one.
- New tab backgrounds: aurora only, or your own picture (downscaled and kept in IndexedDB), with a
  board-over-image switch and a dim slider.
- Bookmarks bar under the address bar, toggled with Ctrl+Shift+B.
- Browser style: your own stylesheet for the browser UI itself, persisted and appended last.
- Per-site styles: per-host CSS, per-host scripts and a force-dark mode with already-dark
  detection, global or per host.
- Settings (Ctrl+,) is now sectioned: Look, New tab, Tabs, Claude, Site styles, Shortcuts,
  Downloads, Privacy and About, with a Find a setting box at the top that narrows the panel to
  whatever you type.
- Contrast and copy pass: the muted foreground now clears 4.5:1 on panel grounds in both themes,
  captions are sentence case throughout, and the split divider is visible in light.
- Instrument glass: a design pass over the chrome, the panes and the bundled pages. A container
  (the omnibox slot, the active chip, a popover, a pane) is bevelled, `corner-shape: round bevel
  round bevel` cutting two corners on the diagonal, inside an `@supports` so a build without it
  keeps plain rounded corners. Controls keep ordinary round corners at `--radius-ctl`, so the
  bevel stays a container signature.
- Those containers wear a 1px lit rim, specular at the top left falling to the accent at the
  bottom right. It is painted as a masked ring on a pseudo-element, because the same gradient run
  as a border-box layer under translucent glass washes the whole interior: it took the omnibox's
  placeholder with it. An `<input>` has no pseudo-element of its own, so the omnibox's ring is
  anchor-positioned from `.navrow::after`, and the two-layer trick over an opaque interior is left
  as the fallback where anchor positioning is missing.
- Status reads as light. A live or playing dot is a pip that glows rather than one that is
  painted, and amber keeps its two strengths: a live Claude session, and a brighter flash for one
  waiting on you.
- Section rules fade out instead of ruling all the way across, readouts are set in Bahnschrift at
  `font-stretch: 87.5%` with tabular numerals, focus rings are lighter, and every state change is
  stepped.
- New tokens, each built out of the theme tokens with `var()`, so one definition covers dark,
  light and all six palettes: `--bevel`, `--bevel-lg`, `--radius-ctl`, `--rim`, `--rim-focus`,
  `--rim-soft`, `--pip-glow`, `--pip-amber`, `--pip-amber-strong`, `--seam-v` and
  `--readout-stretch`.
- Light theme fix: a switch row's label inherited the row's animating colour, so for the first
  step after a theme flip it sat on the old theme's `--fg` and went near-white on the white pane.
  The label names its own colour now, and repeats the row's hover, on and disabled states.
- A reloaded new tab page keeps the theme it is looking at. The chrome pushes theme, settings,
  background and recents again on every `dom-ready`, so F5, a crash reload or a script reload no
  longer brings back the theme and settings the tab was created with.
- Instrument glass, pass two. What survives of it is the new tab page — the live modules below and
  the board changes under them. The chrome was recut as deep glass ruled by three horizontal lines
  (a specular hairline at the top, an edge hairline between the titlebar and the nav row, and the
  lit seam), with flush segment tabs, plain back/forward/reload glyphs and shield, theme and
  settings gathered into one segmented cluster. The tab strip went back to the pass-one chips in
  ca3256b, and the rest of the chrome was reverted in 97267eb at the user's request: the chrome is the
  pass-one look again.
- The eleven pane and popover stylesheets were recut the same way — a 44px header with a 14px/600
  title and the close glyph at the right, a 2px seam lamp along the top edge, 13px body, 12px
  captions, 36px rows, 32px buttons, 16px gutters and 6px scrollbar thumbs — and were reverted in
  97267eb with the chrome. Each pane keeps its own header again, and rims are masked rings on a
  pseudo-element either way, the rule from pass one.
- The new tab seats two live glass modules on the circuit board: a clock, updated once a minute
  rather than on a per-second timer, and a session readout of tabs open, Claude sessions and
  Spotify auto-pause (Off, On or Holding). The chrome feeds it through
  `window.__applyReadout({tabs, claude, autopause})`. "Holding" means something is holding Spotify
  through the bridge, which can be another source — the LessonPlayer desktop app, say — and not only
  this browser.
- The board pauses only when the real window loses focus. It used to freeze whenever a page inside
  a tab took focus, because the chrome document's own blur was being read as the window's; main
  sends `win:focus` from the BrowserWindow's focus and blur now. The board also resumes on
  `visibilitychange`, `pageshow` and `focus`, and a 2-second watchdog restarts the frame loop if it
  has stalled.
- The dark theme is a neutral charcoal now. The user asked for less neon and less glow — "less ai
  slop", and for the browser to feel premium. The dark ground moves from blue-black ink (`#05060a`)
  to charcoal (`#1a1c20` / `#212429`) in every palette; the lit gradient rims end on the plain edge
  colour, so a container is drawn with hairlines at 11% and 14% instead of a lit edge; the sheen
  wash is a flat 3.5% tint; the accent desaturates (`#7dd3ff` to `#72adca`, and the palettes with
  it) and its glow tokens halve; pips lose their halo; the omnibox and the new-tab field trade a
  28px focus bloom for a 3px ring, which leaves focus as the only thing that glows; the seam and
  chamber lamps drop to 14–16% and the text-shadows go. `--fg-2` and `--fg-3` lift to keep 4.5:1 on
  the raised grounds (lowest measured 4.55:1, on a highlighted row). The circuit board paints on
  the same charcoal, with traces at half contrast, vias and pads at half, and packets as plain dots
  with no bloom or tail. The light theme block is untouched.
- The accent hue slider follows the same calming. Its track is a muted spectrum — 42% saturation at
  52% lightness, down from 85% at 58% — with the thumb still showing the chosen accent, and a
  custom hue now derives at the dark theme's own strength (45% saturation, 62% lightness, and the
  alphas chrome.css authors) instead of `hsl(H 100% 75%)`, so dragging the slider no longer brings
  the neon back. Light keeps its own values, and newtab-theme.js matches.
- The aurora holds still. It used to step 120 times a minute under every `backdrop-filter` surface;
  the pool and rim gradients are static in both the chrome and the new tab now. It costs less (see
  Performance) and it is the calmer look he asked for.
- Live system stats on the new tab. The search field is gone at the user's request — he searches from
  the address bar — and in its place, inside the same capsule, is an instrument strip: CPU, memory,
  disk, network in bits per second (down and up) and GPU, each a tabular value with a sentence-case
  label and a 60-sample history graph. The numbers are real, not a demo: CPU from `os.cpus()`
  deltas per core, memory from `process.getSystemMemoryInfo()`, and disk, network and GPU from one
  long-lived `typeperf` child streaming the same Windows counters Task Manager reads. Sampling runs
  only while a new-tab page is the active tab and the window is focused, and the counter process is
  killed 5 seconds after the last subscriber. It costs 0.55% of a core in main plus 0.42% for
  typeperf while someone is looking, and 0% otherwise.
- A moving picture can be the new tab's background. Settings → New tab → Moving picture takes an
  mp4, webm, mov, m4v or gif, copies it into `userData/backgrounds` (512 MB cap) and plays it muted
  on a loop, full-bleed under the dim overlay, with the board-over switch putting the circuit board
  over it as a texture if you want it. The clip pauses whenever the page is not in front — a pane
  open, the window behind, the page hidden, the tab switched away — and plays again on the opposite
  events. A file Chromium cannot decode falls back to the board silently. Cost: a 1080p clip
  playing is 26% of a core against the board's 18%, and 1.4% paused. It has no audio, so the tab
  chip shows no speaker and Spotify auto-pause never holds for it.

### Shortcuts

Every default can be rebound in Settings → Shortcuts except Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1–9,
Escape and F12. New or changed defaults from tonight:

- Ctrl+Shift+A tab search, Ctrl+K command palette, Ctrl+H history page, Ctrl+J downloads.
- Ctrl+\ split view, Ctrl+Shift+\ Claude beside the page, Ctrl+Shift+K ask Claude about this page.
- Ctrl+` toggle a Claude tab, Ctrl+Shift+` new Claude tab in a folder you pick.
- Ctrl+Shift+E workspaces, Ctrl+Alt+Left / Ctrl+Alt+Right to cycle them.
- Ctrl+Shift+R reader view, Ctrl+Shift+S screenshot, Ctrl+Shift+B bookmarks bar, Ctrl+P print,
  Alt+P picture in picture, Ctrl+D add the page to the new-tab chips, Ctrl+, settings.
- Ctrl+R is an alias carried on Reload, so it follows Reload wherever you move it.

Only the rows you changed are stored. A combo somebody already holds asks for a second press before
it displaces the other action, and the displaced one is left unbound and named.

### Downloads

- A shelf with a progress ring, saving without a prompt by default.
- Ask where to save, through the native Save dialog, as a setting.
- Open folder button, and a Downloads section in Settings.
- Ask Claude about this file: a finished row hands its path, unsent, to a Claude tab beside the
  page you are on — Claude Code reads files and images off disk, so nothing is uploaded.

### Spotify auto-pause

- Settings has a Spotify section, driving the auto-pause helper already installed at
  `~/spotify-autopause`. The browser is only a client of it: nothing in that folder is written
  from here.
- The switch is for the whole computer. On enables the `SpotifyAutoPause` scheduled task and runs
  it; off ends it and disables it, because the task carries a repeating keepalive trigger and one
  that is merely ended restarts itself within minutes. Where the task is missing, the switch
  launches the bridge directly and remembers the choice.
- This browser's own tabs hold Spotify paused too, behind a second switch, "Also pause for videos
  in this browser", with a line under it counting the tabs playing right now. A tab making sound
  on a watched site (YouTube, Twitch, Kick, Vimeo, Dailymotion, TikTok, Netflix, Hulu, Disney+,
  Prime Video, Max, Peacock, Crunchyroll and the LessonPlayer sites out of the box; Twitch was the
  first miss the user hit, so the list grew past the extension's), or any tab at all with "Any tab
  that makes sound" on, registers a hold at the bridge on
  127.0.0.1 (the first free of ports 8787 to 8790) under its own `src=owen-browser`, so the two
  browsers can never release each other's hold. The hold refreshes every 60 seconds and is handed
  back 1.5 seconds after the sound stops, or on quit. Spotify's own web player never counts as a
  video.
- A readout under the switch says what is actually true, down to the port and whether Spotify is
  open, and "Check health" runs the helper's own `doctor.ps1` and prints the report without
  changing anything.
- Verified live: a tab making sound registered `owen-browser` at the bridge within five seconds
  and released the hold when it closed.

### Performance

Measured on this machine overnight: cold start is about 550ms from launch to a booted chrome. A
page tab costs 100–150MB resident, which is Chromium's per-site renderer; a sleeping tab hands that
back, and two sleeping tabs returned about 240MB between them. Idle cost is almost entirely GPU
compositing, which is why the circuit board now freezes both under any open chrome pane and
whenever the window loses focus — with it frozen and no page animating, the only remaining cost was
the aurora's stepped keyframes, and those are gone too.

A measured pass over the whole thing, each change profiled before and after on its own test
instance:

- Claude tab resizes. Every window or pane resize pushed a ConPTY resize even when the column and
  row count had not changed, and each one made `claude.exe` repaint its whole TUI. `safeFit` and
  `startPty` cache the pushed grid and skip no-op resizes: a 20-resize storm went from 20 redraws
  to 0, and a real column change still repaints.
- Session snapshots in main. The snapshot the chrome sends on every tab change was a synchronous
  write plus rename on the main loop: 300 snapshots kept main busy for 1367ms with a p99 loop lag
  of 1169ms. Async, single-flight and newest-wins makes it 206ms busy and 129ms p99, with a
  synchronous flush on `before-quit` so quit and Restart browser still persist the last state.
- PTY output. A 2MB flood was 19,774 IPC sends, one per ConPTY chunk. A 16ms window with a 64KB cap
  coalesces them to 305 — byte-identical, first chunk still immediate, flushed on exit.
- Guest navigation reads in the chrome. `webview.getURL`, `canGoBack`, `canGoForward` and
  `getZoomLevel` are synchronous IPC to main, and a tab switch made six of them. A per-guest cache,
  invalidated on every navigation event, drops script time per switch from 11ms to 3.5ms and long
  tasks from 5 to 2 over 40 switches. Pushes to guests are memoised to one IPC per real change, and
  session writes flush on `beforeunload`: an open-and-close cycle goes from 20ms to 14ms of script.
- The site info seat. `getBoundingClientRect` self time over 40 tab switches was 94–97ms and is now
  7–8ms, with layouts down from 70 to 38. The seat is measured once and re-measured only when the
  row's geometry can have changed — a ResizeObserver on the omnibox and the nav row, one re-measure
  per frame after a child mutation, and on load, `fonts.ready` and a theme swap.
- Compositing. The pips that pulse inside frosted rows get their own layer, and the board's
  vignette is painted into the canvas alpha instead of masking a full-window layer that re-masked
  as packets moved. New tab with the board running: 30.8% of a core and 5.08ms per frame before,
  27.3% and 4.69ms after. One idle Claude tab: 20.3% and 3.38ms per frame before, 13–15% and 2.21ms
  after.
- The aurora. Its pool and rim gradients stepped twice a second under every `backdrop-filter`
  surface — the Settings pane, the new-tab field, chips and modules — re-blurring each of them on
  every step, about five points of a core whenever a Claude tab was open. They are static now and
  the keyframes are gone.

Measured and left alone:

- `@xterm/addon-webgl` drained a 2MB flood 1.33x faster with 1.9x better frame gaps, but moved the
  cost into the GPU process. That is below the 2x gate for taking on a dependency, so it was
  uninstalled; the DOM renderer still drains 2MB in about 15s with 34–50ms p95 frame gaps.
- Chromium command-line switches. Nothing tried measured as a win, so none were added.

Found, and not ours to fix:

- Every `<webview>` removal throws Electron's `Invalid guestInstanceId`. The guest is destroyed
  first, guest-view-manager drops the registry entry on its `destroyed` event, and then the
  element's queued `disconnectedCallback` sends a detach that `getGuestForFrame()` rejects. A bare
  one-webview Electron 44 app throws the same error and five teardown orders all still throw.
  Nothing leaks without a debugger attached; with DevTools attached the stored exception pins each
  closed tab until the console entries are discarded. It is written down at `closeTab` and
  `sleepTab`; the fix belongs upstream.
- The flicker on Settings open and on the new tab could not be reproduced headlessly — the guest
  neither repainted nor relaid out, and the only frame differences were the caret blink and blur
  rounding. The aurora was the one thing moving at rest in both places, so stilling it is the
  likely fix rather than a proven one.

### Security notes

- The webview attach hook overrides every preference a guest could ask for and strips the
  attributes those switches ride in on.
- Page-initiated `file:` navigation is cancelled; typing a `file://` path in the omnibox still
  works.
- Screenshot reveal is confined to the Downloads folder.
- Download URLs are scheme-allowlisted to http, https, blob and data.
- Permissions are deny-by-default, and "open another app" is asked every time and never remembered.
- The reader sanitises twice — once in the chrome, once over the live tree — to close the mXSS gap.
- PTY arguments are allowlisted to bare `--continue` and `--resume`; a bad argument costs a resume,
  never the tab.
- The PTY environment is scrubbed of `CLAUDE*` variables so a launched session does not think it is
  a child of this one.
- The shortcut map sent to main is size-checked and validated.

### Developer tooling

- The project is a git repo now, with the whole night's work committed locally.
- `node smoketest.js` launches its own instance on `--test-profile`, waits for `body.booted`,
  asserts, and tears down. `--keep` leaves it running. `cdp-eval.js` and `cdp-profile.js` drive it.
- The README is current through the last commit: shortcuts, features, security notes, performance
  numbers and a file-by-file map.

## Things to know

- A forced kill can lose the last few seconds of tab state. A normal close cannot — the strip is
  written both to `localStorage` and to `session.json` in the profile, and that file is written to a
  temp name and renamed, so a kill mid-write can only destroy the temp.
- Restored Claude tabs are not the same live session you left. They come back as fresh sessions
  launched with `--continue` in the same folder.
- Opening a Claude tab in a folder Claude Code has not run in before shows its trust prompt first.
  That prompt is Claude's, not the browser's.
- The ad-block engine is fetched on first run and cached in the profile as `adblock-engine.bin`, so
  the first launch after clearing the profile is slower and needs the network.
- Screenshots go straight to the Downloads folder; nothing outside it can be revealed from the app.
- Workspace switching is Ctrl+Alt+Left and Ctrl+Alt+Right. Ctrl+Shift+E opens the switcher popover;
  Ctrl+Shift+W was left alone because it closes the window everywhere else.
- If a browser style you wrote breaks the UI, Ctrl+Alt+Shift+R resets it from anywhere.
- Anything started with `--test-profile` uses `%TEMP%\browser-test-profile` and never touches the
  real profile at `%APPDATA%\browser`.
- Restart browser — Settings → About, or the command palette — flushes the session and window
  state, releases any Spotify auto-pause hold, and relaunches with the same arguments and the tabs
  restored. Use it after pulling an update: code changes only take effect after a restart.
- Maximised, a 2-3px band of bare acrylic shows at the left, right and bottom edges. It is the
  native resize border Windows keeps around a window using the acrylic material, outside the
  document, so no stylesheet reaches it; fixing it would cost either the acrylic (`frame: false`
  renders it black) or native snap and restore, so it is left alone. The measurement is written
  down in main.js.
- The Spotify section needs the separate helper installed at `~/spotify-autopause`. Without it the
  switches are drawn but disabled and the readout says "Not installed on this computer", rather
  than claiming something is running.
- The new tab's stats need Windows' `typeperf` and its English counter names. On a Windows
  installed in another language the disk, network and GPU figures show a dash; CPU and memory come
  from Node itself and read the same everywhere.

## Commits

Times are local. 21:26 through 23:54 are 10 September; 00:29 onward are 11 September.

| Hash | Time | Summary |
| --- | --- | --- |
| 01358c3 | 21:26 | Initial commit: glass Electron browser with Claude tabs, themes, circuit-board new tab |
| c793070 | 21:42 | Find in page, downloads shelf, history suggestions, context menus, permission prompts, fullscreen |
| 41be354 | 22:00 | Settings panel, accent colour, search engines, site theme, tab drag/menu, crash cards |
| 230121f | 22:21 | README and QA note on the drag-region right-click |
| cc01d53 | 22:40 | Ad/tracker blocking with shield, tab audio and pinning, zoom badge, new-tab recents |
| a7ba15e | 22:53 | Claude tabs with a chosen folder, conversation resume and restore; durable session; print |
| 1e5bfa5 | 23:15 | Tab sleeping, per-site styles with force dark, reader view |
| 37fc4f0 | 23:42 | QA fixes: drag reaches the outermost slot, Ctrl+Shift+R replayed from pages; README for rounds 4-6 |
| d35c505 | 23:54 | Palette presets (ember, forest, ocean, midnight, mono) and tab search |
| e60cebd | 00:29 | Site info popover with persisted permissions and site-data clearing, split view, site scripts |
| 10cf854 | 01:05 | New-tab backgrounds (aurora only, your image), QA fixes, README for rounds 8-9 |
| a23d9ac | 01:19 | Claude beside a page in split view, page screenshots, bookmarks bar, board pause under overlays |
| eba95ac | 01:45 | Claude needs-you indicator, command palette, README for rounds 10-11 |
| e157a7a | 01:59 | Ask Claude about this, history page, picture in picture |
| 81f81a5 | 02:19 | Customisable keyboard shortcuts, README for rounds 12-13 |
| e2e2bca | 02:42 | Shortcut fixes from QA: Ctrl+R alias kept in bindings, shifted-punctuation lookup in main, hint text for fixed rows |
| 5ecff29 | 03:01 | Workspaces, downloads save-as and open folder, more palette commands |
| 7c7598b | 03:38 | QA and design pass over rounds 14-15 |
| 518d263 | 04:04 | Resume a Claude conversation, security hardening, performance audit |
| 9cb9fba | 04:19 | Browser style (user CSS for the chrome), board freezes on window blur, README for round 17 |
| c384475 | 04:26 | Show Claude this page (screenshot handed to a Claude tab), CHANGELOG |
| ec8366f | 04:38 | Ask Claude about this article (readable text, capped), paste waits behind Claude's prompts |
| 382f1fd | 04:52 | Settings filter box |
| 69599f5 | 04:52 | CHANGELOG: settings filter |
| 18b55a7 | 06:07 | Recent Claude folders in the strip menu and palette; README for rounds 18-21 |
| 19c5c2b | 06:07 | CHANGELOG: intro no longer hardcodes the commit count |
| 33d4fac | 10:51 | Ask Claude about a downloaded file; chambers open synchronously on activation |
| 627b163 | 11:40 | Instrument glass: bevelled containers, light rims, pips, readout type |
| 23f7b31 | 11:44 | Spotify auto-pause in the browser; new tab keeps live settings across a reload |
| 34d7bbe | 12:19 | Spotify auto-pause: Twitch and other video sites watched by default; saved lists take new defaults |
| ba743da | 12:35 | Spotify auto-pause: a muted tab hands the music back |
| 149a033 | 13:08 | Instrument glass, pass two: ink chrome, segment tabs, live new-tab modules, one pane header |
| b3d6f41 | 13:08 | Claude tabs skip permission prompts; board follows the real window focus; Restart browser action; new-tab readout |
| db73723 | 13:14 | CHANGELOG + README: design pass two, Claude skip-permissions, Restart browser, new-tab readout, edge band note |
| ca3256b | 13:40 | Tab strip back to the pass-one chips; the rest of pass two stays |
| bb53ae4 | 13:41 | CHANGELOG + README: tabs are the pass-one chips again; rows for db73723 and ca3256b |
| 97267eb | 13:50 | Revert the pass-two chrome and pane styling; the new tab keeps its board, clock and readout |
| eeb1e7a | 13:59 | Test runs can name their profile (--profile-name) so parallel instances never share storage |
| 85d66c2 | 14:17 | Popups open as tabs again: setWindowOpenHandler on guests replaces the new-window event Electron removed |
| 8229844 | 14:41 | Dark theme: neutral charcoal ground, hairlines instead of lit rims, glow only on focus, restrained accent |
| bb996ac | 14:41 | Settings: the accent hue slider track is a muted spectrum, not a saturated rainbow |
| 039acec | 14:49 | Claude tabs: a resize that does not change the grid no longer resizes the pty |
| 1b09e9e | 14:54 | Main process: session snapshots write async and single-flight; pty output reaches the renderer once per frame |
| fe3b38b | 15:04 | Chrome: guest navigation reads are cached, pushes to guests are memoised, session writes flush on unload |
| b22bd58 | 15:06 | Settings: a custom accent hue derives at the calmed dark-theme strength |
| 18cd4ad | 15:28 | Site info: the button seats itself from cached row geometry instead of measuring on every tab change |
| 8fcba52 | 15:43 | app.js: note why every webview removal throws Invalid guestInstanceId (Electron, uncatchable, harmless) |
| ce6916a | 15:55 | Compositing: pips get their own layer; the board vignette is baked into the canvas instead of a full-window mask |
| a146cfa | 15:56 | The aurora holds still: no more twice-a-second nudge under the frosted surfaces |
| ea4fd57 | 16:50 | Chrome: subscribe to system stats only while a new-tab page is in front, and push each sample to that guest |
| 9776f1c | 16:59 | System stats sampler: CPU, memory, disk, network and GPU from the OS and Windows performance counters, only while asked |
| b9f5ca2 | 17:04 | New tab: live system stats replace the search field |
| dbc8744 | 17:07 | Settings: a Moving picture background, chosen from a file and copied into the profile |
| d8572e5 | 17:18 | New tab: a Moving picture plays behind the board, muted, and pauses whenever the page is not in front |
