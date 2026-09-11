# Changelog

This is the record of what changed in the browser, written so you can catch up without reading
diffs. Everything below landed overnight in 20 commits on the local `master` branch — there is no
remote, so the repo in `C:\Users\you\browser` is the only copy. Run it with `npm start` or the
taskbar pin; a copy that is already open keeps running the old code, so close it and launch again
to pick any of this up.

## What's new, by area

### Claude tabs

- A Claude tab now carries a working folder. Shift+click the Claude button, press Ctrl+Shift+`, or
  use the bare-strip menu to pick one through the native dialog; the tab title is the folder name.
  A folder that has been deleted or mistyped falls back to the default rather than failing the tab.
- Settings has a Claude section: a default folder with a picker and validation, plus a resume
  switch.
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
- A Claude tab can sit beside a page in split view — Ctrl+Shift+\, Alt+click the Claude button, or
  the chip menu. The terminal refits when you drag the divider.

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
  Downloads, Privacy and About.
- Contrast and copy pass: the muted foreground now clears 4.5:1 on panel grounds in both themes,
  captions are sentence case throughout, and the split divider is visible in light.

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

## Commits

Times are local. 21:26 through 23:54 are 10 September; 00:29 onward are 11 September.

| Hash | Time | Summary |
| --- | --- | --- |
| 01358c3 | 21:26 | Initial commit: glass Electron browser with Claude tabs, themes, circuit-board new tab |
| c793070 | 21:42 | Find in page, downloads shelf, history suggestions, context menus, permission prompts, fullscreen |
| 41be354 | 22:00 | Settings panel, accent colour, search engines, site theme, tab drag and menu, crash cards |
| 230121f | 22:21 | README and a QA note on the drag-region right-click |
| cc01d53 | 22:40 | Ad and tracker blocking with shield, tab audio and pinning, zoom badge, new-tab recents |
| a7ba15e | 22:53 | Claude tabs with a chosen folder, conversation resume and restore, durable session, print |
| 1e5bfa5 | 23:15 | Tab sleeping, per-site styles with force dark, reader view |
| 37fc4f0 | 23:42 | QA fixes: drag reaches the outermost slot, reader replayed from pages |
| d35c505 | 23:54 | Palette presets (ember, forest, ocean, midnight, mono) and tab search |
| e60cebd | 00:29 | Site info popover with persisted permissions and site-data clearing, split view, site scripts |
| 10cf854 | 01:05 | New-tab backgrounds (aurora or your image), QA fixes |
| a23d9ac | 01:19 | Claude beside a page in split view, page screenshots, bookmarks bar, board pause under overlays |
| eba95ac | 01:45 | Claude needs-you indicator, command palette |
| e157a7a | 01:59 | Ask Claude about this, history page, picture in picture |
| 81f81a5 | 02:19 | Customisable keyboard shortcuts |
| e2e2bca | 02:42 | Shortcut fixes from QA: Ctrl+R alias, shifted punctuation, hints for fixed rows |
| 5ecff29 | 03:01 | Workspaces, downloads save-as and open folder, more palette commands |
| 7c7598b | 03:38 | QA and design pass: contrast, sentence case, split divider, scrollbars |
| 518d263 | 04:04 | Resume a Claude conversation, security hardening, performance audit |
| 9cb9fba | 04:19 | Browser style (user CSS for the chrome), board freezes on window blur |
