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
- A terminal chamber can run something other than Claude (528558c). pty.js holds a static PROGRAMS
  table — claude, powershell, pwsh, cmd, python, node and Git Bash — each with fixed arguments and
  its own allowlist: only claude accepts `--continue`, `--resume` and skip-permissions, and the
  shells take no arguments from the renderer at all. Binaries resolve once per process through
  `where.exe` or an absolute path check, and the Store's app-execution-alias stubs are rejected, so a
  missing python reports "not installed" instead of opening the Microsoft Store. `createSession()`
  defaults to claude and throws on an unknown id; main's `pty:programs` answers the chrome only, and
  `pty:start` returns null for an unknown id before it spawns anything. Live on a test profile
  PowerShell, cmd, Git Bash, node and claude all start, pwsh reports not installed, and path-like
  ids, unknown ids and extra arguments are all refused. There is no UI for picking a program yet —
  this is the layer under one.

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
  the guest hardening is untouched. All nine popup cases on a test page open a tab. That left one
  limit, fixed in the next entry: a tab has no `window.opener`, so an OAuth popup that posts a
  result back to its opener could not complete.
- Sign-in popups are real windows again, so Google Sign-In works (38bd224). Converting every popup
  to a tab lost the credential — a tab has no `window.opener`, so the page that opened the popup
  never got the result, and the attempt ended as a white popup page beside a blank placeholder tab.
  The guest's window-open handler now decides by disposition instead of denying everything:
  `target=_blank` links and middle-clicks still open as tabs through `open-url`, and only
  `window.open` with features — the `new-window` disposition, the shape every sign-in flow uses —
  becomes a real child BrowserWindow. It takes its size from the features (clamped), centres over
  the main window, is parented but not modal, is sandboxed with no preload and no devtools, shares
  the session, follows the page's title, has its own links open as tabs in the main window, and
  closes with it. Non-http(s) schemes are still refused. Verified live: Pixabay → Log in →
  Continue with Google opened exactly one popup on accounts.google.com with `window.opener` set,
  no stray tab, and the page behind it stayed intact.

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
- Settings section names read as headings (0df6795). They were 12px in the dimmed text colour, so
  the pane read as one long list; they are full text colour, 13.5px and bold now, with a little
  more room under each title and between sections. The fading rule under each title stays.
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
- The stats sample once a second now, Task Manager's own cadence, at the user's request — the typeperf
  child follows at `-si 1` — so the graphs hold one minute of history rather than two.
- Under the strip, a "Processes" expander. It opens with a chevron (the strip itself is the toggle)
  and unfolds the list inline over 160ms, pushing the chips and Recent rows down; whether it is open
  or closed is remembered across reloads. The rows are grouped the way Task Manager groups them —
  one row per program with its instance count, friendly names for the usual suspects (Claude Code,
  Electron, Windows Explorer, Desktop Window Manager, Service Host) — and each shows CPU as a share
  of the whole machine, private memory, and disk and network bytes. The top 10 by the current sort
  are drawn, Show more takes it to 30, and the sort (CPU or memory, click a header) is persisted.
  Rows keep their identity between samples and update their text in place. End task is a two-step:
  the button arms for 3 seconds and the second press kills every process in the group, and the row
  answers Ended, Protected or That's this browser. The browser's own tree is greyed out and refused
  as self, and a protected list of Windows processes — System, Registry, smss, csrss, wininit,
  winlogon, services, lsass, svchost, dwm, fontdrvhost, Memory Compression, Secure System, MsMpEng,
  SecurityHealthService, audiodg, sihost, ctfmon — is refused too. While the list is collapsed no
  table work happens at all: the samples are kept and not drawn. It was first built as a floating
  pop-out over the strip (bed0643) and replaced with the expander at the user's request, because he
  wanted it to open downwards rather than sit on top of the page.
- Fixed: the dashes for disk, network and GPU on the user's machine while the graphs still had data.
  `typeperf` prints a warning line whenever a counter instance disappears — a process with a GPU
  engine exiting is enough — and the sampler treated any non-CSV line as a failure and nulled those
  fields for a minute. Warning lines and repeated headers are skipped now, blanks count as 0 inside
  sums, a field goes null only after 5 seconds without a valid row, and a dead child respawns in 2
  seconds. Because `(*)` fixes the instance list at spawn time, the child is also replaced every 30
  seconds with an overlap — switch to the replacement on its first row, then kill the old one — so
  processes started after the spawn are counted: 130 consecutive samples across four refresh
  boundaries with no nulls, and a Notepad started afterwards appeared within 20 seconds.
- Fixed: the flicker when Settings opens. It was never in the page — the address bar showed a
  lighter block exactly above the pane's column, and DevTools captures never saw it, because the
  artefact is in Windows' composition of the acrylic window: every repaint of a region re-composes
  that whole column, and the auto-focused Find a setting box repainted its caret twice a second for
  as long as the pane was open. Focus now lands on the panel itself; Tab still reaches the filter
  and Escape still closes.
- A moving picture can be the new tab's background. Settings → New tab → Moving picture takes an
  mp4, webm, mov, m4v or gif, copies it into `userData/backgrounds` (512 MB cap) and plays it muted
  on a loop, full-bleed under the dim overlay, with the board-over switch putting the circuit board
  over it as a texture if you want it. The clip pauses whenever the page is not in front — a pane
  open, the window behind, the page hidden, the tab switched away — and plays again on the opposite
  events. A file Chromium cannot decode falls back to the board silently. Cost: a 1080p clip
  playing is 26% of a core against the board's 18%, and 1.4% paused. It has no audio, so the tab
  chip shows no speaker and Spotify auto-pause never holds for it.

### Apps, process icons and YouTube

- Installed apps are indexed once. A new apps.js reads the Start Menu shortcuts (each `.lnk`
  resolved through `shell.readShortcutLink`, a 32px icon from `app.getFileIcon`) and the packaged
  apps from one `Get-StartApps` run, then caches the merged list as `apps-index.json` in the
  profile for 24 hours. On this machine that is 150 apps, 69 executables and 81 store apps, with a
  cold build of 1.2 seconds and a manual refresh of 3.2. Main exposes list, launch, focus and
  refresh: launching goes through the shortcut or `explorer shell:AppsFolder`, and focusing
  restores and raises the process's own main window rather than starting a second copy.
- A dock of pinned apps on the new tab. In the capsule above the web chips, each pinned app is a
  56px tile: a 32px icon, the name under it, and a dot at the icon's corner while the app is
  running. One row is always reserved so the capsule's height never jumps, and it grows for more
  pins (two rows at 393px wide, three at 320px). A click launches the app, or focuses it if it is
  already running. Edit mode puts a remove glyph on every tile and adds a "+ Add app" tile that
  opens an inline picker over the installed list, eight results at a time, arrows and Enter. A
  failure shows as a short note on the dock rather than nothing happening. Pins are ids only,
  normalised and capped at 32 in the `apps` group of `localStorage['settings']`, so a pin for an
  app that has been uninstalled costs nothing and comes back if it is reinstalled. Dock clicks no
  longer fall through to the Processes fold under them.
- The command palette opens apps as well. The `>` list grows an "Open <name>" row for every
  installed app, built the first time it is asked for rather than at boot. Apps that are running
  sort to the top and read "Running, switch to it", and those rows focus the window instead of
  launching it again. Running state comes out of the stats samples the Processes list already
  needs, diffed against the sampler's top-process keys and pushed to the new tab only when it
  actually changes.
- Process icons in the Processes list. Every row gains a 16px icon slot to the left of the name,
  8px in front of it: the real icon of the executable behind that group once the chrome has one,
  and until then, or when there is none, a neutral window outline glyph at `--fg-3`. A new
  procicons.js in main resolves them cheapest first: the browser's own groups from
  `process.execPath`, then the app index, then zero-spawn guesses under System32, SysWOW64 and
  Windows checked with `fs.access` (34 of 99 real process names answered that way in 19ms), then
  one debounced `Get-Process` batch keyed by pid (500ms debounce, one in flight, never more than
  one spawn every 10 seconds), and last `app.getFileIcon` at 32px as a data URL. Answers are kept
  in memory and in `proc-icons.json` in the profile, written to a temp name and renamed, capped at
  300 entries, nulls retried after an hour and paths re-checked after a day. The chrome collects
  the keys it is missing once per sample, asks at most one request at a time and one every 3
  seconds, holds its own 300-entry cache, and pushes the whole cache to a new tab page on
  `dom-ready`. Drawing is deliberately dull: samples do no icon work, the src for a key is written
  once, a null answer never removes an icon already on screen, and the placeholder rows keep the
  same slot width so nothing shifts. Both themes, no shadow and no glow. The apps dock above it is
  untouched.
- Fixed: YouTube's player spinning forever with blocking on (f4d8ca1). Clicking a video on YouTube
  is a same-document navigation, so the player is built from a fetch rather than from a fresh
  document — which is why a reload always seemed to fix it, the reload taking the document path
  where the player response arrives inline. The first attempt (cf86935) added two exception
  filters, `@@||youtube.com/youtubei/` and `@@||youtube.com/api/stats/`, because the ads and
  tracking lists were cancelling two of YouTube's own calls. Those filters are harmless and stay,
  but they were not the cause. The cause is the scriptlets: the ads list carries scriptlet rules
  for youtube.com (json-prune, replace-fetch-response, prevent-xhr) that the adapter injects with
  `executeJavaScript` to strip ad fields out of the player response, so after an in-page click the
  SPA fetches the next video through the patched fetch, gets a rewritten body back, and the player
  never builds — `ytd-player` in the DOM, no `#movie_player`, no video — until a reload. The
  cosmetics lookup now answers an empty script list for youtube.com and its subdomains; the
  cosmetic CSS and every network rule still apply, so ad delivery is unchanged and `/pagead/`,
  doubleclick and googlesyndication still block. Measured live from a search results page, 20
  seconds a round: stock 0 of 5 videos played, exception filters for every blocked URL 0 of 3, a
  whole-page exception 0 of 3, blocking off 3 of 3, scriptlets off for youtube.com 5 of 5. An
  in-stream ad can still play, exactly as it already did on the reload path — this fixes the player,
  it does not skip ads. The "Script failed to execute" rejections in the main log were those same
  injections losing the race; they stop with the scriptlets. The Electron user agent is left exactly
  as it was; nothing here pretends to be Chrome.
- The command palette lists apps on a plain search too (7e637cd). "Open <name>" rows used to appear
  only in command mode; a plain query now shows up to five matching apps under an "Apps" caption,
  after the tab and recently-closed rows, and the empty note reads "No matching tabs, apps or
  history". The dock's running dot also failed contrast in the light theme at 4.18:1 on the tile; a
  new `--ion-dot` token — the accent darkened 21% in light, unchanged in dark — lifts it to 6.1:1
  and follows palettes and custom accent hues.
- Focus lands on the right window (439cdd5). `apps:focus` had been scanning same-name processes for
  a main window, which fails for every console app — their window belongs to the console host — and
  could raise a different instance entirely. It now enumerates visible titled top-level windows by
  pid, then the console window attached to that pid, then a conhost / Windows Terminal /
  OpenConsole child of it, and never falls back to another pid. In the same pass: the shortcut noise
  filter (release notes, manuals, uninstallers, website links, document targets) now applies to the
  `Get-StartApps` half as well, so 150 entries become 131 on this machine; Store entries pick up
  their exe name from the package manifest in the same PowerShell run, 48 of them gaining one
  (notepad.exe, calculatorapp.exe, mspaint.exe and the rest), so they can show a running dot at
  all; x86 twins are flagged and sort after their x64 sibling; and the index cache is version 2, so
  the old one is rebuilt. Build 1.4s warm, 3.4s cold.
- Review fixes on the dock and its chrome side (a95db9d, 91a3b66). The "+ Add app" tile was hidden
  the moment the first pin landed while its picker was still open, leaving no way to close the
  picker with the mouse; it stays while the picker is open now. Typing in the picker changes its
  height, so the capsule height is settled on each filter instead of re-seating the board. Escape
  returns focus to the Edit control rather than the tile it just hid. On the chrome side, an
  `apps:list` answer already in flight could overwrite an index a refresh had just rebuilt, so a
  newly installed app vanished until the next refresh — the pending promise checks it is still the
  awaited one. `apps:refresh` resolves to the index rather than an ok flag, so every successful
  refresh had been reported as a failure. And a 33rd pin was answered ok with no tile drawn; the
  stored list is used and the dock says "Full".

Verified with harnesses only. The user was gaming while this round was written, so none of it has had a
live pass in the running browser: the evidence is pure-node harnesses (112/112 on the app index,
78/78 on the pins, push and palette rows, 61/61 on the icon slot through a DOM shim, 33/33 plus 7/7
against the real filesystem on the resolver, 108/108 on the chrome wiring), the engine on disk for
the YouTube filters, and a headless renderer with synthetic pushes for the dock.

Most of that debt has since been paid on a test profile: the palette's app rows and the light-theme
dock were captured live (7e637cd), a dock-launched PowerShell with no main window handle was
minimised and its own console window raised while a windowless pid raised nothing (439cdd5, harness
190/190), and the YouTube fix was measured on YouTube itself, five rounds of five (f4d8ca1). What is
still owed is the process-icon side: the icon IPC round trip and real `getFileIcon` timing on this
machine.

### Files tab

- A file browser as a tab, on Ctrl+Alt+E (91682dc, cf13b3a). It opens as a "Files" tab with a blank
  omnibox, themed and palette-matched like the other bundled pages, and theme pushes reach it.
  Ctrl+Shift+E is still Workspaces and was not touched. There is a "Files" row in the command
  palette as well.
- The page is a left rail of your own folders and the drives with a free-space bar, a breadcrumb
  path bar that turns into a text field on Ctrl+L, a filter over the current listing, and a listing
  with a 16px icon slot, size and modified columns, header sort remembered in `localStorage`,
  keyboard navigation (arrows, Enter, Backspace, Home, End), double-click to open, and a right-click
  menu with Open, Show in Explorer and Copy path. Empty, error and truncated states are all drawn
  rather than left blank.
- Main answers `files:list` / `places` / `open` / `reveal` / `icons` / `copy-path` for the chrome
  sender only: drive-letter or UNC paths, `readdir` with file types, folders first, a 2,000-row cap
  that reports itself as truncated, `stat` in waves of 64, errors mapped to not-found /
  access-denied / not-a-folder, drives probed with `statfs` over C to Z, and icons from
  `app.getFileIcon` cached per extension. The page talks to the chrome over a `files:` console
  channel with the same guards as the new tab's channels, so a new-tab guest printing `files:` lines
  does nothing.
- Verified live on a test profile: the palette row opened the tab, root showed the places and C:
  with its free space, Downloads listed 340 rows in 142ms with 80 icon slots filled, and filter, all
  three sorts, up, System32 truncated at 2,000 rows, a missing folder and a file path all showed
  what they should. `files:reveal` was not exercised, because it raises Explorer over everything.
  Volume labels are always empty — Electron exposes none without a spawn.

### Idle music

- Settings has an Idle music section, between New tab and Privacy (33a77e0): Enabled, Source
  (Built-in ambient, or My tracks with a count, Choose files… and Clear), Where it plays, Volume,
  and the hint "Plays while nothing else is playing". Preferences live in the `music` group of
  `localStorage['settings']` — `{ enabled, source, where, volume, files, shuffle }` — normalised on
  the way in (volume clamped, unknown values falling back to defaults, file paths validated,
  deduped and capped) and announced with a `music` emit key and a `music-changed` event. Both new
  controls degrade to a short hint rather than a dead row if the preload or the helper lacks the API.
- The ambient engine behind the Built-in source (5b85fe2). ambient.js is a generative lobby-style
  pad on Web Audio: three or four detuned voices through a slow low-pass filter form a chord that
  crossfades to the next every 16 to 24 seconds along a small modal progression, a sparse sine
  arpeggio quantised to the chord runs through a feedback delay, and the room is four damped delay
  lines rather than a convolver (a 2.5s convolver cost 4% of a core on its own), into a compressor
  and a master gain. One timer for the whole thing; `stop()` clears it, kills the live nodes and
  suspends the context. Twelve two-word mood titles. Live in a muted test instance the renderer sat
  at 1.9% of one core playing and under 0.1% paused with the context suspended; an offline render
  peaks at -6 dBFS steady, -21 dBFS at the default volume, so it is not silent.
- An Idle music block on the new tab, inside the session tile (4914b45): a state line reading Off,
  Paused, the mood title or the track name, Play / Pause / Turn on, a Next control for your own
  tracks, and the same hint. `window.__applyMusic({ enabled, playing, source, title, where })`
  updates it in place and clicks come back as `newtab:music` console lines. The session counts moved
  into their own rows so the tile can show music without three dashes, and the modules now sit above
  the stage layer — they had shared a z-index, so clicks on the controls were landing on the stage.
- Main and preload carry the bridge calls (bc25347), each answering `{ ok, reason }` within 1500ms
  and only for the chrome sender: `music:choose-files` (multi-select audio, nothing copied, capped
  at 500), `media:now` (the Spotify helper's `/now`, with art omitted, full, or by hash) and
  `media:control` (play, pause, toggle, next, prev). No custom protocol for your own tracks: the
  chrome is a `file://` document with no CSP, and `file://` audio reaches `loadedmetadata`, proven
  live with a wav and an mp3. Live against an isolated copy of the helper, now-playing answered in
  92ms with art by hash. The file dialog itself is not exercised, because it is modal and would take
  the foreground.
- The player itself is not here yet. Everything above is the engine, the settings, the page module
  and the bridge; the chrome-side player that actually decides when nothing else is playing and
  starts the sound lands in the next commit.

### Shortcuts

Every default can be rebound in Settings → Shortcuts except Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1–9,
Escape and F12. New or changed defaults from tonight:

- Ctrl+Shift+A tab search, Ctrl+K command palette, Ctrl+H history page, Ctrl+J downloads.
- Ctrl+\ split view, Ctrl+Shift+\ Claude beside the page, Ctrl+Shift+K ask Claude about this page.
- Ctrl+` toggle a Claude tab, Ctrl+Shift+` new Claude tab in a folder you pick.
- Ctrl+Shift+E workspaces, Ctrl+Alt+Left / Ctrl+Alt+Right to cycle them.
- Ctrl+Alt+E the Files tab. Ctrl+Shift+E stayed on Workspaces.
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
- "Quiet Spotify ads", a third switch in the same section (33a77e0, bc25347). With it on, the helper
  drops Spotify's own in-app volume to 10% while an ad is playing and puts it back to full when the
  ad ends, so the free tier's ad breaks stop being the loudest thing in the room. The switch reads
  the helper's `adDuck` state — carried on the auto-pause status and on every status push through a
  3-second cache — and writes it back over `api.spotify.setAdDuck`, which POSTs the helper's
  `/config`. Verified live against an isolated copy of the helper: the round trip works and the
  switch survives a chrome reload.
- Now-playing routes for the chrome (bc25347): `media:now` reads the helper's `/now` (art omitted,
  full, or by hash) and `media:control` sends play, pause, toggle, next and prev. The helper's port
  comes from the existing client cache, and a failed call forgets it. Invalid commands are refused.
  These are the plumbing for a now-playing tile; nothing draws one yet.

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
- The counter pipe. `typeperf` writes about 1,400 tiny chunks a second, and reading them in flowing
  mode cost main 4.7% of a core once the per-process counters rode along. The pipe is paused and
  drained once per tick instead: 0.35% of a core with the process rows, 0.27% without.

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
  rounding. The aurora was the one thing moving at rest in both places, so stilling it was a likely
  fix rather than a proven one. The caret turned out to be the other half of it: see the Settings
  flicker under Look.

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
- Scriptlets are off for youtube.com, which is what makes the player build after an in-page click.
  Network and cosmetic blocking are untouched there, but an in-stream ad can still play — that was
  already true on the reload path, and this is a player fix, not an ad skipper.
- The Idle music settings and the new tab's Idle music block are drawn but silent until the
  chrome-side player lands. Choosing files and flipping the switch persists; nothing plays yet.
- DRM services cannot play inside a tab. Electron ships Chromium without Widevine, so Spotify and
  Netflix are handled as the desktop app plus the now-playing controls here, not as pages.
- Ctrl+Alt+E opens the Files tab. Ctrl+Shift+E is still Workspaces.

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
| 669c943 | 18:09 | System stats sample once a second, Task Manager's cadence |
| b3348e9 | 18:12 | Settings: opening the pane focuses the panel, not the filter box, so no caret blinks under the acrylic |
| cf15ff9 | 18:16 | End task plumbing: the new-tab page asks over its console line, main kills through stats.endTask, the answer is pushed back |
| bed0643 | 18:41 | New tab: a Processes pop-out opens from the stats strip, with End task |
| 16d1b09 | 18:57 | System stats: the counter stream survives vanished instances and refreshes them; per-process rows; endTask with refusals |
| ad2fa18 | 19:00 | New tab: the process list is an expander under the stats strip, remembered open or closed |
| 2f56e07 | 20:19 | Apps: installed-app index, launch and focus (main process) |
| 95b5034 | 20:19 | Apps: pins in settings, chrome push to the new tab, palette rows |
| fdc3c12 | 20:28 | Apps: the new-tab dock (pinned app tiles, running dots, Edit and Add app) |
| cf86935 | 20:28 | Ad blocker: never cancel YouTube's own player and stats calls |
| c984889 | 20:35 | New tab: process icons in the Processes list (page side) |
| c4d0d21 | 20:36 | Process icons: resolver module for the main process |
| ce31821 | 20:38 | Process icons: chrome wiring (IPC, cache, push to the new tab) |
| 7eb3d1a | 20:43 | CHANGELOG + README: the apps dock, process icons and the YouTube ad-block exception |
| a95db9d | 21:07 | New tab: dock review fixes (Add app tile, picker height, Escape focus) |
| 91a3b66 | 21:10 | Apps: chrome review fixes (refresh race, refresh answer, pin cap) |
| 91682dc | 21:13 | Files tab: the folder browser page (page side, not yet wired) |
| 7e637cd | 21:37 | Palette: app rows on a plain search; new tab: light-theme dot contrast |
| 38bd224 | 21:43 | Popups: real child windows for window.open, tabs for links |
| 5b85fe2 | 21:45 | Idle music: the built-in ambient engine (not yet wired) |
| 439cdd5 | 22:01 | Apps: focus by real window, quieter index, Store exe names, x86 twins |
| 4914b45 | 22:01 | New tab: the Idle music module (page side) |
| cf13b3a | 22:04 | Files tab: chrome wiring (IPC, console channel, palette row, Ctrl+Alt+E) |
| f4d8ca1 | 22:05 | Ad blocker: no scriptlets on youtube.com (in-page clicks play again) |
| 0df6795 | 22:10 | Settings: section names read as headings |
| 33a77e0 | 22:12 | Settings: the Idle music section and a Quiet Spotify ads switch |
| bc25347 | 22:16 | Main and preload: music file picker, now-playing and ad-duck bridge calls |
| 528558c | 22:25 | Terminal tabs: program table for pty sessions (claude, powershell, pwsh, cmd, python, node, bash) |
