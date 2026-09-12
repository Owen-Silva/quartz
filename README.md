# Browser

My own browser. Electron 44 shell, frosted-glass chrome lit from behind by an aurora, in a
dark theme and a light one that are the same instruments in daylight. Claude Code sessions
are tabs, not a side pane: a tab is either a `<webview>` page or a `.claude-view` chamber
running one real `claude.exe` under ConPTY, and both live in `#views` side by side. New tabs
open a bundled circuit-board page with shortcut chips, a clock and a live strip of system stats.
Electron rather than Tauri because Tauri's build wants a C++ toolchain and this machine does
not have one; Electron ships its own Chromium and needs nothing installed.

## Running it

```
npm start          # = electron .
npx electron .     # same thing without the script
```

Run `npm install` after pulling a change that adds a dependency; `koffi`, for the native app-tab
engine, is the newest one.

The Start Menu entry `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Browser.lnk` launches
`electron.exe` with this project path as its argument. It is pinned to the taskbar by hand:
Windows 11 refuses scripted pinning, so a lost pin has to be re-done from the Start Menu.

Settings → About has a "Restart browser" button, and the command palette has a "Restart browser"
row. Either one flushes the session and the window state, releases any Spotify auto-pause hold,
and relaunches with the same arguments, tabs restored. Use it after pulling an update: a copy that
is already running keeps the old code, and a code change only takes effect after a restart.

Three CLI flags:

| Flag | Effect |
| --- | --- |
| `--test-profile` | Points Electron's `userData` at `%TEMP%\browser-test-profile`, so a test run's cookies, storage, theme and window geometry never touch the real profile. |
| `--profile-name=<x>` | Only read alongside `--test-profile`. Suffixes the test profile directory — `%TEMP%\browser-test-profile-<x>` — so two test instances never share a LevelDB or a window state. The name is stripped to letters, digits and hyphens. |
| `--no-acrylic` | Skips the DWM acrylic backdrop and opens a flat window. Used to measure what the material costs. Acrylic is only attempted on Windows 11 22H2 (build 22621) or later, and falls back to flat by itself if `backgroundMaterial: 'acrylic'` throws. |

The profile lives at `%APPDATA%\browser` (Electron's default `userData` for the app name
`browser` in `package.json`). Inside it: `window-state.json` holds the remembered window
rectangle plus `maximized`, discarded on read if it is not JSON or if the saved rect no longer
overlaps a connected display by at least 100px on each axis; `session.json` is the durable copy
of the tab strip; `adblock.json` holds the blocking preferences (on/off plus the per-site
allowlist); `adblock-engine.bin` is the serialised filter engine, fetched on first run;
`permissions.json` holds the per-origin decisions as `{ origin: { permission: 'allow'|'block' } }`,
read as "nothing decided yet" when it is missing or corrupt; `autopause.json` holds the
Spotify auto-pause preferences (the two switches and the site list); `apps-index.json` is the
cached index of installed apps, rebuilt once it is more than 24 hours old; and `proc-icons.json` is
the icon cache the Processes list draws from, written to a temp name and renamed, capped at 300
entries, with nulls retried after an hour and paths re-checked after a day.

Renderer state is nine `localStorage` keys: `theme` (`light`/`dark`, stamped on `<html>` by
theme-boot.js before first paint), `palette` (the colour preset, stamped in the same breath and
absent for the default aurora — the one deliberate duplicate, since it also lives in `settings`,
because theme-boot.js reads it long before settings.js parses), `session` (the tab strip
snapshot — web pages and Claude chambers, capped at 40, with the new-tab page stored as the
marker `newtab`), `history` (`{v:1, items:[{url,title,visits,last}]}`, capped at 2000),
`settings` (one JSON object, listed under Settings below), `shortcuts` (only the key bindings
you changed, as `{v:1, overrides}`), `zoom` (`{host: level}` — 100% deletes its entry rather
than storing a zero), `sitestyles` (`{v:1, globalDark, hosts:{host:{css,dark,js}}}`), and
`userstyle` (your own CSS for the chrome — a plain string, not JSON: there is exactly one value,
and an envelope would only invent a way for it to be corrupt). A tenth, `reader` (text size,
column width), belongs to the reading page. One thing is deliberately
not in there: the new tab's background picture. A 2560px JPEG as base64 is about a megabyte of
string that localStorage would rewrite on every unrelated settings write, so the blob lives in
IndexedDB instead — db `browser`, store `assets`, key `newtab-bg`.

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
| Ctrl+Alt+E | Files — the folder browser, as a tab (Ctrl+Shift+E stays on Workspaces) |
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
| Ctrl+Alt+K | Show Claude this page — a screenshot of it, handed over by path |
| Ctrl+Alt+Shift+K | Ask Claude about this article — the page's own readable text, quoted |
| Ctrl+F | Find on page |
| Ctrl+J | Downloads |
| Ctrl+Shift+R | Reader view for the active page |
| Ctrl+Shift+S | Screenshot the page on screen into the Downloads folder |
| Ctrl+P | Print the active page through Chromium's own preview (no-op on a Claude tab) |
| Ctrl+, | Settings |
| Ctrl+Alt+Shift+R | Reset the browser style — empties your chrome stylesheet, from anywhere |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| F11 | Fullscreen |
| Alt+P | Picture in picture for the page's video |
| — | Switch light / dark: a real action with no factory key, waiting for one |
| F12 / Ctrl+Shift+I | Devtools for the focused guest page (fixed, handled in main) |
| Escape | Close the tab menu, or the open instrument panel (fixed) |
| Middle-click a tab | Close it |
| Ctrl+click the Claude button | Resume a conversation — Claude Code's own picker, in the default folder |
| Right-click a tab | Duplicate, Move to workspace…, Close, Close other tabs, Close tabs to the right, Reopen closed tab (bare strip: New tab, New Claude tab in folder…, Resume a Claude conversation…, Sleep other tabs, Reopen closed tab) |

**Changing them.** Settings → Shortcuts lists every action under its group — Tabs, Navigate,
Claude, Tools, View — each row wearing its current keys. Change starts recording and the next
combo you press is taken; the capture runs ahead of the browser's own handler, so Ctrl+T records
instead of opening a tab. Escape cancels, Backspace or Delete unbinds the row deliberately, and a
bare modifier is ignored so the panel keeps listening. A combo somebody already holds is not
taken silently: the row says who has it and asks for the same press again, and that second press
displaces the other action, leaving it unbound and named. Reset puts one row back; Reset all arms
for four seconds. Only what you changed is stored, in `localStorage['shortcuts']` as
`{ v:1, overrides: { id: combo|null } }` — `null` meaning deliberately unbound.

Five keys cannot move, because rebinding them would strand you: Ctrl+Tab, Ctrl+Shift+Tab,
Ctrl+1–9, Escape and F12. Their rows show the keys as a hint and offer no Change. Ctrl+R is not a
row either — it is an alias carried on Reload, so it follows Reload wherever Reload goes.

A combo is modifiers in the order Ctrl, Alt, Shift, then one normalised key — `Ctrl+Shift+K`,
`Alt+Left`, `F5`, `Ctrl+=`, `Ctrl+\` — letters uppercase, punctuation as its unshifted character,
Meta never part of one, and a printable key with neither Ctrl nor Alt is just typing; F-keys are
the exception and bind alone.

A focused page swallows its own keys, so main.js listens on every guest's `before-input-event`
and replays the chrome ones over the `shortcut` IPC channel. It holds no opinion about what a key
means: app.js pushes the live combo → action map over `shortcuts:set` at boot and after every
change (bounded and validated — see Security notes), so a page-focused key follows the binding you
chose. `comboFromInput()` mirrors shortcuts.js's grammar, shifted punctuation included, so
Ctrl+Shift+\ — a `|` on a US layout — resolves as the chrome would; Ctrl+Tab, Ctrl+1–9 and F12 are
answered ahead of the map, and Escape is forwarded without being swallowed.

## Features

**Tabs.** Drag to reorder (pointer-driven, `body.tab-dragging`), right-click menu, middle-click
close. A guest whose renderer dies gets a `.tab-card` over it — "This page crashed" or "Can't
reach this site" — instead of Chromium's grey page; reload rebuilds the guest. Switching tabs is
a display swap, never a teardown, so page state and live PTYs both survive. Closed page URLs go
on a 20-deep stack for Ctrl+Shift+T.

**Popups and `target=_blank`.** Links become tabs; sign-in popups stay windows. Guests carry
`allowpopups`, so Chromium lets `window.open` and `target=_blank` through to a handler instead of
killing them at the source, and main installs `setWindowOpenHandler` on each guest's `webContents`.
It decides by disposition. A `target=_blank` link or a middle-click — `foreground-tab` and
`background-tab` — is denied the window and sent to the chrome as `open-url`, where app.js opens a
tab, in front or behind to match. `window.open` with features, the `new-window` disposition, is
allowed as a real child `BrowserWindow`: size from the features and clamped, centred over the main
window, parent set but not modal, sandboxed with no preload and no devtools, on the same session,
adopted on `did-create-window` so its own links open as tabs, its title following the page, and
closed with the main window. `javascript:`, `data:`, `file:` and custom schemes are refused there as
everywhere else. This replaces the `<webview>` `new-window` DOM event, which Electron removed in
v22 — the listener app.js had been carrying was dead code. The reason for the child window is
`window.opener`: a tab has none, so every OAuth flow that posts its result back to the page that
opened it — Google Sign-In above all — lost the credential and left a white popup page beside a
blank tab. Verified on the real thing: Pixabay → Log in → Continue with Google opens one popup on
accounts.google.com with `window.opener` set, no stray tab, and the page behind it intact.

**Workspaces.** One window, several named strips. Every tab belongs to a workspace, and the strip
shows only the current one's chips — a display filter, not a teardown, so pages and live PTYs in
the others keep running. A glass pill in the titlebar carries the current workspace's colour dot
and name; clicking it, or Ctrl+Shift+E, opens the switcher, where each row is a workspace with
its tab count: click to switch, rename in place, pick one of six colours, delete — never "main",
the one workspace that must exist — or create a new one, which opens a tab in it, because the
window must never sit empty. A chip's menu has "Move to workspace…". Ctrl+Alt+Right / Left cycle
with wrapping, switching raises that workspace's own last active tab, and a split whose halves
land in different workspaces is broken up.

**Tab search.** Ctrl+Shift+A, or the list glyph in the titlebar, opens one glass pane over the
page: every open tab — title, host or Claude folder, tags for current / pinned / muted / playing
/ sleeping, its own close button — filtered as you type (every word has to land somewhere), capped
at 12 with a "+N more" line; then, under "Recently closed", up to 8 URLs off the same 20-deep
stack Ctrl+Shift+T pops. Arrows walk, Enter raises or reopens, Escape closes.

**Command palette.** The same pane, one character later. Type `>` into tab search — or press
Ctrl+K, which opens it with the `>` already typed and the caret behind it — and the list swaps
from tabs to the browser's own verbs, each with its keycaps down the right-hand side, run with
Enter. Deleting the `>` puts the tabs back; one input, one row recipe, one set of arrow keys,
only the model underneath changes. The verbs come in families: making things (tabs, chambers, the
four Claude hand-offs, split/unsplit); this page (reader, find, screenshot, print, pin, mute,
sleep others, reload, close, reopen); workspaces; how it looks; the panels; and "Restart browser".
A row reads its keycaps out of shortcuts.js as it is built, so they are your bindings and not a
printed guess, and half the rows read the world too — "Unsplit" or "Split with next tab" depending
on the tab under the cursor. Clearing history asks twice, the first Enter swapping the two lines
rather than acting. The last family is the machine's own apps: one "Open <name>" row per installed
app, built the first time the `>` list is asked for rather than at boot, with the running ones
sorted to the top reading "Running, switch to it", so Enter raises that window instead of launching
a second copy. Apps reach a plain query too: without the `>`, up to five matching apps are listed
under an "Apps" caption after the tab and recently-closed rows, and the empty note reads "No matching
tabs, apps or history".

**Split view.** Two tabs side by side in one well — two pages, a page and a Claude chamber, or
two chambers. Ctrl+\ pairs the active tab with the next splittable tab in the strip or breaks
the pair it is in; a chip's menu offers "Split with next tab", "Split with this tab" and
"Unsplit". The pairing is symmetric and lives on the tabs (`tab.splitWith` holds the partner's
id), and a `<webview>` is never moved in the DOM — re-parenting a guest leaves its webContents
alive but stops it painting — so a split is nothing but flex layout on children already there, in
strip order, an inline `flex-basis` carrying the ratio. The `.split-divider` drags to resize
(clamped to 0.2–0.8). `activeTabId` stays the single source of truth, and clicking the other pane
moves it there without breaking the pair, main forwarding guest focus over `api.onGuestFocus`.

**Claude beside a page.** The pairing the whole browser exists for, on one key. Ctrl+Shift+\
pairs the tab in front with a Claude chamber — the one you used last, or a fresh one in the
default folder if there is none — and pressing it again breaks the pair; from inside a chamber it
reaches back for the page you were last on. Alt+click on the Claude button is the button's
spelling of the same key, and a page chip's menu carries "Open Claude beside this page", which
always starts a new chamber. A new chamber is built in the background and appended to the end of
the strip, so strip order puts the page on the left. A chamber is a plain div with `min-width: 0`,
so it takes the same flex seat a `<webview>` does. The key works from inside a focused page too —
main.js maps both spellings, Ctrl+Shift+\ and the `|` a US layout sends for it, to `claude-split`.

**Claude needs you.** A session that wants you goes quiet, so quiet is the signal. terminal.js
watches the data pump and raises two events on top of the plain `activity` one: `idle`, once per
burst, 1200ms after the last byte and only when at least 200 bytes have arrived since the last
idle — a prompt after real output counts, a cursor blink or a keystroke echo does not — and
`bell`, whenever a chunk carries BEL (`\x07`), which Claude Code rings on completion. Either one
calls for help only if you were not already looking, so `isTabOnScreen(tab) &&
document.hasFocus()` returns early. Otherwise the chip's dot goes amber and pulses faster than
the live breathe — stepped, three repaints a second, because it sits under a `backdrop-filter` —
a small amber ● is built in front of the title, and the Claude button pulses too for as long as
*any* chamber is waiting. Looking at it clears it. Behind the `claudeNotify` switch and the
browser's own notification permission there is a Windows toast as well — "Claude is waiting", the
folder name, `silent: true`, one per wait, clicking it raises the window and the tab — and with it
off the chip still marks.

**Ask Claude about this.** The gesture the whole browser is built around: one move takes what is
on screen and puts it in front of a session standing beside it. Three ways in — the guest's
right-click menu — "Ask Claude about this page", and above it `Ask Claude about "<the selection,
elided>"` when there is one — the page chip's menu, and Ctrl+Shift+K. All three land in
`askClaude()`, and main.js only ever carries the facts; nothing is executed from there. What gets
pasted has two shapes, both ending where your own typing starts: with a selection, `From <url>`
and the text in a `"""` block (over 4000 characters is cut, with a line saying so); without one,
`Look at <url> (<title>) and `, left mid-air. The chamber it goes to is, in order: the one this
page is already split with, a free chamber stood beside it, a new one beside it, else whatever
chamber exists, raised so the keystrokes that follow land in the terminal. **No Enter is sent
anywhere in this path** — the question and the moment to send it are yours.

Pasting goes in through xterm's bracketed paste, so a multi-line quote arrives as one block
rather than as N submitted lines, which is what the Claude Code input box wants. A chamber opened
*for* the gesture is still booting when the prompt is composed, so the text waits — and it waits
for the session's first quiet, not for the PTY. `live` only means ConPTY has a process;
`claude.exe` takes seconds more to draw its input box, and anything written before that is read
by whatever it puts up first. So the queue flushes on the first `idle` after `live`, with a
30-second cap. An already-running chamber takes it straight away.

One quiet is not always the input box. In a folder Claude Code has not run in before the first
thing it draws is its own trust prompt, and a paste landing there would be read as the answer —
so before every flush terminal.js reads the bottom 60 lines of the buffer and holds the queue
while `trust this folder`, `Quick safety check` or `Enter to confirm` is on it, re-arming the
same cap to wait for the quiet after the answer. A buffer it cannot read never blocks.

**Show Claude this page.** The same gesture one sense further along: Claude Code opens an image
file when it is handed the path, so a screenshot plus a line of text is a real multimodal
hand-off — the layout, the chart, the error dialog, the bit with no text to quote. Ctrl+Alt+K,
the guest's right-click menu, the chip's menu and the palette all land in `showClaudeThisPage()`.
capture.js's `captureActive()` takes the same PNG Ctrl+Shift+S does with none of the theatre — no
flash, no toast, no downloads nudge, because the pasted prompt is the receipt — and the tab is
brought to the front for two frames first, since `capturePage()` only ever reads the guest on
screen. The prompt is `Look at the screenshot <path> of <url> (<title>) and `, the path written
with forward slashes because backslashes meet no escaping rule between the terminal and the tool
that opens it. A capture that refuses or fails toasts "Couldn't capture this page" and stops:
pasting the path of a PNG that is not there would be worse than nothing.

**Ask Claude about this article.** Ask hands over a link and Show hands over a picture; this hands
over the WORDS, so a session that cannot browse can still answer from the page. Ctrl+Alt+Shift+K
and the same three menus reach `askClaudeAboutArticle()`, which calls `Reader.extract(tab)` — the
reader's own Readability pass, feature-detected and never rejecting — for
`{ title, byline, textContent, url }` or null. The chip row is hidden only when the reader probe
has already answered false, because "not known" is not "no". The text is made safe to read in a
terminal (a run of inline whitespace becomes one space, a run of breaks one blank line, so the
paragraphs survive and the source indentation does not) and quoted as `From <url> — "<title>" by
<byline>`, then the article in a `"""` block, ending on a blank line where your question starts.
It is a quote, not an attachment: over **12,000 characters** the body is cut with a line saying
so. A page with no article in it toasts "No article here, sending the link" and falls back to
plain Ask, which sends the link instead. Same chamber choice as Ask for both, same INPUT, and no
Enter is sent from either.

**Session.** The strip is snapshotted (debounced 500ms, suppressed while restoring) to two places:
`localStorage['session']` and, over IPC, `session.json` in the profile, which main writes
synchronously to a `.tmp` and renames, so a kill mid-write can only destroy the temp file. Boot
reads both and the newer `savedAt` wins, waiting at most 300ms for the file copy so a hung main
process cannot hold the window at zero tabs. A page entry carries its URL plus its `pinned` and
`muted` flags, a Claude entry its `cwd`, and alongside them ride the workspaces. Chromium flushes
localStorage lazily, so a forced kill can lose the last write to it — the file copy covers that.

**Blocking.** Ghostery's `@ghostery/adblocker-electron` engine owns the webRequest hooks on
`session.defaultSession`, so one engine filters every guest with nothing per-tab to wire up. The
serialised engine is cached at `adblock-engine.bin`; a first run fetches a few MB of lists and is
not awaited by window creation. `adblock.json` holds the on/off switch and the per-site allowlist,
and the nav-row shield carries the count blocked on the page in front of you over two switches,
this site and everywhere. Cosmetic filtering rides the library's session-level preload, its IPC
handler wrapped so only `http:`/`https:` frames are served. Two exception filters are applied when
the engine is built, `@@||youtube.com/youtubei/` and `@@||youtube.com/api/stats/`, because the ads
and tracking lists cancel `youtube.com/youtubei/v1/log_event` and `youtube.com/api/stats/ads`. They
ride the same NetworkFilter and `blocker.update` path the per-site allowlist uses, and ad delivery is
unchanged: `/pagead/`, doubleclick and googlesyndication still block. The Electron user agent is
left as it is.

**YouTube and scriptlets.** Clicking a video on YouTube is a same-document navigation, so the player
is built from a fetch, not from a fresh document — which is why a reload always appeared to fix a
player that would not start. The exception filters above were the first guess and were not the cause.
The cause is scriptlets: the ads list carries scriptlet rules for youtube.com (json-prune,
replace-fetch-response, prevent-xhr) that the adapter injects with `executeJavaScript` to strip ad
fields out of the player response, so the SPA's next fetch comes back rewritten and the player never
builds — `ytd-player` in the DOM, no `#movie_player`, no video. The cosmetics lookup is wrapped to
answer an empty script list for youtube.com and its subdomains; the cosmetic CSS and every network
rule still apply. Measured live, 20 seconds a round: stock 0 of 5 videos played, blocking off 3 of 3,
scriptlets off for youtube.com 5 of 5. An in-stream ad can still play, as it already did on the
reload path — this fixes the player, it does not skip ads. It also stops the "Script failed to
execute" rejections in the main log, which were those injections losing the race.

**Tab audio and pinning.** A chip grows a speaker button the first time its guest plays
something; clicking it mutes the tab without raising it, and the mute rides in the session entry
and is re-applied on `dom-ready`, since a fresh guest is born unmuted. Pinning makes a chip
icon-only and moves it into the pinned group at the left of the strip — both directions land on
the same index, so it is reversible — and a pinned chip ignores middle-click close.

**Tab sleeping.** A background page tab that has sat untouched past the configured idle time
(default 30 minutes, `0` = never, swept once a minute) gives its renderer back: the `<webview>` is
removed from `#views`, which is what destroys the guest, and a hidden placeholder `<div>` stands
in for it. The chip keeps its title and favicon and does not move. Never slept: the tab on screen,
a pinned tab, anything audible (muted or not), a blank new tab, a crashed tab, a Claude chamber.
Waking rebuilds the guest on the URL snapshotted at sleep time and re-applies the mute and the
site's zoom. It is the one lever that gives memory back — see Performance.

**Site styles and scripts.** sitestyles.js keeps `{ css, dark, js }` per host in
`localStorage['sitestyles']`, plus one global force-dark switch. Host keys are normalised both in
and out, and the parent-domain walk stops short of two-part public suffixes, so nobody styles
`co.uk`. CSS is injected per guest on `dom-ready` and re-applied live, every `insertCSS()` key
tracked per tab so a re-apply removes exactly what this module inserted last time. A host entry
with `dark: true` is unconditional; the global switch skips any host that opted out and any page
already dark by rendered background luminance. A host's `js` is the user's own code, run once per
document after that host's CSS, in an IIFE whose try/catch reports a throw to the *page's*
console, so one broken snippet cannot stop the chain.

**Reader view.** Ctrl+Shift+R (or the nav-row button, hidden until the page probes as readable)
runs `@mozilla/readability` over the active page and opens the article in the bundled
`reader.html`, next to the tab it came from. Readability is not in index.html: it is ~100KB that
only the reader ever touches, so `loadReadability()` injects it on the first open and every later
open reuses the global it leaves behind. Everything coming back out of a guest is treated as
hostile, in two passes — see Security notes. The reading page owns its top bar — back to the
source, A- / A+, narrow / wide — saved to `localStorage['reader']` and applied before first paint.
A reader tab's URL is `reader.html?src=<article url>`, but the
omnibox, history, session and reopen stack all use the article's own address, so it restores plain.

**Address bar.** A recognised, allow-listed scheme navigates as typed; a localhost or IPv4 host
gets `http://`; any other bare domain gets `https://`; everything else is a search through the
configured engine. `#omni-suggest` hangs under the capsule and mirrors its geometry: with text
typed it leads with the row that mirrors what Enter already does, then history matches; on an
empty focus, what was open recently. It never navigates itself — it writes into `#omnibox` and
hands Enter back.

**History page.** Ctrl+H opens the whole store as a page, not the recent dropdown — the dropdown
is still what an empty omnibox focus shows. One tab, reused if it is already open, on the bundled
`historypage.html`. Search at the top (`/` focuses it, filtering after 60ms of quiet, every word
having to land on the title or the URL) over rows grouped by day — Today, Yesterday, a weekday
inside the last week, then a full date — each row carrying its favicon, title, host, visit count
and time. Enter or a click opens it, Ctrl+click and middle-click open it behind, arrows walk,
Delete removes the highlighted row. "Clear…" offers Last hour, Today, Everything.

The page is a guest with no preload, which makes the plumbing the interesting half. Inbound, the
chrome calls `window.__applyHistory({ items, total })` through `executeJavaScript` — newest first,
up to 2000 rows — from a historypage.js loaded above the stylesheet so the call can never land on
nothing. Outbound there is exactly one channel, and it is `console.log`: the page writes
`__history:{…}`, app.js's `console-message` listener forwards every line from a history tab to
`History.handleGuestMessage()`, which parses `remove`, `clear`, `clearRange` and `open`.
Everything there came off the open web, so titles and URLs are written with `textContent` only,
never as markup.

**Files tab.** Ctrl+Alt+E, or the "Files" row in the command palette, opens the bundled
`files.html` as a tab with a blank omnibox — Ctrl+Shift+E was left where it was, on Workspaces. A
left rail lists your own folders and every drive with a free-space bar, a breadcrumb path bar turns
into a text field on Ctrl+L, a filter narrows the current listing, and the listing itself has a 16px
icon slot, size and modified columns, header sort remembered in `localStorage`, arrows, Enter,
Backspace, Home and End, double-click to open, and a right-click menu with Open, Show in Explorer
and Copy path. Empty, error and truncated states are all drawn.

Main answers `files:list` / `places` / `open` / `reveal` / `icons` / `copy-path` for the chrome
sender only: drive-letter or UNC paths, `readdir` with file types, folders first, a 2,000-row cap
reported as truncated, `stat` in waves of 64, errors mapped to not-found / access-denied /
not-a-folder, drives probed with `statfs` from C to Z, and icons from `app.getFileIcon` cached per
extension. The page has no preload, so it talks back over a `files:` console channel with the same
guards as the new tab's — only from the tab that owns the guest, only for the files URL — receiving
`__applyFiles`, `__applyFilePlaces`, `__applyFileIcons` and `__applyFileResult`. Downloads listed 340
rows in 142ms here. Volume labels are always empty: Electron exposes none without a spawn.

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
matches scheme, host and port exactly. Last, Zoom, remembered per `http`/`https` hostname in
`localStorage['zoom']`, re-applied on `dom-ready`, clamped to Electron levels -3..5 in half steps;
anything but 100% shows a `#zoom-badge` beside the omnibox, clicking it resets, and 100% deletes
the stored entry.


**Find in page.** A right-aligned instrument under the nav row driving the active webview's
`findInPage` / `stopFindInPage`, re-running at most every 60ms while typing.

**Picture in picture.** Alt+P, or the nav-row button that appears once a page proves it has a
video, lifts that video out of the page and floats it over everything else; pressing again puts it
back. It is entirely a guest capability — pip.js never touches `window.api`, only
`<webview>.executeJavaScript()`. A page with no `<video>` has nothing to float, so the button
stays hidden; because players are built late and an ad often runs first, the probe re-runs on
every load and, while the tab is making noise, every three seconds until it passes.

**Page screenshots.** Ctrl+Shift+S writes a PNG of whatever page is on screen to
`<Downloads>\Screenshot <host> <YYYY-MM-DD HH-mm-ss>.png`, flashes the window white for one
stepped frame and says so in a toast, which is the whole output. `capturePage()` lives on the
guest's webContents, which only main can reach, so the renderer hands main a webContents id over
`capture:tab`; main refuses anything that is not a live `webview` guest, so the chrome's own
renderer and a stale id from a closed tab both come back as an error rather than a picture. It is
written with `fs.writeFileSync`, not a DownloadItem, so the PNG never appears in the downloads
panel — and "show in folder" on it is confined to Downloads (see Security notes).

**Bookmarks bar.** Ctrl+Shift+B, or the switch in Look, shows a bar of the new-tab chips under
the address bar. There is no second list of bookmarks in this browser: the chips on the new tab
page *are* the bookmarks, stored once in `Settings.chips()`, so Ctrl+D still adds in one place
and settings is still the one place to edit. The bar is a block child of `.chrome-layer` right
after `.navrow`, so it makes the chrome taller and pushes `#views` down rather than floating over
the page. `settings.bookmarksBar` is the whole feature's state — the key the switch writes and the key
Ctrl+Shift+B flips — so the two can never be out of step.

**Downloads.** `will-download` picks a unique path in the real Downloads folder and calls
`setSavePath` up front, which is exactly what suppresses the save dialog. Turning on
Settings → Downloads → "Ask where to save each file" swaps that for `setSaveDialogOptions` —
handing Electron options *instead* of a path is the whole trick — and the chosen path is only
readable afterwards, off `item.getSavePath()`. The preference lives in the renderer's settings
store, which main cannot read, so it is replayed over `dl:prefs` at boot and on every change. The
nav-row button carries a progress ring while anything is in flight and opens a popover listing
the session's downloads, with cancel / pause / resume / show in folder / open / clear.

**Spotify auto-pause.** The auto-pause tool already installed at `~/spotify-autopause` is a local
PowerShell HTTP bridge (127.0.0.1, the first free of ports 8787 to 8790) held up by a scheduled
task, with an Opera GX extension speaking to it. autopause.js is that same client protocol spoken
from this browser, plus the switch that turns the whole-computer half on and off. Nothing under
that folder is written from here: this is a client, never an installer, and with the tool absent
Settings still draws the section, disables the switches and says "Not installed on this computer".
Preferences are `autopause.json` in the profile, and the renderer reaches main over
`api.autopause` (status, setEnabled, setConfig, doctor, onStatus), every call resolving, a failure
arriving as plain English in `status.error` rather than as a rejected invoke, because a throw
there would surface as a dead section.

Two prongs. Settings → Spotify's first switch is the whole computer: on enables the
`SpotifyAutoPause` scheduled task and runs it, off ends it *and* disables it, because the task
carries a repeating keepalive trigger and one that is only ended restarts itself within minutes.
Where the task is missing altogether, the switch launches the bridge directly and remembers the
choice. The second prong, behind its own switch ("Also pause for videos in this browser"), is this
browser's own tabs: a guest that is audible on a watched site (YouTube, Twitch, Kick, Vimeo,
Dailymotion, TikTok, Netflix, Hulu, Disney+, Prime Video, Max, Peacock, Crunchyroll and the
LessonPlayer sites out of the box, editable a host per line, or any tab at all behind "Any tab that
makes sound") registers
a hold with the bridge under `src=owen-browser`, an id of its own, because the bridge resumes only
when the last hold is released and a tab closing here must not hand back Opera's. The hold is taken
after 1.5s of sound, refreshed every 60s against the bridge's 180s TTL, which is what stops a hold
outliving the browser and pinning Spotify paused, and released 1.5s after the sound stops or when
the browser quits. Spotify's own web player is never counted as a video, whatever the site list
says. A readout under the main switch names the port, whether Spotify is open and whether a hold is
being held right now; at the foot of the section, "Check health" runs the tool's own `doctor.ps1`
and shows the report, reading the task, the bridge and Spotify without changing any of them.

A third switch, "Quiet Spotify ads", hands the free tier's ad breaks to the helper: while an ad is
playing it drops Spotify's own in-app volume to 10%, and puts it back to full when the ad ends. The
switch reads the helper's `adDuck` state — carried on the auto-pause status and on every status push
through a 3-second cache — and writes it back over `api.spotify.setAdDuck`, which POSTs the helper's
`/config`. With the helper absent the row is drawn with a short hint instead of pretending.

Main also carries two now-playing routes for the chrome, each answering `{ ok, reason }` within
1500ms: `media:now` reads the helper's `/now`, with art omitted, full, or by hash, and
`media:control` sends play, pause, toggle, next or prev. The port comes from the same client cache
autopause.js uses and a failed call forgets it; invalid commands are refused. Nothing draws a
now-playing tile yet — this is the plumbing under one.

**DRM sites.** Spotify and Netflix cannot play inside a tab. Electron ships Chromium without
Widevine, so anything that needs it fails there, and the signed builds that carry it are dev-signed
only — Spotify rejects Electron outright. They are handled the other way round: the desktop app
plays, and this browser drives it through the auto-pause bridge and the now-playing routes above.
The catalogue marks the five that need Widevine, and opening one of them as an app tab draws a
one-line note bar over the page, with a "Launch desktop app" link when that app is installed.

**Idle music.** Settings → Idle music, between New tab and Privacy: Enabled, Source (Built-in
ambient, or My tracks with its count, Choose files… and Clear), Where it plays, Volume, and the hint
"Plays while nothing else is playing". It persists as the `music` group of `localStorage['settings']`
— `{ enabled, source, where, volume, files, shuffle }` — normalised on the way in (volume clamped,
unknown values falling back, file paths validated, deduped and capped) and announced with a `music`
emit key and a `music-changed` event. `music:choose-files` opens a multi-select audio dialog in main,
capped at 500 files and copying nothing; your own tracks need no custom protocol, because the chrome
is a `file://` document with no CSP and `file://` audio reaches `loadedmetadata`.

The Built-in source is ambient.js, a generative pad on Web Audio rather than a loop on disk: three or
four detuned voices through a slow low-pass filter make a chord that crossfades to the next every 16
to 24 seconds along a small modal progression, a sparse sine arpeggio quantised to that chord runs
through a feedback delay, and the room is four damped delay lines — a 2.5s convolver cost 4% of a
core on its own — into a compressor and a master gain. One timer for the whole engine; `stop()`
clears it, kills the live nodes and suspends the context, which is the difference between 1.9% of a
core playing and under 0.1% paused. Twelve two-word mood titles stand in for track names.

The new tab shows it in the session tile: a state line reading Off, Paused, the mood title or the
track name, Play / Pause / Turn on, and a Next control for your own tracks.
`window.__applyMusic({ enabled, playing, source, title, where })` updates it in place and clicks come
back as `newtab:music` console lines.

music.js is the player. It plays only when the setting is on, you have not paused it by hand, the
window is focused, no tab is audible, the machine is not already playing something (Spotify, or any
Windows media session), the "Where it plays" setting is satisfied and the source is ready. A 300ms
settle sits in front of that decision, and the fades are 800ms in and 400ms out. Two sinks sit behind
one contract: the ambient engine, and one `<audio>` element on `file://` for your own tracks, with
shuffle, next, missing files skipped and a whole-list failure falling back to the engine. app.js
feeds it — the stats subscription for presence, audible and muted tab edges, `Settings.music` and the
`music-changed` event, the pushes to the new tab on dom-ready, activation and state change, and a 2s
now-playing poll while a new tab is in front, or anywhere while the window is focused.

**Media keys, and why they moved.** The player used to veto its own sound: Chromium registers the
chrome's own `<audio>` element with the Windows media session, so the now-playing route reported the
idle music as "playing", the player paused for it, the session went Paused, and it resumed — a
four-second cycle with Spotify paused throughout. The browser process now starts with
`disable-features=HardwareMediaKeyHandling`, which takes it out of the Windows media session
altogether. The trade-off is on purpose: media keys no longer control browser tabs, they go to
Spotify, and the now-playing tile shows Spotify and other apps but never a tab in here. On top of
that, pausing for something else is immediate but resuming waits for the clear state to hold 2.5s,
and more than three flips in a minute sits the player out for 30s — your own presses and settings
writes skip the hold.

**Now playing.** A third module on the new tab, seated at the bottom-left margin on its own "flank"
placement, outside the arithmetic that positions the clock and the readout, so neither of them moves
for it. A 48px art well with a note glyph when it is empty, the title, the artist, a hairline
progress bar filled with the accent as a composited `scaleX`, and previous, play/pause and next as
three quiet glyphs. It is the Spotify helper's feed, not the browser's: `__applyMedia(payload)` in,
`newtab:media {cmd}` out over the page's console channel, and the buttons reach `media:control`, so
they drive whatever the helper is playing. It ticks four times a second while something plays,
freezes on pause, and writes `img.src` once per distinct art string.

**Palette presets.** Six colour worlds, picked as painted swatches in Look: Aurora (the
original), Ember, Forest, Ocean, Midnight and Mono. `data-palette` on `<html>` overrides the same
ten tokens every time, each authored twice, dark and light, and matched on any descendant as well
as the root so a settings swatch previews the real tokens. "Aurora" is chrome.css's own `:root`
and so the one id that must never reach the attribute. The choice is stored in both
`settings.palette` and `localStorage['palette']`, written together so they cannot drift.

**Settings.** A gear beside the theme toggle opens a popover with fourteen sections, in this order:
Look (dark/light, the six palette swatches as one radiogroup with a roving tabindex, accent hue,
and the bookmarks-bar switch); Claude — the folder new Claude tabs start in (typed, or through
the native picker, and only written once main confirms it is a real directory), the switch for
resuming the last conversation on restore, "Skip permission prompts" (on by default, described
above), and `claudeNotify`, behind the Windows notification described above; Tabs (the background
idle time before a tab sleeps, or never); Downloads ("Ask
where to save each file", off by default); Search (Google, DuckDuckGo, Bing, Brave, Startpage);
Websites (the site theme guests see through `prefers-color-scheme`); Site styles and scripts;
Browser style, below; New tab (the background — circuit board, aurora only, your own image, or
Moving picture with its file row: the clip's name or "No file chosen", Choose file… and Remove —
plus the dim slider and the board-over switch, both shared by the image and the clip); Idle music,
described above; Privacy
(clear browsing history, clear downloads list); Spotify,
the auto-pause switches, the ad-quieting switch, the site list and the health check described above;
Shortcuts,
the editor described
above rather than a printed table — it starts collapsed, because it is the longest section in the
pane: the heading is a button with a chevron and `aria-expanded`, click or Enter/Space opens it, the
choice is remembered in `settings.shortcuts.open`, typing in Find a setting opens it so hits are
visible, and collapsing it stops a recording row; and About (Electron and Chromium versions, and the Restart
browser button). Everything but the site styles — a view onto sitestyles.js's own store — and the
key bindings, which live in their
own `shortcuts` record, persists as one JSON object in `localStorage['settings']`
(`searchEngine`, `siteTheme`, `palette`, `accentHue`, `chips`, `homepage`, `claudeDir`,
`claudeResume`, `claudeSkipPermissions`, `claudeNotify`, `tabSleepMinutes`, `downloadsAskWhere`,
`newtabBackground`, `bookmarksBar`, `apps` with its `pins`, the ids of the apps on the new
tab's dock, and `music` with the idle-music preferences); missing keys fall back to defaults, so an
older stored object still reads. Section titles are set at full text colour, 13.5px and bold, with
the fading rule under each one, so the pane reads as headings and rows rather than one long list.

**Browser style.** Site styles paint web pages across an async boundary; this paints the chrome —
titlebar, tabs, omnibox, panels — the document the script is already running in, so there is no
IPC and nothing to wait for. userstyle.js owns one string in `localStorage['userstyle']` and one
`<style id="user-chrome">`, which `apply()` re-appends to the **end** of `<head>` every time:
chrome.css and the ten module stylesheets all sit there at equal specificity, so last one in wins
and a rule you wrote beats the rule it was written to replace without a wall of `!important` — and
a stylesheet some module adds later cannot quietly get above it. The element is made lazily, and
`clear()` empties it rather than removing it, because the node is the anchor. The cap is 64 Ki
UTF-16 code units, the unit localStorage itself counts, and over it the write is **rejected, not
truncated** — half a stylesheet is a broken stylesheet — so the old sheet stays and a toast says
why. Settings → Browser style is one field, Apply, a two-press Reset armed for four seconds, and a
closed crib sheet naming the twelve tokens worth reaching for (`--ink-0`, `--fg`, `--glass`,
`--ion`, `--amber`, `--panel-bg` and the rest); Escape leaves the field, a second one closes the
panel. Because `#settings-panel { display: none }` is one typo away and a browser you cannot
un-break is one you stop customising, the reset is also a keystroke: Ctrl+Alt+Shift+R, replayed by
main even when the press landed inside a page, so it works with focus anywhere.

**Find a setting.** A filter box sits in the settings head, above the sections. `indexFields()`
writes one lowercased string per `.set-field` into `data-search`, read off the rendered text —
labels, hints, option names, keycaps, plus the section's heading and any hint outside the fields,
so "address bar" finds the search engine list — and `deepText()` puts a space at every element
boundary, because a "Dark" button beside a "Light" one is otherwise indexed as "darklight". A
query is words: every one has to land somewhere, in any order. Fields that miss are hidden, then
sections with nothing left showing, then a "No settings match" line; a field rendered between two
passes counts as a match, since the filter narrows the panel and must never swallow a control it
has not read. Hits are lit with `<mark>`, but only where a setting is *named* — labels, row
labels, shortcut names, option buttons — since lighting words inside paragraphs turns the panel
into a page of highlighter. Nothing goes near `innerHTML`: text nodes and `<mark>` only,
overlapping words merged into one run, and unmarking re-merges the text nodes so the next split
never straddles two. It runs 40ms after the last keystroke, once per word for a fast typist.
Escape empties the field and only a second Escape, on an empty one, closes the panel; Enter moves
focus to the first control still on screen.
The box is not focused on open, though: focus lands on the panel itself (`tabindex="-1"`) and Tab
reaches the filter, because a caret blinking twice a second under the acrylic window made Windows
re-compose that whole column and showed as a flicker in the address bar above it.

**New tab page.** A plain `file://` page inside a guest — no preload, no `window.api`. The
chrome passes `?theme`, `?palette`, `?hue`, `?engine`, `?chips` and `?bg` for the first paint
and pushes later changes in with `window.__applySettings`. Those params are frozen when the tab is
made, so a reload re-reads the old ones and a dark chrome came back light; the chrome now pushes
theme, settings, background and recents again on every `dom-ready` (theme first, since the accent
is derived per theme), which covers F5, a crash reload and a script reload alike. Chips show
favicons from
`google.com/s2/favicons`, falling back to the bare label. The page cannot read the history store,
so the chrome pushes it 8 recent sites with `window.__applyRecent`: 6 become tiles under the
chips, the rest feed the capsule's dropdown. Behind the capsule is the circuit
board — a socket ring around it, 45-degree traces out to vias and peripheral chips.

Two live glass modules sit on that board. A clock, updated once a minute rather than on a
per-second timer, and a session readout: tabs open, Claude sessions, and Spotify auto-pause as
Off, On or Holding. The chrome feeds the readout the same way it feeds everything else on this
page, through `window.__applyReadout({tabs, claude, autopause})`, pushed on tab, chamber and
auto-pause changes. "Holding" means something is holding Spotify through the bridge, and that can
be another source — the LessonPlayer desktop app, say — not only this browser.

**Apps dock.** In the same capsule, above the web chips, the apps you have pinned are drawn as 56px
tiles: a 32px icon, the name under it, and a dot at the icon's corner while the app is running. One
row is reserved before any of them arrive so the capsule's height never jumps, and the capsule grows
for a second or third row (two at 393px, three at 320px). A click launches the app, or focuses it if
it is already running. Edit mode puts a remove glyph on each tile and adds a "+ Add app" tile whose
inline picker filters the list, eight results at a time, arrows and Enter. The page has no
preload, so this rides the channel the Processes list uses: a `newtab:app` console line for launch,
focus, pin, unpin and refresh, honoured only from the tab that owns that guest and only for a
new-tab URL, with `window.__applyApps` (the pins with their icons, and the installed names for the
picker), `window.__applyAppsRunning` (dots updated in place, pushed only when the running set
changes) and `window.__applyAppResult` (a 3s note on the dock when something fails) coming back.
The installed index is main's, out of `apps.js`. The pins are ids only, in the `apps` group of
`localStorage['settings']` and capped at 32 — at the cap the dock says "Full" rather than accepting a
pin it will not draw — so a pin for an app that has been uninstalled costs nothing and comes back if
it is reinstalled. The running dot uses its own `--ion-dot` token, the accent darkened 21% in the
light theme, so it clears contrast on the tile in both. Focus goes to the real window: main
enumerates visible titled top-level windows by pid, then the console window attached to that pid,
then a conhost / Windows Terminal / OpenConsole child of it, and never falls back to another pid, so
a console app raises its own console instead of somebody else's window.

A pin does not have to be an installed app. A web app pins as its favicon, drawn through the same
favicon path as the chips with a letter disc behind it as the fallback, and a terminal program pins as
a monospace `>_` tile. An installed pin can open three ways — as the desktop app, as its web
form, or as the app running inside a tab — so Edit mode gives it a quiet three-way chooser in the
tile's corner: app | web | tab, or app | tab when the app has no web form, with `aria-pressed` on the
choice that is current. A press sends `pin-web` or `pin-native` and then waits for the chrome's next
push rather than flipping locally, so what you see is always what is stored. A pin with a web form
wears a small "web" badge and a native pin a "tab" badge, native winning over web; a pin is an id on
its own, or the id with the `web` or `native` option set, and plain strings are still written whenever
neither is on so an older settings file round-trips unchanged. The Add app picker is grouped: Installed, Web apps
(with the host, and a "desktop" hint when the desktop app is installed) and Terminals (leaving out
anything not installed), up to eight per group, with one search across all three. The running dots
cover open app, terminal and native tabs as well as running processes. webapps.js is loaded on the page as a
first-paint seed only; the chrome's push is the source of truth.

**System stats.** Inside the capsule, where the search field used to be, is a strip of live system
stats — the field is gone because the user searches from the address bar. CPU, memory, disk, network
(bits per second, down and up) and GPU, each a Bahnschrift tabular value, a sentence-case label and
a 120x28 graph of the last 60 samples. The strip reserves its height before the first sample and
shows dashes until then. `window.__applyStats(sample)` appends, writes the text and repaints once;
there are no timers and no rAF on the page. The numbers come from `stats.js` in main, sampled once
a second — Task Manager's cadence, so a graph holds one minute: CPU from `os.cpus()` deltas per
core, memory from `process.getSystemMemoryInfo()`, uptime from `os.uptime()`, and disk, network and
GPU from one long-lived `typeperf` child streaming the same Windows performance counters Task
Manager reads (PhysicalDisk `_Total`, Network Interface summed, GPU Engine `engtype_3D` summed).
`typeperf` prints a warning line whenever a counter instance disappears, so warning lines and
repeated headers are skipped, blanks count as 0 inside sums, a field goes null only after 5s
without a valid row, and a dead child respawns in 2s. `(*)` fixes the instance list at spawn time,
so the child is replaced every 30s with an overlap — switch on the replacement's first row, then
kill the old one — and a process started since the spawn is counted within 20s. The chrome
subscribes only while the active tab is a new-tab page and the window is focused, so background
new-tab pages get nothing and the `typeperf` child is killed 5s after the last unsubscribe.

**Processes.** Under the strip is a "Processes" expander — a chevron at the strip's right edge, and
the strip itself is the toggle. It unfolds the list inline over 160ms, pushing the chips and Recent
rows down, and whether it is open or closed is kept in `localStorage` and restored without
animation. Rows are grouped the way Task Manager groups them, one per program with its instance
count and a friendly name where there is one (Claude Code, Electron, Windows Explorer, Desktop
Window Manager, Service Host), each showing CPU as a share of the whole machine, private memory
(Working Set — Private) and disk and network bytes. The top 10 are drawn, Show more takes it to 30,
and the sort — CPU or memory, click a header — is persisted. Rows keep their identity by group key
between samples and update their text in place. Each row also carries a 16px icon slot in front of
the name: the real icon of the executable behind the group once the chrome pushes it with
`window.__applyProcIcons({ key: dataUrl | null })`, and until then, or when there is none, a neutral
window outline glyph at `--fg-3`. The src for a key is written once, a null answer never clears an
icon already on screen, and the dashed placeholder rows keep the same slot width, so nothing shifts.
Main resolves the icons in `procicons.js`, cheapest first: the browser's own groups from
`process.execPath`, then the installed-app index, then zero-spawn guesses under System32, SysWOW64
and Windows checked with `fs.access`, then one debounced `Get-Process` batch keyed by pid (500ms
debounce, one in flight, at most one spawn every 10s), then `app.getFileIcon` at 32px as a data URL,
all of it cached in memory and in `proc-icons.json`. The chrome asks over `stats:proc-icons` for the
keys it is missing, one request in flight and one every 3s with nulls retried after 5 minutes, holds
its own 300-entry cache, and pushes the whole cache to a new-tab page on `dom-ready`. A sample
itself does no icon work. End task is a two-step: the button arms for 3s, and
the second press ends every process in the group; the row answers Ended, Protected or That's this
browser for 3s. Worth knowing: ending a group ends all of its processes, the way Task Manager does,
and two things are always refused — the browser's own tree, which is greyed out and has no End task,
and a protected list of Windows processes (System, Registry, smss, csrss, wininit, winlogon,
services, lsass, svchost, dwm, fontdrvhost, Memory Compression, Secure System, MsMpEng,
SecurityHealthService, audiodg, sihost, ctfmon). The new tab page has no preload, so the request
travels the channel the history page already uses: a `newtab:end-task` console line the chrome
honours only from the tab that owns that guest and only for a new-tab URL, forwarded to
`stats.endTask` and pushed back as `window.__applyEndTask`. Collapsed, the list costs nothing —
samples are kept and not drawn.

**New tab backgrounds.** Four of them, picked in Settings → New tab. *Circuit board* is the
page's own default. *Aurora only* hides the canvas and the packet layer and stops newtab-bg.js
drawing at all, on the same `data-bg` attribute the CSS reads, so nothing hidden still costs
anything. *Your image* is a picture of your own, with a dim slider and a switch for showing the
board over the photo as a texture rather than the subject: decoded with `createImageBitmap`,
drawn down to at most 2560px on its long edge, re-encoded as JPEG at 0.86 — GIF and SVG are
refused — and stored in IndexedDB. The settings JSON keeps only
`{ kind, boardOverImage, dim, rev }`, the fresh `rev` telling `set()` the picture behind it moved.

*Moving picture* is a clip of your own, chosen with Choose file… in the same section: mp4, webm,
mov, m4v or gif, allowlisted by extension and capped at 512 MB, copied by `bgfiles.js` into
`userData/backgrounds` (older copies removed first) so the profile owns it and the original can
move. A video plays muted on a loop, full-bleed under the dim overlay and above the aurora, with
the board off unless the board-over switch puts it over the clip as a texture; a gif takes the
`<img>` layer beside the `<video>` instead. The clip pauses whenever the page is not in front — a
pane open, the window behind, the page hidden, the tab switched away — and plays again on the
opposite events plus `pageshow` and `focus`; a gif in the `<img>` layer keeps animating, since
there is nothing to pause. A file Chromium cannot decode falls back to the board silently. It costs
26% of a core for a 1080p clip against the board's 18%, and 1.4% paused. There is no audio, so the
tab chip shows no speaker and Spotify auto-pause never holds for it.

**Board pause.** A pane with a `backdrop-filter` over the new tab page re-blurs everything under
it on every painted frame — about eleven points of CPU on top of the overlay's own. So while any
panel, menu or suggestion list is open, app.js calls `window.__boardPaused(true)` in every new-tab
guest and the board freezes as a hidden page does: sprites are `Animation.pause()`d rather than
cancelled, so they resume instead of respawning. One `MutationObserver` on `hidden` catches every
pane, so none has to report itself. The same freeze runs off window focus — pause on blur, resume
on focus — because visible-but-unfocused is the common case, the window sitting behind something
else while its board keeps the GPU busy for no one.

That focus is the *window's*, not the chrome document's. Reading the chrome's own `blur` froze the
board the moment a page inside a tab took focus, which is most of the time you are using the
browser; main sends `win:focus` from the BrowserWindow's own focus and blur now, and app.js drives
the pause from that alone. The page also resumes itself on `visibilitychange`, `pageshow` and
`focus`, and a 2-second watchdog restarts the frame loop if it is found stalled.

**Claude tabs.** pty.js spawns `C:\Users\you\.local\bin\claude.exe` under a real ConPTY, wired
to xterm.js. The cwd is whatever the caller asked for, falling back to the Claude folder from
settings and then to the home directory — a folder that has been deleted, renamed or mistyped
falls back rather than failing the tab. Shift+click the Claude button, or Ctrl+Shift+`, to pick a
folder through the native dialog; the chip menu's "Open folder in new Claude tab" starts a second
chamber in the same folder. In a folder Claude Code has not run in before, the first thing in the
chamber is its own trust prompt — that one is Claude's. The environment is scrubbed first (see
Security notes), and xterm is opened lazily, because building it into a hidden 0x0 container
gives a permanently broken session. When a session exits the pane prints `[session ended] press
Enter to start a new one`, and Enter restarts it in place.

Every chamber starts `claude --dangerously-skip-permissions`. Settings → Claude has a "Skip
permission prompts" switch, on by default; with it off, a new tab starts plain `claude`. app.js
builds the arguments, pty.js allowlists the flag alongside `--continue` and `--resume` (see
Security notes), and preload carries it onto the Enter-to-restart path through a pushed pref, so a
restarted chamber is not quietly stricter than the one it replaced.

**Other programs in a chamber.** pty.js is no longer claude-only. A static PROGRAMS table names
claude, PowerShell, pwsh, cmd, Python, Node and Git Bash, each with its own fixed arguments and its
own allowlist: only claude accepts `--continue`, `--resume` and skip-permissions, and the shells take
nothing at all from the renderer. Binaries resolve once per process through `where.exe` or an
absolute-path check, and the Store's app-execution-alias stubs are rejected, so a missing Python
reports "not installed" instead of opening the Microsoft Store. `createSession({ program })` defaults
to claude and throws on an unknown id; `pty:programs` answers the chrome only, and `pty:start`
returns null for an unknown id before anything spawns.

**Terminal tabs.** The picker that table was the layer under. Any program pty.js has available opens
as its own tab, titled after the program, from a "New <program> tab" row in the command palette or
from a terminal pin on the dock — and a dock press raises the chamber that is already open rather
than spawning a second one, so only the palette starts a fresh shell. A program that is not installed
toasts instead of opening an empty tab.

**Web apps and app tabs.** webapps.js is a catalogue of 30 web apps — Discord, WhatsApp, Telegram,
Slack, Notion, Gmail, Calendar, Drive, Docs, YouTube, YouTube Music, Twitch, Reddit, X, GitHub,
ChatGPT, Claude, VS Code, Figma, Canva, Microsoft 365, Outlook, Teams, Steam, Roblox, Spotify,
Netflix, Disney+, Apple Music, Prime Video — each with a `web:<slug>` id, its URL and host, the
desktop exe it pairs with, and a `drm` mark on the five that cannot play in a tab. It looks up by id,
by host (exact, then the longest subdomain match) and by exe, so "spotify", "spotify.exe" and a full
path all answer.

Opening one activates its tab if it is already there, or loads the URL as a page tab seated to the
left of the first ordinary tab, so the apps live together at one end of the strip. The tab carries
`{id, name, url, host}`, which is saved in the session and comes back on the next launch; navigating
inside the same host keeps the app flag, and going to another host clears it, so the tab becomes a
plain page instead of pretending it is still the app. A stale slug restores as a plain page too. The
command palette has "Open <name> (web)" for every entry and "Switch to <name>" for an app tab that is
already open.

**Native app tabs.** The answer to "is there a way where I can start the apps in a tab but it's
running the app so that literally everything is just in a tab?" — a real desktop app running inside a
tab, engine and tab both. embed.js reaches Win32 through koffi (Node-API, so it loads in Electron 44 with no rebuild, required
lazily inside a try/catch). It finds windows by pid or exe; `attach` leaves the app's window
top-level and **owns** it instead — the browser becomes its owner (`GWLP_HWNDPARENT`), the caption
and frame come off (`WS_POPUP`), `WS_EX_TOOLWINDOW` keeps it out of Alt+Tab, and the window is
positioned over the tab's placeholder in screen space, following every browser move, resize,
maximise and fullscreen change and hiding with a minimise or under an overlay. That is the whole
reason for ownership: `SetParent` would join the app's input queue to ours, so a hung app used to
stall the browser, and an owned window cannot. `layout` positions it over a CSS-pixel rect with the
display scale applied; `detach` puts the saved styles, owner and rect back as a normal window;
`close` posts `WM_CLOSE` with a restore fallback after 3s; and a once-a-second poll reports a window
that has gone, reads its title, and samples `IsHungAppWindow` with a two-sample debounce each way.
Focus is true through the owner chain, and handing the keyboard back after a hosted-app shortcut is a
momentary `AttachThreadInput` handoff — only while the app is not hung, and never
`SetForegroundWindow`. Losing the owner (a Store frame resets it) restores the styles before letting
go, and child mode, the old `SetParent` path, is kept as a per-call fallback. Only a window it can
actually host is found or attached — a top-level root, unowned, not a tool window, never a store app
and never one of our own HWNDs, since a credential dialog owned by the browser itself used to
enumerate as hostable — and a minimised one is shown with `SW_SHOWNOACTIVATE`, so opening an app into
a tab never steals focus. Every Win32 call in attach recovery and detach sits under its own try, so a
failure cannot leave a stripped window with nothing holding it, and a failed restore keeps the record
so the quit path retries it. `detachAll` runs on before-quit, window close and process exit, so quitting the browser
never takes an app down with it. main.js answers find, attach, open, layout, detach, close and list
for the chrome only: opening launches the app the way the dock does, or attaches a window that exists
already, and waits up to 20s for a new titled window from that exe, with a pending-open guard so a
second request for the same tab answers "open-pending" instead of launching a second copy (and a tab
closed during the wait cancels it). `render-process-gone` detaches every app. Startup never depends on
the module — a missing koffi answers "unavailable".

A tab can be a "native" kind: its view is a placeholder on the theme ground, and the engine keeps the
app's real window positioned over that rect — synced on activation, on resize and on split changes,
and hidden whenever a chrome overlay covers the content (the palette, the panes, tab search, find,
downloads), because an owned Win32 window sits above the document. Two ways in: the command
palette's "Open <app> in a tab" row, with "Switch to <app>" once it is open, or the apps dock, where
Edit mode gives each installed pin an app | web | tab chooser and a native pin then wears a small
"tab" badge. Either way, a copy that is already running is adopted into the tab rather than launched
again — a hostable window of that app which no tab is hosting yet is taken where it stands, never
raised first — and a fresh copy only starts when there is no such window. The placeholder tells you
where it is — starting, running, gone with Relaunch and Close, failed with the reason and a "Launch
normally" button, or idle with a Start button for a restored session, since native tabs never
auto-start and never sleep; Start adopts the running copy the same way, so coming back after a
restart hosts the app you left open instead of a second one. "Pop out" in the tab context menu gives
the app back as a normal window; closing the tab closes the app.

A few things to know. The tab's title is the app's own, live: Discord-style "(3) Discord" reads as it
does in the app, with the app name as a fallback. When a hosted app wedges, the tab says so — the
title picks up " (not responding)" and the placeholder offers Pop out and Close tab — and both clear
by themselves when the app comes back; nothing is detached behind your back. Store apps are still
refused: Calculator takes the owner and then ApplicationFrameHost resets it, so launch those
normally. Windows 11's packaged Notepad, which the old re-parenting path destroyed, hosts fine now.
The hosted app owns most of the keyboard while it has the focus, but not all of it: new tab, the
address bar, the palette, tab search, Ctrl+Tab both ways and the Files tab still fire from inside the
app — a hosted Electron or CEF app like Discord or VS Code included, since who holds the keyboard is
decided by process id rather than window class — and the keyboard comes back to the browser once one
of them has, while Ctrl+W and the keys a hosted editor or chat app owns — F, R, S, P, N — go to the
app rather than here. Focus inside the app counts as focus in the browser too, so idle music set to
play anywhere keeps playing while you work in it. "Pop out" and a clean quit both hand the window
back whole; a force-killed browser leaves the app alive but frameless, and it is restored
automatically the next time the browser starts. The tab side is verified against Character Map,
Notepad, Paint and a second Electron app.

**Resuming a conversation.** Four ways in, all the same door: right-click bare strip → "Resume a
Claude conversation…", a Claude chip's menu → "Resume another conversation here", Ctrl+click the
Claude button in the titlebar, or the palette's "Resume a Claude conversation…" row. Every one of
them opens a chamber on `claude --resume` with no id, which is Claude Code's *own* list of past
conversations in that folder — the picking happens inside the CLI, not in the chrome, so there is
nothing to cancel on this side and Escape in the picker just leaves a fresh prompt. The strip
menu, the button and the palette use the default folder; the chip menu's row uses that chamber's
folder and seats the new tab straight after the chip it was asked from, because two sessions on
one folder belong next to each other. The Claude button's tooltip now carries all three
modifiers: Shift picks a folder, Ctrl resumes, Alt opens it beside this page.

Two flags, two meanings. `--resume` bare is the picker; `--continue` is the folder's latest
conversation without asking, and it is what a restored chamber comes back on when the resume
switch is on — a tab you open by hand always starts clean. `claudeStartArgs()` in app.js is the
one place a `resume` option becomes flags, and pty.js allowlists exactly those two, bare (see
Security notes). They are honoured on the first spawn only: Enter-to-restart in a finished pane
always starts a plain session, because a conversation that has already ended must not be resumed
twice and re-passing `--resume` would reopen the picker instead. "Plain" means without a resume
flag: `--dangerously-skip-permissions` does ride along, since that one is a setting and not a
one-time act.

**Permissions.** Electron grants everything by default, which would make this the most generous
browser on the machine, so the handler is explicit: a short silent-allow list, a prompted list,
and deny for everything else. Answers outlive the run in `permissions.json`, keyed by origin, with
one exception — see Security notes.

**Context menus.** A `<webview>` has no menu of its own and the built-in `role:` entries act on
the window, so every item calls the guest's own webContents method: navigation, link, image,
selection, the four Claude hand-offs, editing and inspect.

## Security notes

The chrome is trusted and every guest is not. These are the places that line is actually held.

- **The webview attach hook.** Electron 44 still lets a guest `<webview>` ask for its own preload
  and node integration, so `will-attach-webview` on the chrome's webContents overrides the lot
  rather than trusting what `buildWebview()` happened to set: `preload` and the legacy
  `preloadURL` deleted; `nodeIntegration`, `allowRunningInsecureContent`, `experimentalFeatures`,
  `plugins`, `nodeIntegrationInSubFrames` and `webviewTag` pinned off — a guest must not host a
  `<webview>` of its own, because a nested attach would never reach this hook — `contextIsolation`
  and `webSecurity` on. Then the attributes the same switches ride in on are stripped,
  `webpreferences="…"` included.
- **Page-initiated `file:` navigation is cancelled.** One string test on `will-navigate` stops the
  worst outcome in the app: a page walking the guest onto `file:///C:/Users/…` and reading it
  same-origin. `will-navigate` only fires for navigation the *page* started, not `loadURL()` or
  `setAttribute('src', …)`, so the omnibox still takes a `file://` path as it always did, and the
  bundled pages that navigate themselves are let through by origin.
- **Screenshot reveal is confined to Downloads.** The path for `capture:show` comes from the
  renderer, so `isInsideDownloads()` resolves it — `..` and a symlinked name both collapse in
  `path.resolve()` first, case-insensitively the way NTFS is — and anything outside Downloads is
  dropped rather than pointed at with Explorer.
- **Download URLs are scheme-allowlisted.** `dl:download-url` accepts `http:`, `https:`, `blob:`
  and `data:` and nothing else. `file:` is deliberately absent: a page must not be able to talk
  the chrome into copying something off the local disk into Downloads.
- **Permissions are deny-by-default.** Silently allowed, because they need a user gesture anyway:
  fullscreen, pointerLock, clipboard-sanitized-write, window placement/management, keyboardLock.
  Prompted: geolocation, notifications, midi(Sysex), display-capture, idle-detection,
  clipboard-read, camera/microphone, and "open another app". Everything else is denied without
  asking, a dialog that failed to show is not consent, and simultaneous asks share one dialog.
  `openExternal` is the exception to remembering: asked **every** time and never written to
  `permissions.json`, because one remembered Allow would turn a site into a permanent launcher
  for any protocol handler on the machine.
- **The reader sanitises twice.** The chrome parses the article into an inert document and strips
  scripts, frames, plugin objects, `on*` handlers and `script:` URLs before it ever leaves. Then
  reader-page.js sweeps the **live** tree after `innerHTML`, with the same rules — serialise then
  reparse is the classic mXSS trick, and a string that was clean can come back out of the parser
  dirty. The sweep drops every script, frame, plugin, `style`, `link`, `meta`, `base` and `form`
  node, then every `on*`, `srcdoc` and `style` attribute plus any URL attribute whose value —
  control characters squeezed out first — starts `javascript:`, `vbscript:` or `data:text/html`.
- **PTY arguments are allowlisted per program.** In pty.js, only claude accepts `--continue`,
  `--resume` and `--dangerously-skip-permissions`, bare; the shells and interpreters in the PROGRAMS
  table accept no renderer arguments at all. Anything else is dropped with a warning and the session
  still starts, plain, so a bad argument costs you a resume and never a tab. The program id is
  matched against the table rather than used as a path, so `pty:start` with an unknown or path-like
  id returns null before anything spawns.
- **The PTY environment is cleaned.** Every `CLAUDE*` variable is deleted before the spawn except
  `CLAUDE_CODE_GIT_BASH_PATH` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the two genuinely persisted at
  user level. Stripping by prefix rather than by name means a marker added upstream is scrubbed
  too. Launched from inside a Claude Code session, those markers make the new session believe it
  is a child: transcript saving off and effort hard-pinned.
- **`shortcuts:set` is bounded.** The renderer owns the binding map and mirrors it to main, so
  main takes only a plain object of string → string with 1 to 200 entries — a real map is a few
  dozen. A payload that is empty, malformed or absurd leaves main on the map it already had.

## Performance

Measured on this machine, tonight. Cold start is about **550ms** from launch to a booted chrome —
`body.booted`, strip drawn, first guest attached. A page tab costs **100–150MB** of resident
memory each — Chromium's renderer per site, not something the chrome can talk down; a tab that
falls asleep gives that renderer back, and two sleeping tabs handed back about **240MB** between
them. Idle CPU is almost entirely GPU compositing — the aurora and the new tab's circuit board,
both of which cost whether or not anyone is looking, which is why both freezes exist: the board
pauses under any pane with a `backdrop-filter` over it, and again whenever the window loses focus.
With it frozen and no page animating, the idle cost was the aurora's stepped keyframes, and the
aurora is static now.

**How any of this is measured.** Launch a second instance of the browser on its own
`--test-profile --profile-name=<x>` and drive it over CDP, never the real one. Push its window
behind something before taking a number: an occluded or minimised window composites nothing and
reads as free, and a window in front reads honestly. Chromium throttles what it thinks nobody is
watching, so the instance is started with `--disable-background-timer-throttling` and
`--disable-renderer-backgrounding`. CPU is read per process type — main, renderer, GPU — because
the same total means different things in each, and a change that only moves cost from the renderer
to the GPU process is not a win. Frame cost and script cost come from `Performance.getMetrics` over
a fixed window (8 seconds, median of three or four runs), with an A/B run interleaved rather than
one run before and one after.

**Rules that came out of it**, worth keeping:

- `webview.getURL`, `canGoBack`, `canGoForward` and `getZoomLevel` are synchronous IPC into main,
  not property reads. Cache their answers per guest and invalidate on navigation events; never call
  one in a loop or on every tab switch.
- One IPC per real change. A push to a guest — readout, recents, settings, theme — is memoised
  against the last value sent, rolled back if the send fails and cleared on `dom-ready`.
- Session writes are async and single-flight, newest-wins, with a synchronous flush on `before-quit`
  and on `beforeunload`. A synchronous write on the main loop is a stall the whole window feels.
- PTY output is coalesced to one message per frame (a 16ms window, 64KB cap), first chunk immediate
  and the rest flushed on exit.
- A resize that does not change anything is not sent. `safeFit` compares the grid it is about to
  push against the one it pushed last, because a ConPTY resize makes `claude.exe` repaint its whole
  TUI.
- Layout reads are cached. `getBoundingClientRect` on every tab change is a forced layout; measure
  once and re-measure only on a ResizeObserver hit, a child mutation, `load`, `fonts.ready` or a
  theme swap.
- Nothing animates at rest under a `backdrop-filter` surface, and something that must pulse inside
  one gets its own layer.
- Stats sample only while a new-tab page is in front and the window is focused — 0.55% of a core in
  main plus 0.42% for the `typeperf` child then, and nothing at all the rest of the time.
- A chatty child's pipe is paused and drained once per tick, never left in flowing mode. `typeperf`
  writes about 1,400 tiny chunks a second and reading them as they arrived cost main 4.7% of a core
  with the process counters on; draining once per tick is 0.35%.
- A video background pauses when it is not in front. A 1080p clip playing costs 26% of a core, all
  of it in the GPU process, against the board's 18%; paused it is 1.4%.

## Files

| File | What it is |
| --- | --- |
| `main.js` | Electron entry. Owns the single BrowserWindow, window state, acrylic, downloads, page screenshots, permissions, guest context menus, the replayed keystrokes, forwarded guest focus, the PTY IPC bridge, the blocking engine and its counters, the folder picker, `permissions.json`, the certificate-error memory, site info and site-data clearing, `session.json`, the Spotify auto-pause IPC and the guests handed to that module, the `files:` routes behind the Files tab, the music file picker and the `media:now` / `media:control` / `spotify:set-ad-duck` bridge calls, the `disable-features=HardwareMediaKeyHandling` switch that keeps idle music out of the Windows media session, the `embed:` routes behind native app tabs and the `embed:gone` push, and the guards under Security notes (the webview attach hook, the `file:` navigation block, the download and reveal allowlists). |
| `preload.js` | The `window.api` contextBridge surface: shortcuts, open-url, pty (start / programs / withSkipPermissions), downloads, paths, versions, `adblock`, `site` (info / setPermission / resetPermissions / clearData / onPermissionsChanged), `capture` (tab / show), `onGuestFocus`, `app` (pickFolder / dirExists), `session`, `autopause` (status / setEnabled / setConfig / doctor / onStatus), `spotify` (setAdDuck), `stats` (subscribe / unsubscribe / onSample / procIcons), `apps` (list / launch / focus / refresh), `files` (list / places / open / reveal / icons / copyPath), `music` (chooseFiles), `media` (now / control), `embed` (find / attach / open / layout / detach / close / list / onGone), `background` (chooseVideo / clearVideo). |
| `app.js` | The chrome: tab strip, webview lifecycle, omnibox, navigation, theme, Claude tabs, split view (pages and chambers alike), the "Claude needs you" mark and its notification, `askClaude()` and the three prompts it composes (link, screenshot, article), the history-page push and its `console-message` bridge, the new-tab background push and the re-push of theme, settings, background and recents on every `dom-ready`, the Files tab and its `files:` console channel, `openAppTab()` and `openTerminalTab()` with the app flag they persist and the DRM note bar, the idle-music presence signals and the now-playing poll behind music.js, the watch that freezes the board under panes and off window focus, `claudeStartArgs()` and the resume entry points, session save/restore, tab menu, crash cards. |
| `shortcuts.js` | The one binding table: every rebindable action with its group and default, the combo grammar, the `localStorage['shortcuts']` overrides, and `bindings()` / `actionFor()` / `set()` / `conflict()` / `resetAll()`. Loaded before app.js, which pushes its map to main; main.js keeps a hand copy of the grammar that has to move with it. |
| `workspaces.js` / `workspaces.css` | The workspace instrument: the titlebar pill and the switcher popover (switch, rename, colour, delete, create, and move mode for a tab). Drives app.js's workspace API, which is feature-detected, so a chrome without it renders nothing. |
| `pty.js` | PTY session manager — spawns a program under ConPTY with a scrubbed environment, out of a static PROGRAMS table (claude, powershell, pwsh, cmd, python, node, Git Bash) with fixed arguments, a per-program argument allowlist (only claude takes `--continue`, `--resume`, `--dangerously-skip-permissions`), one-time binary resolution through `where.exe` with Store alias stubs rejected, and `listPrograms()` / `hasProgram()`. |
| `stats.js` | System stats, main-process side: a once-a-second sampler that runs only while a renderer is subscribed. CPU from `os.cpus()` deltas, memory from `process.getSystemMemoryInfo()`, uptime from `os.uptime()`, and disk, network and GPU from one long-lived `typeperf` child whose CSV it parses, with per-process rows grouped by base name and `endTask(pids)` refusing self and a protected list. Ref-counted `stats:subscribe` / `stats:unsubscribe` per webContents, `stats:sample` pushed out; the child is killed 5s after the last unsubscribe and on quit. Its parsing is pure and exported, so it runs under plain node. |
| `apps.js` | Installed apps, main-process side: the Start Menu shortcut walk (each `.lnk` through `shell.readShortcutLink`, a 32px icon from `app.getFileIcon`), the packaged apps from one `Get-StartApps` run, the merge and dedupe, and the `apps-index.json` cache with its 24-hour life. Answers `apps:list` / `apps:launch` / `apps:focus` / `apps:refresh`: launch goes through the shortcut or `explorer shell:AppsFolder`, focus restores and raises the process's own main window, and `pathForExe` hands the icon resolver a path for an exe it already knows. Its parsing and merging halves are exported, so they run under plain node. |
| `procicons.js` | Process icons, main-process side: the resolution order (self from `process.execPath`, the app index, zero-spawn guesses under System32 / SysWOW64 / Windows checked with `fs.access`, one debounced `Get-Process` batch keyed by pid, then `app.getFileIcon` at 32px as a data URL), the memory cache and the `proc-icons.json` file behind it (temp name and rename, 300 entries, nulls retried after an hour, paths re-checked after a day), and `getIcons(groups)`, which answers the keys it knows at once and waits at most 3s for the rest. |
| `files.html` / `files.css` / `files.js` | The Files tab: the places-and-drives rail, the breadcrumb path bar (Ctrl+L), the filter, the listing with its icon slot, size and modified columns and persisted header sort, keyboard navigation, and the Open / Show in Explorer / Copy path menu. `__applyFiles`, `__applyFilePlaces`, `__applyFileIcons` and `__applyFileResult` in; `files:` console lines out. |
| `ambient.js` | The built-in idle-music engine: a generative Web Audio pad — detuned voices under a slow low-pass filter, a chord crossfading every 16-24s along a modal progression, a sparse arpeggio through a feedback delay, a four-delay-line room instead of a convolver, compressor and master gain — with one timer, twelve mood titles, and a `stop()` that suspends the context. |
| `music.js` | The idle-music player: `shouldPlay()` and every signal behind it (the setting, a manual pause, window focus, an audible tab, the machine's own media session, the "where" setting, a ready source), the 300ms settle, the 800/400ms fades, the resume hold and the flip counter that sits the player out for 30s, and the two sinks behind one contract — the ambient engine and one `<audio>` element on `file://` with shuffle and skip-missing. Also the parsers for the new tab's `music` and `media` console lines and the now-playing change detector (position out of the hash, art re-sent only when its own hash moves). `debug()` and a `resumeHoldMs` option exist for harnesses. |
| `webapps.js` | The web-app catalogue: 30 entries with `web:<slug>` ids, URL, host, the desktop exe they pair with and a `drm` mark, plus `findWebApp`, `webAppForHost` (exact, then longest subdomain match), `webAppForExe`, `isWebAppId`, `isTerminalId`, `terminalProgram` and `DRM_NOTE`. Loads as a module or a script tag (`window.WEBAPPS` / `window.WebApps`), and is a first-paint seed on the new tab as well as the chrome's own table. |
| `embed.js` | Native app tabs, main-process side: Win32 through koffi, required lazily. `findWindows` by pid or exe, `attach` in owner mode by default (the browser as `GWLP_HWNDPARENT`, `WS_POPUP`, `WS_EX_TOOLWINDOW`, positioned in screen space, no `SetParent` so the app's input queue is never joined to ours) with child mode kept as a per-call fallback, `layout` over a CSS-pixel rect with the display scale applied, `detach` back to a normal window, `close` as `WM_CLOSE` with a restore fallback, the 1s poll with its gone event, title pushes and the debounced `IsHungAppWindow` hung/recovered events, the owner-chain focus check and the `AttachThreadInput` keyboard handoff, the restore when an owner is lost, the refusal of store apps, tool windows, owned windows and our own, `SW_SHOWNOACTIVATE` so nothing steals focus, per-call error handling in attach recovery and detach, and `detachAll` on before-quit, window close and process exit. main.js wires `embed:find/attach/open/layout/detach/close/list` and the `embed:gone` push, guards a second open on the same tab, and detaches everything on `render-process-gone`; a missing koffi answers `{ok:false, reason:'unavailable'}` and startup is unaffected. app.js holds the native tab that the window is positioned over. |
| `bgfiles.js` | The moving-picture file rules, pure: the mp4/webm/mov/m4v/gif allowlist, the 512 MB cap, the copy into `userData/backgrounds/newtab-bg.<ext>` with older copies removed, and the file URL it hands back. main.js answers `background:choose-video` and `background:clear-video` through it. |
| `autopause.js` | Spotify auto-pause, main-process side: the client for the `~/spotify-autopause` bridge, the scheduled-task switch and its direct-launch fallback, the watch over audible guests and the hold machine, `autopause.json`, and `doctor.ps1`. Its pure halves (host matching, the hold machine, response parsing) are exported, so they run under plain node with no Electron in the process. |
| `terminal.js` | `window.ClaudeTerminal`: one xterm.js instance per Claude tab, lazy open, id dispatch, restart, the `activity`/`idle`/`bell` attention events, and the paste queue that waits for a session's first quiet — and, while a trust or safety prompt is on screen, for the quiet after that. |
| `index.html` / `theme-boot.js` | The shell document — backdrop layers, titlebar, nav row, `#views`, `#tabmenu`, script order — and the first script in its `<head>`, which stamps `data-theme` and `data-palette` on `<html>` before any stylesheet paints. |
| `chrome.css` | Every token and every chrome rule, dark block then light block, then the palette presets. |
| `find.js` / `find.css` | Find in page. |
| `downloads.js` / `downloads.css` | Downloads button, progress ring, popover. |
| `reader.js` / `reader.css` | The reader button: probes a page, lazy-loads Readability on first use, runs it, sanitises the article, opens the reading tab. |
| `history.js` / `history.css` | The history store, the omnibox suggestion lens, `openPage()` for Ctrl+H, and `handleGuestMessage()` — the parser for the history page's console lines. |
| `historypage.html` / `historypage.css` / `historypage.js` | The history page itself: search, day groups, row actions, the Clear… menu. `window.__applyHistory` in, `console.log('__history:…')` out. |
| `pip.js` / `pip.css` | Picture in picture: the nav-row button, the video probe and the toggle, all through `executeJavaScript` in the guest. |
| `settings.js` / `settings.css` | Settings button and popover, the "Find a setting" filter over it, and the Browser style view onto userstyle.js; owns `localStorage['settings']` and the IndexedDB asset store holding the new tab's background picture. The Spotify section is live only while the pane is: one `api.autopause` subscription and one 4s poll, started on open and taken down on close, and it never redraws out from under a caret in the site list. |
| `capture.js` | Ctrl+Shift+S: asks main for a screenshot of the guest on screen, flashes the window once, toasts the result. No button, no panel, no stylesheet. |
| `bookmarks.js` / `bookmarks.css` | The bookmarks bar under the nav row — the new-tab chips, the fit/overflow measurement and the "…" popover. Reads the chips out of settings.js; owns nothing of its own. |
| `shield.js` / `shield.css` | The blocking instrument: nav button, blocked count, the two switches. Talks to main over `api.adblock`. |
| `siteinfo.js` / `siteinfo.css` | The site instrument: the lock in the omnibox capsule and its popover — connection, permissions, clear site data, zoom. Talks to main over `api.site`. |
| `tabsearch.js` / `tabsearch.css` | Tab search and the command palette: the titlebar button, the filtering pane over open and recently closed tabs, the installed-app, web-app and terminal-program rows on a plain query, and — behind a `>` — the browser's own verbs. |
| `sitestyles.js` | Per-host CSS, per-host scripts and force dark; owns `localStorage['sitestyles']` and injects into each guest. |
| `userstyle.js` | `window.UserStyle`: your own stylesheet for the chrome — the `localStorage['userstyle']` string, the `<style id="user-chrome">` kept last in `<head>`, the 64 KB cap, and the Ctrl+Alt+Shift+R reset. |
| `reader.html` / `reader-page.css` / `reader-page.js` | The reading page itself: top bar, text size and width, `window.__applyArticle`, and the second sanitiser sweep over the live tree. Owns `localStorage['reader']`. |
| `newtab.html` / `newtab.css` / `newtab.js` | The new tab page: chips, favicons, the clock and session modules, the system stats strip (`window.__applyStats`), the Processes list and its icon slots (`window.__applyProcIcons`), the apps dock and its picker (`window.__applyApps`, `window.__applyAppsRunning`, `window.__applyAppResult`), the Idle music block inside the session tile (`window.__applyMusic`, `newtab:music` out), the now-playing tile (`window.__applyMedia`, `newtab:media` out), and the background layers behind them (`window.__applyBackground`, `data-bg`, `#bg-image` / `#bg-dim`, `#bg-video` / `#bg-video-img` and the pause that keeps a clip still when the page is not in front). `newtab-theme.js` runs first on it, resolving `?theme`, `?palette` and `?hue` before the stylesheet. |
| `newtab-bg.js` | The circuit board — canvas painted once per layout, packets as DOM on Web Animations. Owns `window.__boardPaused` / `__boardState`, the freeze the chrome drives while an overlay is open. |
| `smoketest.js` / `cdp-eval.js` / `cdp-profile.js` | Launch the app on the CDP port from `SMOKE_PORT`, 9222 by default, and assert the chrome ids and a spawning Claude PTY; evaluate one expression in the running instance; CPU-profile it and print the hottest functions by self time. |
| `assets/` | `browser.ico` and `browser.png` (the app/shortcut icon). |
| `CHANGELOG.md` | What changed and why, by area, written to be read instead of the diffs. |

Runtime dependencies beyond Electron: `@homebridge/node-pty-prebuilt-multiarch` (ConPTY),
`@xterm/xterm` with `@xterm/addon-fit`, `@ghostery/adblocker-electron` with
`@ghostery/adblocker-electron-preload` (which nothing here names — the blocker resolves its path
itself), `koffi` (Win32 calls for embed.js; new, so `npm install` after pulling — without it the
embedding calls answer "unavailable" and nothing else changes), and `@mozilla/readability`, which
index.html no longer loads: reader.js injects it out of `node_modules/` on the first reader open, as a
classic script so it leaves a global `Readability`. `ws` is a devDependency, for CDP.

## Design rules worth keeping

- Every colour resolves through a token. A theme is nothing but a second token block and a
  palette a third, and no rule below the token blocks tests `data-theme` or `data-palette`. The
  light theme is custom properties only; type and metric tokens are inherited, not redeclared.
  The instrument tokens (`--bevel`, `--bevel-lg`, `--radius-ctl`, `--rim`, `--rim-focus`,
  `--rim-soft`, `--pip-glow`, `--pip-amber`, `--pip-amber-strong`, `--seam-v` and
  `--readout-stretch`) are built out of those theme tokens with `var()`, so the one definition
  covers dark, light and all six palettes, and a palette that relights `--ion` relights them with
  it. They are never copied per palette.
- The dark theme is charcoal, not ink, and nothing glows at rest. The ground is a neutral
  `#1a1c20` / `#212429` in every palette rather than the blue-black it started as; a container's
  edge is a hairline at 11–14%, not a lit rim (`--rim` still runs as a masked ring, it just ends on
  the plain edge colour); the sheen is a flat 3.5% wash; the accent is desaturated (`#72adca`, not
  `#7dd3ff`) and its glow tokens are half strength; pips are painted, not haloed; seam and chamber
  lamps sit at 14–16%; text-shadows are gone. The one thing that still blooms is focus, and it is a
  3px ring rather than a 28px bloom. `--fg-2` and `--fg-3` are set to hold 4.5:1 on the raised
  grounds. The hue slider matches: a muted track, and a custom hue derived at 45% saturation and
  62% lightness in dark so dragging it cannot reintroduce the neon. The aurora behind all of it is
  static. The light theme is its own token block and none of this touched it.
- A container is bevelled; a control is not. `corner-shape: round bevel round bevel` cuts two
  corners on the diagonal, echoing the 115deg sheen, and sits inside an `@supports` so anything
  without corner shapes keeps plain radii. Controls stay round at `--radius-ctl` and nothing much
  under 28px tall is bevelled, which is what keeps the bevel a container signature instead of a
  texture.
- A gradient edge on glass is a ring, not a border. The two-layer `padding-box` / `border-box`
  background trick needs an opaque interior: run under translucent glass it washes the whole
  element in the gradient, and in the omnibox it took the placeholder with it. So `--rim` is
  painted on a pseudo-element with 1px of padding and an xor mask, which leaves nothing but the
  edge. An `<input>` has no pseudo-element, so the omnibox's ring is anchored to it from
  `.navrow::after`; the two-layer version survives only in the `@supports not (anchor-name)`
  fallback, where the interior is painted opaque first.
- The chrome and the panes are the pass-one look: design pass two restyled both and was reverted at
  The user's request, and only the new tab page kept it. The chrome is layered glass rather than a ruled
  panel. The titlebar is the thinnest, lightest pane in it, an edge hairline separates it from the
  nav row, and the lit seam runs under the nav row — it rides `.navrow::before` so that
  `::after` stays free to anchor the omnibox's rim ring. Hairlines are 1px and spacing sits on a
  4px grid.
- The active tab is the one chip in the strip that is a container: it takes the cut corners and the
  lit rim, over an opaque interior so the gradient stops at the edge, with the ion line under it.
  Inactive chips stay quiet — hover is a lighter glass and a hairline, nothing more. Back, forward,
  reload and the icon buttons are controls, not containers: round at `--radius-ctl`, never
  bevelled.
- A pane keeps its own header rather than a shared one, and the rule under a header fades out
  instead of ruling all the way across. What panes and popovers share is the container treatment —
  the bevel, the masked rim ring, `--panel-bg` over glass, pips for status and readout type for
  figures — not one head geometry.
- A label inside a control that transitions `color` declares its own colour. The theme switch
  rewrites `--fg` underneath that transition, so an inherited label spends its first step on the
  old theme's value, which after a flip to light is near-white type on a white pane.
- Anything floating over a page uses `--panel-bg`, not `--glass`. Glass is see-through, and
  there is nothing behind a popover to blur except the guest's own content.
- Nothing animates at rest under `backdrop-filter`. A drifting full-screen effect behind the blur
  once cost about a quarter of a core for the chrome alone, and stepping it was not enough: the
  aurora's twice-a-second nudge still re-blurred every frosted surface above it, about five points
  of a core with a Claude tab open, so the aurora is static now. It is the same rule the new tab's
  board follows when it freezes under any pane and while the window is unfocused. Anything that
  does move on top of glass is stepped, and pulses that sit inside a frosted row get their own
  layer rather than dirtying it.
- System fonts only: `--ui-font` is Bahnschrift / Segoe UI Variable / Segoe UI, `--icon-font` is
  Segoe Fluent Icons. Glyphs are codepoint escapes so no encoding round-trip can eat one.
- `--ion` (ice cyan, or the palette's accent, or a chosen hue) is the one accent and marks what is
  active. `--amber` means exactly one thing: a Claude session — live, or waiting on you.
- `#views webview` keeps a white background in both themes: a guest page is transparent, so this
  is what a site without its own background paints on.
- A guest is never trusted with a preference it can set itself. Anything a page can flip is
  re-pinned in main before the guest attaches, not read back and checked afterwards.
- The 2-3px band of bare acrylic along the left, right and bottom edges of a maximised window is
  left alone, and the measurement is written down in main.js. It is the native resize border
  Windows keeps around a window using the acrylic material — outside the document, so no
  stylesheet reaches it. Every fix costs more than the band does: `frame: false` renders the
  material black, and growing the bounds while maximised un-maximises the window and takes native
  snap and restore with it.

## Development

The smoke test launches its own instance with `--remote-debugging-port=9222 --test-profile`. Set
`SMOKE_PORT` to move it off 9222 — a test-profile instance on its own port, rather than whatever is
already listening. It finishes with a `smoke: N ok, M failed` summary line and exits 1 when anything
failed, so a run reads at a glance and a script can gate on it:

```
node smoketest.js            # launch, assert, tear down
node smoketest.js --keep     # leave it running so you can poke at it
$env:SMOKE_PORT=9333; node smoketest.js   # the same, on its own port
node cdp-eval.js "document.title"
node cdp-eval.js --guest "document.querySelector('#st-cpu').textContent"
node cdp-profile.js [--guest] [seconds]
```

`--guest` targets the new-tab page inside the `<webview>` instead of the chrome document. Any
instance you drive by hand should be started with `--test-profile`: its storage and theme choice
stay out of the real profile, at `%LOCALAPPDATA%\Temp\browser-test-profile`, where a test run's
`session.json`, `adblock.json` and `adblock-engine.bin` land too. The test polls for `body.booted`
before it touches any tab, then closes any Claude tabs the restored session brought back.

Add `--profile-name=<x>` beside `--test-profile` to move that storage to
`browser-test-profile-<x>`. Two test instances on one profile fight over the same LevelDB and the
same `window-state.json`, so the rule for anything parallel is one port and one profile name each:

```
npx electron . --test-profile --profile-name=nav --remote-debugging-port=9223
npx electron . --test-profile --profile-name=perf --remote-debugging-port=9224
```

Never kill every `electron.exe` — I run my own Claude Code instance on Electron and it will go
down with it. Kill only the test instance: find the PID whose command line contains
`remote-debugging-port=9222` and no `--type=`.
