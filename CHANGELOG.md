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
- Instrument glass, pass two. The chrome is deep glass carrying exactly three horizontal lines: a
  specular hairline at the top, an edge hairline between the titlebar and the nav row, and the lit
  seam. Tabs are flush segments with hairline dividers, the active one wearing a 2px accent lamp
  on its bottom edge. Back, forward and reload are plain glyphs; shield, theme and settings form
  one segmented cluster, and the Claude button keeps a ring of its own. Every hairline is 1px,
  every glyph 16px, and the spacing is on a 4px grid.
- Every pane and popover is cut the same way now: a 44px header with a 14px/600 title and the
  close glyph at the right, a 2px seam lamp along the top edge, 13px body, 12px captions, 36px
  rows, 32px buttons, 16px gutters and 6px scrollbar thumbs. Rims are still masked rings on a
  pseudo-element, the rule from pass one.
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
whenever the window loses focus — with it frozen and no page animating, the only remaining cost is
the aurora's stepped keyframes.

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
