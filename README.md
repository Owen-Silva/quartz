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
`browser` in `package.json`). Inside it, `window-state.json` holds the remembered window
rectangle plus `maximized`; it is discarded on read if it is not JSON, or if the saved rect no
longer overlaps a connected display by at least 100px on each axis.

Renderer state is four `localStorage` keys: `theme` (`light`/`dark`, stamped on `<html>` by
theme-boot.js before first paint), `session` (the tab strip snapshot, http/https pages only,
capped at 40, with the new-tab page stored as the marker `newtab`), `history`
(`{v:1, items:[{url,title,visits,last}]}`, capped at 2000), and `settings` (search engine,
site theme, accent hue, new-tab chips, homepage).

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
| Ctrl+, | Settings |
| Ctrl+` | Toggle a Claude tab |
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
the page still wants it. Two things are chrome-only and do nothing while a page has focus:
Ctrl+Shift+PageUp/PageDown and Ctrl+R (F5 covers reload from inside a page).

## Features

**Tabs.** Drag to reorder (pointer-driven, `body.tab-dragging`), right-click menu, middle-click
close. A guest whose renderer dies gets a `.tab-card` over it — "This page crashed" or "Can't
reach this site" — instead of Chromium's grey page; reload rebuilds the guest. Switching tabs
is a display swap, never a teardown, so page state and live PTYs both survive. The strip is
snapshotted to `localStorage['session']` (debounced 500ms, suppressed while restoring) and
restored on next launch; closed page URLs go on a 20-deep stack for Ctrl+Shift+T.

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

**Settings.** A gear beside the theme toggle opens a popover with: Look (dark/light, accent
hue), Search (engine — Google, DuckDuckGo, Bing, Brave, Startpage), Websites (the site theme
guests see through `prefers-color-scheme`: system / light / dark), New tab shortcuts (the
chips, added by Ctrl+D or by hand), Privacy (clear browsing history, clear downloads list),
Shortcuts (the key table), and About (Electron and Chromium versions). It all persists as one
JSON object in `localStorage['settings']`; missing keys fall back to defaults so an older
stored object still reads.

**New tab page.** A plain `file://` page inside a guest — no preload, no `window.api`. The
chrome passes `?theme`, `?hue`, `?engine` and `?chips` for the first paint and pushes later
changes in with `window.__applySettings`. Chips show favicons from
`google.com/s2/favicons`, falling back to the bare label if the request fails. Behind the
search field is the circuit board: a socket ring around the capsule, 45-degree traces out to
vias and peripheral chips, with light packets running them.

**Claude tabs.** pty.js spawns `C:\Users\you\.local\bin\claude.exe` with no arguments under
a real ConPTY, cwd defaulting to `C:\Users\you`, wired to xterm.js. The environment is
scrubbed first: every `CLAUDE*` variable is deleted except `CLAUDE_CODE_GIT_BASH_PATH` and
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
| `main.js` | Electron entry. Owns the single BrowserWindow, window state, acrylic, downloads, permissions, guest context menus, the replayed keystrokes, and the PTY IPC bridge. |
| `preload.js` | The `window.api` contextBridge surface: shortcuts, open-url, pty, downloads, paths, versions. |
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
| `newtab.html` / `newtab.css` / `newtab.js` | The search page: chips, engine, favicons, placeholder. |
| `newtab-theme.js` | First script on the new tab page; resolves `?theme` and `?hue` before the stylesheet. |
| `newtab-bg.js` | The circuit board — canvas painted once per layout, packets as DOM on Web Animations. |
| `smoketest.js` | Launches the app on CDP port 9222, checks the required chrome ids, proves a Claude PTY spawns and renders. |
| `cdp-eval.js` | Evaluate one expression in the running test instance. |
| `cdp-profile.js` | CPU-profile the running test instance and print the hottest functions by self time. |
| `assets/` | `browser.ico` and `browser.png` (the app/shortcut icon). |

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
smoke test does: its storage and theme choice stay out of the real profile.

Never kill every `electron.exe` — I run my own Claude Code instance on Electron and it will go
down with it. Kill only the test instance: find the PID whose command line contains
`remote-debugging-port=9222` and no `--type=` (that filters out the renderer and GPU children,
which die with their parent anyway).
