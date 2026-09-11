# Browser

My own browser. Electron 44 shell, frosted-glass chrome lit from behind by an aurora, in a
dark theme and a light one that are the same instruments in daylight. Claude Code sessions
are tabs, not a side pane: a tab is either a `<webview>` page or a `.claude-view` chamber
running one real `claude.exe` under ConPTY, and both live in `#views` side by side. New tabs
open a bundled circuit-board search page that wraps whichever engine is set in settings.
Electron rather than Tauri because Tauri's build wants a C++ toolchain and this machine does
not have one; Electron ships its own Chromium and needs nothing installed.

## Running it

```
npm start          # = electron .
npx electron .     # same thing without the script
```

The Start Menu entry `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Browser.lnk` launches
`electron.exe` with this project path as its argument. It is pinned to the taskbar by hand —
Windows 11 refuses scripted pinning, so if the pin is ever lost it has to be re-done from the
Start Menu.

Two CLI flags:

| Flag | Effect |
| --- | --- |
| `--test-profile` | Points Electron's `userData` at `%TEMP%\browser-test-profile`, so a test run's cookies, storage, theme and window geometry never touch the real profile. |
| `--no-acrylic` | Skips the DWM acrylic backdrop and opens a flat window. Used to measure what the material costs. Acrylic is only attempted on Windows 11 22H2 (build 22621) or later, and falls back to flat by itself if `backgroundMaterial: 'acrylic'` throws. |

The profile lives at `%APPDATA%\browser` (Electron's default `userData` for the app name
`browser` in `package.json`). Inside it: `window-state.json` holds the remembered window
rectangle plus `maximized`, discarded on read if it is not JSON or if the saved rect no longer
overlaps a connected display by at least 100px on each axis; `session.json` is the durable copy
of the tab strip; `adblock.json` holds the blocking preferences (on/off plus the per-site
allowlist); `adblock-engine.bin` is the serialised filter engine, fetched on first run.

Renderer state is six `localStorage` keys: `theme` (`light`/`dark`, stamped on `<html>` by
theme-boot.js before first paint), `session` (the tab strip snapshot — web pages and Claude
chambers, capped at 40, with the new-tab page stored as the marker `newtab`), `history`
(`{v:1, items:[{url,title,visits,last}]}`, capped at 2000), `settings` (search engine, site
theme, accent hue, new-tab chips, homepage, Claude folder, Claude resume, tab sleep minutes),
`zoom` (`{host: level}` — 100% deletes its entry rather than storing a zero), and `sitestyles`
(`{v:1, globalDark, hosts:{host:{css,dark}}}`). A seventh, `reader` (text size, column width),
belongs to the reading page rather than the chrome.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+T | New tab |
| Ctrl+W | Close the active tab (page or Claude) |
| Ctrl+Shift+T | Reopen the last closed tab (stack of 20) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next tab / previous tab |
| Ctrl+1–8 / Ctrl+9 | Jump to that position / to the last tab |
| Ctrl+Shift+PageUp / PageDown | Move the active tab along the strip |
| Ctrl+L | Focus the address bar |
| Ctrl+F | Find on page |
| Ctrl+J | Downloads |
| Ctrl+H | History |
| Ctrl+D | Add this page to the new-tab chips |
| Ctrl+P | Print the active page through Chromium's own preview (no-op on a Claude tab) |
| Ctrl+Shift+R | Reader view for the active page |
| Ctrl+, | Settings |
| Ctrl+` | Toggle a Claude tab |
| Ctrl+Shift+` | New Claude tab in a folder you pick |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| Ctrl+R | Reload (never reloads the shell window; no-op on a Claude tab) |
| F5 | Reload |
| F11 | Fullscreen |
| F12 / Ctrl+Shift+I | Devtools for the focused guest page |
| Alt+Left / Alt+Right | Back / forward |
| Escape | Close the tab menu, or the open instrument panel |
| Middle-click a tab | Close it |
| Right-click a tab | Duplicate, Close, Close other tabs, Close tabs to the right, Reopen closed tab (right-click on bare strip gives New tab / Reopen closed tab) |

A focused page swallows its own keys, so main.js listens on every guest's
`before-input-event` and replays the chrome ones to the renderer over the `shortcut` IPC
channel (`SHORTCUTS` / `shortcutFor` / `BARE_KEYS` in main.js). F12 is handled in main
directly, because the devtools belong to the guest. Escape is forwarded but not swallowed —
the page still wants it. Ctrl+R and Ctrl+Shift+R are caught in `shortcutFor` ahead of the
lowercasing lookup, which would otherwise read the Shift away, and replayed as `reload` and
`reader`. Three things are chrome-only and do nothing while a page has focus, because the table
has no entry for them: Ctrl+Shift+PageUp/PageDown, Ctrl+P, and Ctrl+Shift+` (Shift turns that
key into `~`). app.js already answers `print` on the `shortcut` channel, so replaying Ctrl+P
too would be one line in `SHORTCUTS`.

## Features

**Tabs.** Drag to reorder (pointer-driven, `body.tab-dragging`), right-click menu, middle-click
close. A guest whose renderer dies gets a `.tab-card` over it — "This page crashed" or "Can't
reach this site" — instead of Chromium's grey page; reload rebuilds the guest. Switching tabs
is a display swap, never a teardown, so page state and live PTYs both survive. Closed page URLs
go on a 20-deep stack for Ctrl+Shift+T (a reader tab pushes the article, not the wrapper).
Ctrl+P and the chip menu's Print… call the guest's own `print()`, opening Chromium's preview;
a Claude chamber has nothing to print, so it is a no-op there.

**Session.** The strip is snapshotted (debounced 500ms, suppressed while restoring) to two
places: `localStorage['session']` and, over IPC, `session.json` in the profile, which main
writes synchronously to a `.tmp` and renames, so a kill mid-write can only destroy the temp
file. Boot reads both and the newer `savedAt` wins, waiting at most 300ms for the file copy so
a hung main process cannot hold the window at zero tabs. A page entry carries its URL plus its
`pinned` and `muted` flags; a Claude entry carries its `cwd`. Chromium flushes localStorage
lazily, so a forced kill can still lose the last write to it — the file copy is what covers that.

**Blocking.** Ghostery's `@ghostery/adblocker-electron` engine owns the webRequest hooks on
`session.defaultSession`, so one engine filters every guest and there is nothing per-tab to
wire up. The serialised engine is cached at `adblock-engine.bin`; a first run fetches a few MB
of lists and is not awaited by window creation, and with no cache and no network blocking is
simply unavailable. `adblock.json` holds the on/off switch and the per-site allowlist. A shield
button in the nav row carries the count blocked on the page in front of you and opens a popover
with two switches, "Block on this site" and "Block ads and trackers everywhere". An allowlisted
host gets an exception rule for each half of the engine, `@@*$domain=host` for its subresources
and `@@||host^$elemhide` for its cosmetic filters. Cosmetic filtering rides the library's
session-level preload, its IPC handler wrapped so only `http:`/`https:` frames are served —
unwrapped it styles our own `file://` chrome. One caveat: turning blocking off calls
`disableBlockingInSession()`, which clears *all* webRequest listeners on that session, so
nothing else in the app may register one there.

**Tab audio and pinning.** A chip grows a speaker button the first time its guest plays
something; clicking it mutes the tab without raising it, and the mute rides along in the session
entry and is re-applied on `dom-ready`, since a fresh guest is born unmuted. Pinning makes a
chip icon-only and moves it into the pinned group at the left of the strip — both directions
land on the same index, so it is reversible without reshuffling anything. A pinned chip ignores
middle-click close, falls back to a globe glyph with no favicon, and is rebuilt before the
others on restore.

**Tab sleeping.** A background page tab that has sat untouched past the configured idle time
(default 30 minutes, `0` = never, swept once a minute) gives its renderer back: the `<webview>`
is removed from `#views`, which is what destroys the guest, and a hidden placeholder `<div>`
stands in for it. The chip keeps its title and favicon and does not move. Never slept: the tab
on screen, a pinned tab, anything audible (muted or not), a blank new tab, a crashed tab, a
Claude chamber. Waking rebuilds the guest on the URL snapshotted at sleep time and re-applies
the mute and the site's zoom, so what a live page was holding is gone — scroll position, form
input, in-page state, the tab's own history. Sleep tab / Wake tab sit in the chip menu.

**Zoom.** Zoom is remembered per `http`/`https` hostname in `localStorage['zoom']`, re-applied
on `dom-ready`, clamped to Electron levels -3..5 in half steps. Anything but 100% shows a
`#zoom-badge` beside the omnibox reading the percentage; clicking it resets, and 100% deletes
the stored entry rather than saving a zero.

**Site styles.** sitestyles.js keeps `{ css, dark }` per host in `localStorage['sitestyles']`,
plus one global force-dark switch. Host keys are normalised both in and out — lowercased, no
scheme, no userinfo, no `www.`, no port, no path, no trailing dot — so `https://WWW.Example.com:8443/x`
and `example.com` are one entry (a parent-domain walk stops short of two-part public suffixes, so
nobody styles `co.uk`). CSS is injected per guest on `dom-ready` and re-applied live when the
store changes, with every `insertCSS()` key tracked per tab so a re-apply removes exactly what
this module inserted last time and nothing else. Dark comes two ways: a host entry
with `dark: true` is unconditional, while the global switch skips any host that has explicitly
opted out and any page that is already dark, measured by probing the rendered background
luminance in the guest — inverting an already-dark site turns it white. An empty entry is kept;
only Remove deletes one.

**Reader view.** Ctrl+Shift+R (or the nav-row button, hidden until the page probes as readable)
runs `@mozilla/readability` over the active page and opens the article in the bundled
`reader.html`, next to the tab it came from. Everything coming back out of a guest is treated as
hostile: the body is parsed into an inert document and stripped of scripts, frames, plugin
objects, `on*` handlers and `script:` URLs before it is handed over. The reading page owns its
top bar — back to the source, A- / A+, narrow / wide — saved to `localStorage['reader']` and
applied from `<head>` before first paint, so the article never visibly resizes. A reader tab's
URL is `reader.html?src=<article url>`, but the omnibox, history, session and reopen stack all
use the article's own address, so it restores as the plain article.

**Address bar.** A recognised, allow-listed scheme navigates as typed; a localhost or IPv4
host gets `http://`; any other bare domain gets `https://`; everything else is a search through
the configured engine. `#omni-suggest` hangs under the capsule and mirrors its geometry: with
text typed it leads with the row that mirrors what Enter already does, then history matches;
on an empty focus it shows what was open recently. It never navigates itself — it writes into
`#omnibox` and hands Enter back to app.js.

**Find in page.** A right-aligned instrument under the nav row driving the active webview's
`findInPage` / `stopFindInPage`, re-running at most every 60ms while typing.

**Downloads.** `will-download` picks a unique path in the real Downloads folder and calls
`setSavePath` up front, which is exactly what suppresses the save dialog; if a path cannot be
chosen it falls back to Electron's own prompt rather than losing the download. The nav-row
button carries a progress ring while anything is in flight and opens a glass popover listing
the session's downloads, with cancel / pause / resume / show in folder / open / clear.

**Settings.** A gear beside the theme toggle opens a popover with ten sections, in this order:
Look (dark/light, accent hue); Claude (the folder new Claude tabs start in — typed, or through
the native picker, and only written once main confirms it is a real directory — plus the switch
for resuming the last conversation on restore); Tabs (how long a background tab may idle before
it sleeps, or never); Search (engine — Google, DuckDuckGo, Bing, Brave,
Startpage); Websites (the site theme guests see through `prefers-color-scheme`: system / light /
dark); Site styles (force dark everywhere, plus the per-host list — a dark switch and a CSS
drawer each, and a field to add a host however you happened to copy it); New tab shortcuts (the
chips, added by Ctrl+D or by hand); Privacy (clear browsing history, clear downloads list);
Shortcuts (the key table); and About (Electron and Chromium versions). Everything but the site
styles — which is just a view onto sitestyles.js's own store — persists as one JSON object in
`localStorage['settings']` (`searchEngine`, `siteTheme`, `accentHue`, `chips`, `homepage`,
`claudeDir`, `claudeResume`, `tabSleepMinutes`); missing keys fall back to defaults, so an older
stored object still reads.

**New tab page.** A plain `file://` page inside a guest — no preload, no `window.api`. The
chrome passes `?theme`, `?hue`, `?engine` and `?chips` for the first paint and pushes later
changes in with `window.__applySettings`. Chips show favicons from
`google.com/s2/favicons`, falling back to the bare label if the request fails. The page cannot
read the history store, so the chrome pushes it up to 8 recent sites with `window.__applyRecent`
on every visit: at most 6 become tiles under the chips (skipping any host a chip already covers),
and the rest feed the capsule's own dropdown — up to 4 matching what is being typed, host or
title, case-insensitive. Behind the search field is the circuit board: a socket ring around the
capsule, 45-degree traces out to vias and peripheral chips, with light packets running them.

**Claude tabs.** pty.js spawns `C:\Users\you\.local\bin\claude.exe` under a real ConPTY,
wired to xterm.js. The cwd is whatever the caller asked for, falling back to the Claude folder
from settings and then to the home directory — a folder that has been deleted, renamed or
mistyped falls back rather than failing the tab. Arguments are allowlisted in pty.js
(`ALLOWED_ARGS`, currently `--continue` and nothing else); anything else is dropped with a
warning and the session still starts, plain. Shift+click the Claude button, or Ctrl+Shift+`, to
pick a folder for one chamber through the native dialog; the chip menu's "Open folder in new
Claude tab" starts a second chamber in the same folder (Duplicate is not offered — a PTY cannot
be copied). Restored chambers come back on `claude --continue` unless the resume switch is off.
In a folder Claude Code has not run in before, the first thing in the chamber is its own trust
prompt — that one is Claude's, not the browser's. The environment is scrubbed first: every
`CLAUDE*` variable is deleted except `CLAUDE_CODE_GIT_BASH_PATH` and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, because if the browser was launched from inside a Claude Code
session those markers make the new session think it is a child (transcript saving off, effort
hard-pinned). xterm is opened lazily — building it into a hidden 0x0 container gives a
permanently broken session — so a background tab waits on a ResizeObserver. When a session
exits the pane prints `[session ended] press Enter to start a new one`, and Enter restarts it
in the same terminal.

**Permissions.** Electron grants everything by default, which would make this the most
generous browser on the machine, so the handler is explicit. Silently allowed (they need a
user gesture anyway): fullscreen, pointerLock, clipboard-sanitized-write, window-placement,
window-management, keyboardLock. Prompted once per origin, remembered for the run:
geolocation, notifications, midi, midiSysex, display-capture, idle-detection, clipboard-read,
openExternal, and camera/microphone. Anything else is denied without asking.

**Context menus.** A `<webview>` has no menu of its own and the built-in `role:` entries act on
the window, so every item calls the guest's own webContents method: navigation, link, image,
selection, editing and inspect groups.

## Files

| File | What it is |
| --- | --- |
| `main.js` | Electron entry. Owns the single BrowserWindow, window state, acrylic, downloads, permissions, guest context menus, the replayed keystrokes, the PTY IPC bridge, the blocking engine and its counters, the folder picker, and `session.json`. |
| `preload.js` | The `window.api` contextBridge surface: shortcuts, open-url, pty, downloads, paths, versions, `adblock`, `app` (pickFolder / dirExists), `session`. |
| `app.js` | The chrome: tab strip, webview lifecycle, omnibox, navigation, theme, Claude tabs, session save/restore, tab menu, crash cards. |
| `pty.js` | PTY session manager — spawns `claude.exe` under ConPTY with a scrubbed environment. |
| `terminal.js` | `window.ClaudeTerminal`: one xterm.js instance per Claude tab, lazy open, id dispatch, restart. |
| `index.html` | The shell document: backdrop layers, titlebar, nav row, `#views`, `#tabmenu`, script order. |
| `theme-boot.js` | Runs first in `<head>`; stamps `data-theme` on `<html>` before any stylesheet paints. |
| `chrome.css` | Every token and every chrome rule, dark block then light block. |
| `find.js` / `find.css` | Find in page. |
| `downloads.js` / `downloads.css` | Downloads button, progress ring, popover. |
| `history.js` / `history.css` | The history store and the omnibox suggestion lens. |
| `settings.js` / `settings.css` | Settings button and popover; owns `localStorage['settings']`. |
| `shield.js` / `shield.css` | The blocking instrument: nav button, blocked count, the two switches. Talks to main over `api.adblock`. |
| `sitestyles.js` | Per-host CSS and force dark; owns `localStorage['sitestyles']` and injects into each guest. |
| `reader.js` / `reader.css` | The reader button: probes a page, runs Readability, sanitises the article, opens the reading tab. |
| `reader.html` / `reader-page.css` / `reader-page.js` | The reading page itself: top bar, text size and width, `window.__applyArticle`. Owns `localStorage['reader']`. |
| `newtab.html` / `newtab.css` / `newtab.js` | The search page: chips, engine, favicons, placeholder. |
| `newtab-theme.js` | First script on the new tab page; resolves `?theme` and `?hue` before the stylesheet. |
| `newtab-bg.js` | The circuit board — canvas painted once per layout, packets as DOM on Web Animations. |
| `smoketest.js` | Launches the app on CDP port 9222, checks the required chrome ids, proves a Claude PTY spawns and renders. |
| `cdp-eval.js` | Evaluate one expression in the running test instance. |
| `cdp-profile.js` | CPU-profile the running test instance and print the hottest functions by self time. |
| `assets/` | `browser.ico` and `browser.png` (the app/shortcut icon). |

Runtime dependencies beyond Electron: `@homebridge/node-pty-prebuilt-multiarch` (ConPTY),
`@xterm/xterm` with `@xterm/addon-fit`, `@ghostery/adblocker-electron` with
`@ghostery/adblocker-electron-preload` (which nothing here names — the blocker resolves its path
itself), and `@mozilla/readability`, loaded out of `node_modules/` by index.html as a classic
script so it leaves a global `Readability` for reader.js. `ws` is a devDependency, for CDP.

## Design rules worth keeping

- Every colour resolves through a token. A theme is nothing but a second token block, and no
  rule below the token blocks tests `data-theme` itself.
- The light theme is the `:root[data-theme="light"]` block in chrome.css — custom properties
  only. Type and metric tokens are inherited from the dark block, not redeclared.
- Anything floating over a page uses `--panel-bg`, not `--glass`. Glass is see-through, and
  there is nothing behind a popover to blur except the guest's own content.
- No continuous animation under `backdrop-filter`. Everything that moves is stepped —
  `steps(120)` on the aurora drift, `steps(24)` on the loading shimmer, `steps(8)` on the live
  dot — because a drifting full-screen effect behind the blur once cost about a quarter of a
  core for the chrome alone.
- System fonts only: `--ui-font` is Bahnschrift / Segoe UI Variable / Segoe UI, `--icon-font`
  is Segoe Fluent Icons with the MDL2 fallback. Glyphs are written as codepoint escapes so no
  encoding round-trip can eat a private-use character.
- `--ion` (ice cyan, or the chosen accent hue) is the one accent and marks what is active.
  `--amber` means exactly one thing: a Claude session is live. Nothing else is colour.
- `#views webview` keeps a white background in both themes. A guest page is transparent, so
  this is what a site without its own background paints on; using the theme ink made dark mode
  look like it was forcing every plain page dark.

## Development

The smoke test launches its own instance with `--remote-debugging-port=9222 --test-profile`:

```
node smoketest.js            # launch, assert, tear down
node smoketest.js --keep     # leave it running so you can poke at it
node cdp-eval.js "document.title"
node cdp-eval.js --guest "document.querySelector('#q').placeholder"
node cdp-profile.js [--guest] [seconds]
```

`--guest` targets the new-tab page inside the `<webview>` instead of the chrome document. Any
instance you drive by hand should be started with `--test-profile` for the same reason the
smoke test does: its storage and theme choice stay out of the real profile. That profile is
`%LOCALAPPDATA%\Temp\browser-test-profile`, which is now where a test run's `session.json`,
`adblock.json` and `adblock-engine.bin` land too (a fresh one pays the filter-list download
once). The test polls for `body.booted` before it touches any tab — the launch animation sets
that class — then closes any Claude tabs the restored session brought back, so the tab count it
asserts against is its own.

Never kill every `electron.exe` — I run my own Claude Code instance on Electron and it will go
down with it. Kill only the test instance: find the PID whose command line contains
`remote-debugging-port=9222` and no `--type=` (that filters out the renderer and GPU children,
which die with their parent anyway).
