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
allowlist); `adblock-engine.bin` is the serialised filter engine, fetched on first run; and
`permissions.json` holds the per-origin decisions as
`{ origin: { permission: 'allow' | 'block' } }`, read as "nothing decided yet" when it is
missing or corrupt.

Renderer state is eight `localStorage` keys: `theme` (`light`/`dark`, stamped on `<html>` by
theme-boot.js before first paint), `palette` (the colour preset, stamped in the same breath and
absent for the default aurora — the one deliberate duplicate, since it also lives in `settings`,
because theme-boot.js reads it long before settings.js parses), `session` (the tab strip
snapshot — web pages and Claude chambers, capped at 40, with the new-tab page stored as the
marker `newtab`), `history` (`{v:1, items:[{url,title,visits,last}]}`, capped at 2000),
`settings` (one JSON object, listed under Settings below), `shortcuts` (only the key bindings
you changed, as `{v:1, overrides}`), `zoom` (`{host: level}` — 100% deletes
its entry rather than storing a zero), and `sitestyles` (`{v:1, globalDark,
hosts:{host:{css,dark,js}}}`). A ninth, `reader` (text size, column width), belongs to the
reading page. One thing is deliberately not in there: the new tab's background picture. A 2560px
JPEG as base64 is about a megabyte of string that localStorage would rewrite on every unrelated
settings write, so the blob lives in IndexedDB instead — db `browser`, store `assets`, key
`newtab-bg` — and only the tiny descriptor stays in the settings JSON.

## Keyboard shortcuts

Every combo below is a *default*. shortcuts.js holds the one table both the chrome and the main
process read, and Settings rewrites it, so anything not marked fixed can be moved.

| Default keys | Action |
| --- | --- |
| Ctrl+T | New tab |
| Ctrl+W | Close the active tab (page or Claude) |
| Ctrl+Shift+T | Reopen the last closed tab (stack of 20) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next tab / previous tab (fixed) |
| Ctrl+1–8 / Ctrl+9 | Jump to that position / to the last tab (fixed) |
| Ctrl+Shift+PageUp / PageDown | Move the active tab along the strip |
| Ctrl+Shift+A | Search tabs — open tabs and recently closed ones, filtered as you type |
| Ctrl+K | Command palette — the same pane, showing the browser's own verbs |
| Ctrl+\ | Split view: pair the active tab with the next splittable one, or break the pair |
| Ctrl+Shift+E | Workspaces — the switcher popover (Ctrl+Shift+W is "close the window" everywhere else, so it is left alone) |
| Ctrl+Alt+Right / Ctrl+Alt+Left | Next / previous workspace, wrapping |
| Ctrl+L | Focus the address bar |
| Alt+Left / Alt+Right | Back / forward |
| F5 | Reload (never reloads the shell window; no-op on a Claude tab) |
| Ctrl+H | Open the history page (one tab, reused if it is already open) |
| Ctrl+D | Add this page to the new-tab chips |
| Ctrl+Shift+B | Show or hide the bookmarks bar |
| Ctrl+` | Toggle a Claude tab |
| Ctrl+Shift+` | New Claude tab in a folder you pick |
| Ctrl+Shift+\ | Claude beside: stand a Claude chamber next to the page in front, or break the pair |
| Ctrl+Shift+K | Ask Claude about this page, quoting whatever is selected on it |
| Ctrl+F | Find on page |
| Ctrl+J | Downloads |
| Ctrl+Shift+R | Reader view for the active page |
| Ctrl+Shift+S | Screenshot the page on screen into the Downloads folder |
| Ctrl+P | Print the active page through Chromium's own preview (no-op on a Claude tab) |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| F11 | Fullscreen |
| Alt+P | Picture in picture for the page's video |
| — | Switch light / dark: a real action with no factory key, waiting for one |
| F12 / Ctrl+Shift+I | Devtools for the focused guest page (fixed, handled in main) |
| Escape | Close the tab menu, or the open instrument panel (fixed) |
| Middle-click a tab | Close it |
| Right-click a tab | Duplicate, Move to workspace…, Close, Close other tabs, Close tabs to the right, Reopen closed tab (right-click on bare strip gives New tab / Reopen closed tab) |

**Changing them.** Settings → Shortcuts lists every action under its group — Tabs, Navigate,
Claude, Tools, View — each row wearing its current keys. Change starts recording and the next
combo you press is taken; the capture runs ahead of the browser's own handler, so Ctrl+T records
instead of opening a tab. Escape cancels, Backspace or Delete unbinds the row deliberately, and a
bare modifier is ignored so the panel keeps listening. A combo somebody already holds is not
taken silently: the row says who has it and asks for the same press again, and that second press
displaces the other action, leaving it unbound and named. Reset puts one row back to its default;
Reset all shortcuts arms for four seconds and only a second press clears the lot. Only what you
changed is stored, in `localStorage['shortcuts']` as `{ v:1, overrides: { id: combo|null } }` —
`null` meaning deliberately unbound — and a missing or corrupt record reads as "no overrides"
rather than an error.

Five keys cannot move, because rebinding them would strand you: Ctrl+Tab, Ctrl+Shift+Tab,
Ctrl+1–9, Escape and F12. Their rows show the keys as a hint and offer no Change. Ctrl+R is not a
row either — it is an alias carried on Reload, so it follows Reload wherever Reload goes.

A combo is modifiers in the order Ctrl, Alt, Shift, then one normalised key — `Ctrl+Shift+K`,
`Alt+Left`, `F5`, `Ctrl+=`, `Ctrl+\` — letters uppercase, punctuation as its unshifted character,
Meta never part of one, and a printable key with neither Ctrl nor Alt is just typing; F-keys are
the exception and bind alone.

A focused page swallows its own keys, so main.js listens on every guest's `before-input-event`
and replays the chrome ones over the `shortcut` IPC channel. It holds no opinion of its own about
what a key means: app.js pushes the live combo → action map over `shortcuts:set` at boot and
after every change, so a page-focused key follows the binding you chose — `DEFAULT_BINDINGS` is
only what a renderer that never sends would get, and a payload that is not a usable map is
ignored rather than believed. `comboFromInput()` mirrors shortcuts.js's grammar, shifted
punctuation included, so Ctrl+Shift+\ — a `|` on a US layout — resolves as the chrome would.
Ctrl+Tab, Ctrl+1–9 and F12 are answered ahead of the map; F5, F11 and Escape come through the
fixed `BARE_KEYS`; and Escape is forwarded without being swallowed, since the page wants it too.

## Features

**Tabs.** Drag to reorder (pointer-driven, `body.tab-dragging`), right-click menu, middle-click
close. A guest whose renderer dies gets a `.tab-card` over it — "This page crashed" or "Can't
reach this site" — instead of Chromium's grey page; reload rebuilds the guest. Switching tabs is
a display swap, never a teardown, so page state and live PTYs both survive. Closed page URLs go
on a 20-deep stack for Ctrl+Shift+T (a reader tab pushes the article, not the wrapper). Ctrl+P
and the chip menu's Print… call the guest's own `print()`; a Claude chamber is a no-op there.

**Workspaces.** One window, several named strips. Every tab belongs to a workspace, and the strip
shows only the current one's chips — a display filter, not a teardown, so pages and live PTYs in
the others keep running. A glass pill in the titlebar carries the current workspace's colour dot
and name; clicking it, or Ctrl+Shift+E, opens the switcher, where each row is a workspace with
its tab count: click to switch, rename in place, pick one of six colours off the dot strip
(default plus ion, ember, forest, ocean and midnight), delete — never "main", the one workspace
that must exist — or create a new one, which opens a tab in it, because the window must never sit
empty. A chip's right-click menu has "Move to workspace…", which opens the same popover in move
mode, and the switcher's hint line reads back your own binding rather than a hardcoded chord.
Ctrl+Alt+Right / Left cycle with wrapping, and Ctrl+Shift+Right / Left do the same chrome-side
(never from a text field, where that chord is select-by-word). Switching raises the workspace's
own last active tab, and a split whose halves end up in different workspaces is broken up rather
than left half on screen. workspaces.js owns the pill and the popover and reaches app.js only
through a documented API, every call of it feature-detected: without the module, nothing renders.

**Tab search.** Ctrl+Shift+A, or the list glyph in the titlebar, opens one glass pane over the
page: every open tab — title, host or Claude folder, tags for current / pinned / muted / playing
/ sleeping, its own close button — filtered as you type (every word has to land somewhere),
capped at 12 with a "+N more" line; then, under "Recently closed", up to 8 URLs off the same
20-deep stack Ctrl+Shift+T pops. Arrows walk, Enter raises the tab or reopens the URL, Escape
closes. tabsearch.js only ever adds, and reads app.js's globals through guarded accessors.

**Command palette.** The same pane, one character later. Type `>` into tab search — or press
Ctrl+K, which opens it with the `>` already typed and the caret behind it — and the list swaps
from tabs to the browser's own verbs, each with its keycaps down the right-hand side, run with
Enter. Deleting the `>` puts the tabs back; one input, one row recipe, one set of arrow keys,
only the model underneath changes. The verbs come in families, in this order: making things (new
tab, new Claude tab, a Claude tab in a folder you pick, Claude beside this page, Ask Claude about
this page, split/unsplit); this page (reader, find, search tabs, screenshot, print, pin, mute,
sleep other tabs, reload, close, reopen); workspaces (next, previous); how it looks (zoom,
bookmarks bar, light, dark, and the six palettes as their own checked rows); and the panels
(settings, downloads, open downloads folder, site info, ad blocking, fullscreen, history, clear
browsing history). A row that names an action reads its keycaps out of shortcuts.js as it is
built, so they are your bindings and not a printed guess — and a row whose action you unbound
shows no keys at all. Half the rows read the world the same way, so the label says "Unsplit" or
"Split with next tab" depending on the tab under the cursor. Clearing history is the one row that
asks twice: the first Enter swaps the two lines rather than acting — the warning takes the label
and the verb drops to the hint, so a row found by typing "history" cannot vanish out from under
the query that found it — and only the second Enter clears.

**Split view.** Two tabs side by side in one well — two pages, a page and a Claude chamber, or
two chambers. Ctrl+\ pairs the active tab with the next splittable tab in the strip or breaks
the pair it is in; a chip's menu offers "Split with next tab", "Split with this tab" and
"Unsplit". The pairing is symmetric and lives on the tabs (`tab.splitWith` holds the partner's
id), and a `<webview>` is never moved in the DOM — re-parenting a guest leaves its webContents
alive but stops it painting — so a split is nothing but flex layout on children already there,
in strip order, an inline `flex-basis` carrying the ratio. The `.split-divider` drags to resize
(clamped to 0.2–0.8, behind a transparent scrim so the pointer cannot fall into a guest).
`activeTabId` stays the single source of truth, and clicking the other pane moves it there
without breaking the pair — a press inside a guest never reaches this document, so main forwards
guest focus over `api.onGuestFocus`. A split is deliberately not in the session snapshot.

**Claude beside a page.** The pairing the whole browser exists for, on one key. Ctrl+Shift+\
pairs the tab in front with a Claude chamber — the one you used last, or a fresh one in the
default folder if there is none — and pressing it again breaks the pair; from inside a chamber it
reaches back for the page you were last on. Alt+click on the Claude button is the button's
spelling of the same key, and a page chip's menu carries "Open Claude beside this page", which
always starts a new chamber. A new chamber is built in the background and appended to the end of
the strip, so strip order puts the page on the left, the way round the window is meant to be
read. A chamber is a plain div with `min-width: 0`, so it takes the same flex seat a `<webview>`
does and terminal.js's ResizeObserver refits the PTY as the divider moves. The key works from
inside a focused page as well as from the chrome — main.js maps both spellings, Ctrl+Shift+\ and
the `|` a US layout sends for it, to `claude-split`.

**Claude needs you.** A session that wants you goes quiet, so quiet is the signal. terminal.js
watches the data pump and raises two events on top of the plain `activity` one: `idle`, once per
burst, 1200ms after the last byte and only when at least 200 bytes have arrived since the last
idle — a prompt after real output counts, a cursor blink or a keystroke echo does not, and bytes
under the threshold keep accumulating so a slow trickle still adds up to a burst — and `bell`,
whenever a chunk carries BEL (`\x07`), which Claude Code rings on completion when its own
notification is on. Either one calls for help only if you were not already looking: a chamber on
screen in a focused window says everything a mark could, so `isTabOnScreen(tab) &&
document.hasFocus()` returns early and nothing lights up. Otherwise the chip's dot goes amber and
pulses faster than the live breathe — stepped, three repaints a second, because it sits under a
`backdrop-filter` — a small amber ● is built in front of the title where the eye is already
reading, and the Claude button in the titlebar pulses too for as long as *any* chamber is
waiting. Looking at it clears it. Optionally there is a Windows notification as well — "Claude is
waiting", body the folder name, `silent: true` because the chime is Claude Code's job, at most
one per wait, and clicking it raises the window and the tab. It is behind the `claudeNotify`
switch in Settings and behind the browser's own notification permission; with the toast refused
or off, the chip still carries the mark.

**Ask Claude about this.** The gesture the whole browser is built around: one move takes what is
on screen and puts it in front of a session standing beside it. Three ways in — the guest's
right-click menu — "Ask Claude about this page", and above it `Ask Claude about "<the selection,
elided>"` when there is one — the page chip's menu, and Ctrl+Shift+K. All three land in
`askClaude()`, and main.js only ever carries the facts; nothing is executed from there. What gets
pasted has two shapes, both of which deliberately end where your own typing starts: with a
selection it is `From <url>` and the text in a `"""` block, cursor under it (a selection over
4000 characters is cut, with a line saying so); without one it is `Look at <url> (<title>) and `,
left mid-air so finishing the sentence is the only thing left to do. The chamber it goes to is,
in order: the one this page is already split with, a free chamber stood beside it, a new one
beside it, else whatever chamber exists. That chamber is raised so the keystrokes that follow
land in the terminal. **No Enter is sent anywhere in this path** — the prompt is an opening, and
the question and the moment to send it are yours.

Pasting goes in through xterm's bracketed paste, so a multi-line quote arrives as one block
rather than as N submitted lines, which is what the Claude Code input box wants. A chamber opened
*for* the gesture is still booting when the prompt is composed, so the text waits — and it waits
for the session's first quiet, not for the PTY. `live` only means ConPTY has a process;
`claude.exe` takes seconds more to draw its input box, and anything written before that is read
by whatever it puts up first — a trust prompt, a first-run question — instead of landing in the
box. So the queue flushes on the first `idle` after `live`, with a 30-second cap so a chatty
session can never swallow the text for good. An already-running chamber takes it straight away;
only one that has never settled queues.

**Session.** The strip is snapshotted (debounced 500ms, suppressed while restoring) to two
places: `localStorage['session']` and, over IPC, `session.json` in the profile, which main
writes synchronously to a `.tmp` and renames, so a kill mid-write can only destroy the temp file.
Boot reads both and the newer `savedAt` wins, waiting at most 300ms for the file copy so a hung
main process cannot hold the window at zero tabs. A page entry carries its URL plus its `pinned`
and `muted` flags; a Claude entry carries its `cwd`; alongside them ride the workspaces (name,
colour, and the seat of the tab that was last active in each) and which one was current, so a
restart comes back into the same strip. Chromium flushes localStorage lazily, so a forced kill
can lose the last write to it — the file copy covers that.

**Blocking.** Ghostery's `@ghostery/adblocker-electron` engine owns the webRequest hooks on
`session.defaultSession`, so one engine filters every guest with nothing per-tab to wire up. The
serialised engine is cached at `adblock-engine.bin`; a first run fetches a few MB of lists and is
not awaited by window creation, and with no cache and no network blocking is simply unavailable.
`adblock.json` holds the on/off switch and the per-site allowlist, and the nav-row shield carries
the count blocked on the page in front of you over two switches, this site and everywhere.
Cosmetic filtering rides the library's session-level preload, its IPC handler wrapped so only
`http:`/`https:` frames are served — unwrapped it styles our own `file://` chrome. Turning
blocking off calls `disableBlockingInSession()`, which clears *all* webRequest listeners there.

**Tab audio and pinning.** A chip grows a speaker button the first time its guest plays
something; clicking it mutes the tab without raising it, and the mute rides along in the session
entry and is re-applied on `dom-ready`, since a fresh guest is born unmuted. Pinning makes a
chip icon-only and moves it into the pinned group at the left of the strip — both directions
land on the same index, so it is reversible without reshuffling anything. A pinned chip ignores
middle-click close and is rebuilt before the others on restore.

**Tab sleeping.** A background page tab that has sat untouched past the configured idle time
(default 30 minutes, `0` = never, swept once a minute) gives its renderer back: the `<webview>`
is removed from `#views`, which is what destroys the guest, and a hidden placeholder `<div>`
stands in for it. The chip keeps its title and favicon and does not move. Never slept: the tab
on screen, a pinned tab, anything audible (muted or not), a blank new tab, a crashed tab, a
Claude chamber. Waking rebuilds the guest on the URL snapshotted at sleep time and re-applies the
mute and the site's zoom, so what a live page was holding is gone. Sleep tab / Wake tab sit in
the chip menu.

**Zoom.** Zoom is remembered per `http`/`https` hostname in `localStorage['zoom']`, re-applied on
`dom-ready`, clamped to Electron levels -3..5 in half steps. Anything but 100% shows a
`#zoom-badge` beside the omnibox; clicking it resets, and 100% deletes the stored entry.

**Site styles and scripts.** sitestyles.js keeps `{ css, dark, js }` per host in
`localStorage['sitestyles']`, plus one global force-dark switch. `js` joined the entry later and
the store version did not move: a record written before it reads back with `js: ""`, which is
exactly what a missing key should mean. Host keys are normalised both in and out — lowercased, no
scheme, no userinfo, no `www.`, no port, no path, no trailing dot — and the parent-domain walk
stops short of two-part public suffixes, so nobody styles `co.uk`. CSS is injected per guest on
`dom-ready` and re-applied live, every `insertCSS()` key tracked per tab so a re-apply removes
exactly what this module inserted last time. Dark comes two ways: a host entry with `dark: true`
is unconditional, while the global switch skips any host that has opted out and any page already
dark, measured by its rendered background luminance. A host's `js` is the user's own code, run
once per document after that host's CSS and under the same gate, wrapped in an IIFE whose
try/catch reports a throw to the *page's* console so one broken snippet cannot stop the chain.

**Reader view.** Ctrl+Shift+R (or the nav-row button, hidden until the page probes as readable)
runs `@mozilla/readability` over the active page and opens the article in the bundled
`reader.html`, next to the tab it came from. Everything coming back out of a guest is treated as
hostile: the body is parsed into an inert document and stripped of scripts, frames, plugin
objects, `on*` handlers and `script:` URLs. The reading page owns its top bar — back to the
source, A- / A+, narrow / wide — saved to `localStorage['reader']` and applied from `<head>`
before first paint. A reader tab's URL is `reader.html?src=<article url>`, but the omnibox,
history, session and reopen stack all use the article's own address, so it restores plain.

**Address bar.** A recognised, allow-listed scheme navigates as typed; a localhost or IPv4
host gets `http://`; any other bare domain gets `https://`; everything else is a search through
the configured engine. `#omni-suggest` hangs under the capsule and mirrors its geometry: with
text typed it leads with the row that mirrors what Enter already does, then history matches; on
an empty focus it shows what was open recently. It never navigates itself — it writes into
`#omnibox` and hands Enter back.

**History page.** Ctrl+H opens the whole store as a page now, not the recent dropdown — the
dropdown is still exactly what an empty omnibox focus shows, it just is not what the shortcut is
for any more. One tab, reused if it is already open, on the bundled `historypage.html` with the
chrome's theme and palette in the query string so the first frame is painted right. Search at the
top (`/` focuses it from anywhere on the page, filtering after 60ms of quiet, every word having
to land on the title or the URL) over rows grouped by day — Today, Yesterday, a weekday inside
the last week, then a full date — each row carrying its favicon, title, host, visit count and
time. Enter or a click opens it, Ctrl+click and middle-click open it behind, arrows walk, Delete
removes the highlighted row. "Clear…" offers three ranges: Last hour, Today, Everything.

The page is a guest with no preload, which makes the plumbing the interesting half. Inbound, the
chrome calls `window.__applyHistory({ items, total })` through `executeJavaScript` — newest
first, up to 2000 rows — once on load and again after anything changes the store; historypage.js
is loaded from `<head>` above the stylesheet, like reader-page.js, precisely so that call can
never land on nothing. Outbound there is exactly one channel, and it is `console.log`: the page
writes `__history:{…}`, app.js's `console-message` listener forwards every line from a tab that
`isHistoryTab()` to `History.handleGuestMessage()`, which parses the four ops — `remove`,
`clear`, `clearRange` and `open` — and reports whether it actually acted, so a real request can
be told from an ordinary console line. When it did act, the chrome re-pushes the snapshot to every
history tab; the page also applies each change to its own copy at once, so a removed row goes now
rather than on the next push. Everything on it came off the open web, so titles and URLs are
written with `createElement` and `textContent` only, never by assigning markup.

**Site info.** A lock rides inside the left end of the omnibox capsule and opens a popover saying
what this origin is, what it may do and what it has stored. Its header is the host and the
connection: "Connection is secure" for https; "Connection is not secure" for plain http to
anything but a loopback host; "Certificate isn't trusted" for an https origin Chromium refused
this run (the `certificate-error` handler lets nothing through — there is no click-through UI — it
only *remembers* which origins failed); "Local page" for loopback http and the local schemes. Then
Permissions: every name that can actually prompt, each a three-way Ask / Allow / Block, plus
"Reset permissions" — Ask deletes the decision rather than storing one, because forgetting is not
blocking. Then "Clear cookies and site data", one button that becomes its own confirmation; the
cookie jar is walked by hand, host and parent domain both, because `clearStorageData({ origin })`
matches scheme, host and port exactly and would leave a domain cookie behind. Last, Zoom.

**Find in page.** A right-aligned instrument under the nav row driving the active webview's
`findInPage` / `stopFindInPage`, re-running at most every 60ms while typing.

**Picture in picture.** Alt+P, or the nav-row button that appears once a page proves it has a
video, lifts that video out of the page and floats it over everything else; pressing again puts
it back, and the button wears an on state while it is out. It is entirely a guest capability —
pip.js never touches `window.api`, only `<webview>.executeJavaScript()` — and the toggle runs as
a user gesture, which is what the browser's own picture-in-picture API demands. A page with no
`<video>` in it has nothing to float, so the button stays hidden rather than offering a control
that can only fail; because players are built late and an ad often runs first, the probe re-runs
on every load and, while the tab is making noise, every three seconds until it passes. The only
outcome you hear about is "No video on this page", because it is the only one you cannot see for
yourself, and after every toggle the page is re-asked whether it is floating.

**Page screenshots.** Ctrl+Shift+S writes a PNG of whatever page is on screen to
`<Downloads>\Screenshot <host> <YYYY-MM-DD HH-mm-ss>.png`, flashes the window white for one
stepped frame and says so in a toast, which is the whole output. `capturePage()` lives on the
guest's webContents, which only main can reach, so the renderer hands main a webContents id over
`capture:tab`; main refuses anything that is not a live `webview` guest, so the chrome's own
renderer and a stale id from a closed tab both come back as an error rather than a picture. It is
written with `fs.writeFileSync`, not a DownloadItem, so the PNG never appears in the downloads
panel.

**Bookmarks bar.** Ctrl+Shift+B, or the switch in Look, shows a bar of the new-tab chips under
the address bar. There is no second list of bookmarks in this browser: the chips on the new tab
page *are* the bookmarks, stored once in `Settings.chips()`, so Ctrl+D still adds in one place
and settings is still the one place to edit. The bar is a block child of `.chrome-layer` right
after `.navrow`, so it makes the chrome taller and pushes `#views` down like a real bookmarks bar
rather than floating over the page. Fitting is two passes, since unhiding the "…" button narrows
the strip. `settings.bookmarksBar` is the whole feature's state — the key the switch writes and
the key Ctrl+Shift+B flips — so the two can never be out of step.

**Downloads.** `will-download` picks a unique path in the real Downloads folder and calls
`setSavePath` up front, which is exactly what suppresses the save dialog; if a path cannot be
chosen it falls back to Electron's own prompt rather than losing the download. Turning on
Settings → Downloads → "Ask where to save each file" swaps that for `setSaveDialogOptions`, which
is what puts Windows' own Save dialog on screen — handing Electron options *instead* of a path is
the whole trick — and the chosen path is only readable afterwards, off `item.getSavePath()`.
Cancelling the dialog cancels the item. The preference lives in the renderer's settings store,
which main cannot read, so it is replayed over `dl:prefs` at boot and on every change. The nav-row
button carries a progress ring while anything is in flight and opens a popover listing the
session's downloads, with cancel / pause / resume / show in folder / open / clear, and an Open
folder button in its header that sends `dl:open-folder` — the Downloads folder itself, in
Explorer, whether or not anything has been downloaded this session.

**Palette presets.** Six colour worlds, picked as painted swatches in Look: Aurora (the
original), Ember, Forest, Ocean, Midnight and Mono. `data-palette` on `<html>` overrides the same
ten tokens every time, each authored twice, dark and light, and matched on any descendant as well
as the root so a settings swatch previews the real tokens. "Aurora" is chrome.css's own `:root`
and so the one id that must never reach the attribute. The choice is stored twice, in
`settings.palette` and `localStorage['palette']`, written together so they cannot drift, because
theme-boot.js must stamp the attribute before the first stylesheet paints.

**Settings.** A gear beside the theme toggle opens a popover with eleven sections, in this order:
Look (dark/light, the six palette swatches as one radiogroup with a roving tabindex, accent hue,
and the bookmarks-bar switch); Claude — the folder new Claude tabs start in (typed, or through
the native picker, and only written once main confirms it is a real directory), the switch for
resuming the last conversation on restore, and "Notify me when a Claude tab is waiting", the
`claudeNotify` switch behind the Windows notification described above; Tabs (how long a
background tab may idle before it sleeps, or never); Downloads ("Ask where to save each file",
off by default, which is what every browser does); Search (Google, DuckDuckGo, Bing, Brave,
Startpage); Websites (the site theme guests see through `prefers-color-scheme`); Site styles and
scripts (force dark everywhere, plus the per-host list); New tab (the background picker above the
chips); Privacy (clear browsing history, clear downloads list); Shortcuts, the editor described
above rather than a printed table; and About (Electron and Chromium versions). Everything but the
site styles — a view onto sitestyles.js's own store — and the key bindings, which live in their
own `shortcuts` record, persists as one JSON object in `localStorage['settings']`
(`searchEngine`, `siteTheme`, `palette`, `accentHue`, `chips`, `homepage`, `claudeDir`,
`claudeResume`, `claudeNotify`, `tabSleepMinutes`, `downloadsAskWhere`, `newtabBackground`,
`bookmarksBar`); missing keys fall back to defaults, so an older stored object still reads.

**New tab page.** A plain `file://` page inside a guest — no preload, no `window.api`. The
chrome passes `?theme`, `?palette`, `?hue`, `?engine`, `?chips` and `?bg` for the first paint
and pushes later changes in with `window.__applySettings`. Chips show favicons from
`google.com/s2/favicons`, falling back to the bare label if the request fails. The page cannot
read the history store, so the chrome pushes it up to 8 recent sites with `window.__applyRecent`
on every visit: at most 6 become tiles under the chips, and the rest feed the capsule's own
dropdown. Behind the search field is the circuit board — a socket ring around the capsule,
45-degree traces out to vias and peripheral chips, light packets running them.

**New tab backgrounds.** Three of them, picked in Settings → New tab. *Circuit board* is the
page's own default. *Aurora only* hides the canvas and the packet layer and stops newtab-bg.js
drawing at all, on the same `data-bg` attribute the CSS reads, so nothing hidden still costs
anything. *Your image* is a picture of your own, with a dim slider and a switch for showing the
board over the photo as a texture rather than the subject: the file is decoded with
`createImageBitmap`, drawn down to at most 2560px on its long edge, re-encoded as JPEG at 0.86 —
GIF and SVG are refused — and stored in IndexedDB. The descriptor left in the settings JSON is
`{ kind, boardOverImage, dim, rev }`, and the fresh `rev` on every write is what tells `set()` —
which skips unchanged keys — that the picture behind it moved; the picture itself never travels
on the URL, where `?bg=aurora|image` is a first-paint hint only.

**Board pause under overlays.** A pane with a `backdrop-filter` over the new tab page re-blurs
everything under it on every painted frame — about eleven points of CPU on top of the overlay's
own. So while any panel, menu or suggestion list is open, app.js calls `window.__boardPaused(true)`
in every new-tab guest and the board freezes as a hidden page does: sprites are `Animation.pause()`d
rather than cancelled, so they resume instead of respawning. One `MutationObserver` on `hidden`
catches every pane, so none has to report itself.

**Claude tabs.** pty.js spawns `C:\Users\you\.local\bin\claude.exe` under a real ConPTY, wired
to xterm.js. The cwd is whatever the caller asked for, falling back to the Claude folder from
settings and then to the home directory — a folder that has been deleted, renamed or mistyped
falls back rather than failing the tab. Arguments are allowlisted in pty.js (`ALLOWED_ARGS`,
currently `--continue` and nothing else); anything else is dropped with a warning and the session
still starts, plain. Shift+click the Claude button, or Ctrl+Shift+`, to pick a folder for one
chamber through the native dialog; the chip menu's "Open folder in new Claude tab" starts a
second chamber in the same folder. Restored chambers come back on `claude --continue` unless the
resume switch is off, and in a folder Claude Code has not run in before the first thing in the
chamber is its own trust prompt — that one is Claude's. The environment is scrubbed first: every
`CLAUDE*` variable is deleted except `CLAUDE_CODE_GIT_BASH_PATH` and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, because if the browser was launched from inside a Claude Code
session those markers make the new session think it is a child (transcript saving off, effort
hard-pinned). xterm is opened lazily — building it into a hidden 0x0 container gives a
permanently broken session. When a session exits the pane prints `[session ended] press Enter to
start a new one`, and Enter restarts it in place.

**Permissions.** Electron grants everything by default, which would make this the most generous
browser on the machine, so the handler is explicit. Silently allowed (they need a user gesture
anyway): fullscreen, pointerLock, clipboard-sanitized-write, window-placement, window-management,
keyboardLock. Prompted once per origin: geolocation, notifications, midi, midiSysex,
display-capture, idle-detection, clipboard-read, openExternal, and camera/microphone. Anything
else is denied without asking. The answer outlives the run, in `permissions.json` keyed by origin
— only ever an origin that parses as http(s) and a permission the app knows.

**Context menus.** A `<webview>` has no menu of its own and the built-in `role:` entries act on
the window, so every item calls the guest's own webContents method: navigation, link, image,
selection, Ask Claude, editing and inspect groups.

## Files

| File | What it is |
| --- | --- |
| `main.js` | Electron entry. Owns the single BrowserWindow, window state, acrylic, downloads, page screenshots, permissions, guest context menus, the replayed keystrokes, forwarded guest focus, the PTY IPC bridge, the blocking engine and its counters, the folder picker, `permissions.json`, the certificate-error memory, site info and site-data clearing, and `session.json`. |
| `preload.js` | The `window.api` contextBridge surface: shortcuts, open-url, pty, downloads, paths, versions, `adblock`, `site` (info / setPermission / resetPermissions / clearData / onPermissionsChanged), `capture` (tab / show), `onGuestFocus`, `app` (pickFolder / dirExists), `session`. |
| `app.js` | The chrome: tab strip, webview lifecycle, omnibox, navigation, theme, Claude tabs, split view (pages and chambers alike), the "Claude needs you" mark and its notification, `askClaude()` and the prompt it composes, the history-page push and its `console-message` bridge, the new-tab background push, the overlay watch that freezes the board, session save/restore, tab menu, crash cards. |
| `shortcuts.js` | The one binding table: every rebindable action with its group and default, the combo grammar, the `localStorage['shortcuts']` overrides, and `bindings()` / `actionFor()` / `set()` / `conflict()` / `resetAll()`. Loaded before app.js, which pushes its map to main; main.js keeps a hand copy of the grammar that has to move with it. |
| `workspaces.js` / `workspaces.css` | The workspace instrument: the titlebar pill and the switcher popover (switch, rename, colour, delete, create, and move mode for a tab). Drives app.js's workspace API, which is feature-detected, so a chrome without it renders nothing. |
| `pty.js` | PTY session manager — spawns `claude.exe` under ConPTY with a scrubbed environment. |
| `terminal.js` | `window.ClaudeTerminal`: one xterm.js instance per Claude tab, lazy open, id dispatch, restart, the `activity`/`idle`/`bell` attention events, and the paste queue that waits for a session's first quiet. |
| `index.html` | The shell document: backdrop layers, titlebar, nav row, `#views`, `#tabmenu`, script order. |
| `theme-boot.js` | Runs first in `<head>`; stamps `data-theme` and `data-palette` on `<html>` before any stylesheet paints. |
| `chrome.css` | Every token and every chrome rule, dark block then light block, then the palette presets. |
| `find.js` / `find.css` | Find in page. |
| `downloads.js` / `downloads.css` | Downloads button, progress ring, popover. |
| `history.js` / `history.css` | The history store, the omnibox suggestion lens, `openPage()` for Ctrl+H, and `handleGuestMessage()` — the parser for the history page's console lines. |
| `historypage.html` / `historypage.css` / `historypage.js` | The history page itself: search, day groups, row actions, the Clear… menu. `window.__applyHistory` in, `console.log('__history:…')` out. |
| `pip.js` / `pip.css` | Picture in picture: the nav-row button, the video probe and the toggle, all through `executeJavaScript` in the guest. |
| `settings.js` / `settings.css` | Settings button and popover; owns `localStorage['settings']` and the IndexedDB asset store holding the new tab's background picture. |
| `capture.js` | Ctrl+Shift+S: asks main for a screenshot of the guest on screen, flashes the window once, toasts the result. No button, no panel, no stylesheet. |
| `bookmarks.js` / `bookmarks.css` | The bookmarks bar under the nav row — the new-tab chips, the fit/overflow measurement and the "…" popover. Reads the chips out of settings.js; owns nothing of its own. |
| `shield.js` / `shield.css` | The blocking instrument: nav button, blocked count, the two switches. Talks to main over `api.adblock`. |
| `siteinfo.js` / `siteinfo.css` | The site instrument: the lock in the omnibox capsule and its popover — connection, permissions, clear site data, zoom. Talks to main over `api.site`. |
| `tabsearch.js` / `tabsearch.css` | Tab search and the command palette: the titlebar button, the filtering pane over open and recently closed tabs, and — behind a `>` — the browser's own verbs. |
| `sitestyles.js` | Per-host CSS, per-host scripts and force dark; owns `localStorage['sitestyles']` and injects into each guest. |
| `reader.js` / `reader.css` | The reader button: probes a page, runs Readability, sanitises the article, opens the reading tab. |
| `reader.html` / `reader-page.css` / `reader-page.js` | The reading page itself: top bar, text size and width, `window.__applyArticle`. Owns `localStorage['reader']`. |
| `newtab.html` / `newtab.css` / `newtab.js` | The search page: chips, engine, favicons, placeholder, and the background layers behind them (`window.__applyBackground`, `data-bg`, `#bg-image` / `#bg-dim`). |
| `newtab-theme.js` | First script on the new tab page; resolves `?theme`, `?palette` and `?hue` before the stylesheet. |
| `newtab-bg.js` | The circuit board — canvas painted once per layout, packets as DOM on Web Animations. Owns `window.__boardPaused` / `__boardState`, the freeze the chrome drives while an overlay is open. |
| `smoketest.js` | Launches the app on CDP port 9222, checks the required chrome ids, proves a Claude PTY spawns and renders. |
| `cdp-eval.js` | Evaluate one expression in the running test instance. |
| `cdp-profile.js` | CPU-profile the running test instance and print the hottest functions by self time. |
| `assets/` | `browser.ico` and `browser.png` (the app/shortcut icon). |

Runtime dependencies beyond Electron: `@homebridge/node-pty-prebuilt-multiarch` (ConPTY),
`@xterm/xterm` with `@xterm/addon-fit`, `@ghostery/adblocker-electron` with
`@ghostery/adblocker-electron-preload` (which nothing here names — the blocker resolves its path
itself), and `@mozilla/readability`, loaded out of `node_modules/` by index.html as a classic
script so it leaves a global `Readability`. `ws` is a devDependency, for CDP.

## Design rules worth keeping

- Every colour resolves through a token. A theme is nothing but a second token block and a
  palette a third, and no rule below the token blocks tests `data-theme` or `data-palette`. The
  light theme is custom properties only; type and metric tokens are inherited, not redeclared.
- Anything floating over a page uses `--panel-bg`, not `--glass`. Glass is see-through, and
  there is nothing behind a popover to blur except the guest's own content.
- No continuous animation under `backdrop-filter`. Everything that moves is stepped, because a
  drifting full-screen effect behind the blur once cost about a quarter of a core for the chrome
  alone — and it is why the new tab's board freezes while any chrome pane is open.
- System fonts only: `--ui-font` is Bahnschrift / Segoe UI Variable / Segoe UI, `--icon-font`
  is Segoe Fluent Icons with the MDL2 fallback. Glyphs are written as codepoint escapes so no
  encoding round-trip can eat a private-use character.
- `--ion` (ice cyan, or the palette's accent, or a chosen hue) is the one accent and marks what is
  active. `--amber` means exactly one thing: a Claude session — live, or waiting on you.
- `#views webview` keeps a white background in both themes. A guest page is transparent, so this
  is what a site without its own background paints on; the theme ink made dark mode look like it
  was forcing every plain page dark.

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
instance you drive by hand should be started with `--test-profile` for the same reason the smoke
test does: its storage and theme choice stay out of the real profile, at
`%LOCALAPPDATA%\Temp\browser-test-profile`, which is where a test run's `session.json`,
`adblock.json` and `adblock-engine.bin` land too. The test polls for `body.booted` before it
touches any tab, then closes any Claude tabs the restored session brought back.

Never kill every `electron.exe` — I run my own Claude Code instance on Electron and it will go
down with it. Kill only the test instance: find the PID whose command line contains
`remote-debugging-port=9222` and no `--type=` (that filters out the renderer and GPU children,
which die with their parent anyway).
