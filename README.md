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
`electron.exe` with this project path as its argument. It is pinned to the taskbar by hand:
Windows 11 refuses scripted pinning, so a lost pin has to be re-done from the Start Menu.

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
allowlist); `adblock-engine.bin` is the serialised filter engine, fetched on first run;
`permissions.json` holds the per-origin decisions as `{ origin: { permission: 'allow'|'block' } }`,
read as "nothing decided yet" when it is missing or corrupt; and `autopause.json` holds the
Spotify auto-pause preferences (the two switches and the site list).

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
sleep others, reload, close, reopen); workspaces; how it looks; and the panels. A row reads its
keycaps out of shortcuts.js as it is built, so they are your bindings and not a printed guess, and
half the rows read the world too — "Unsplit" or "Split with next tab" depending on the tab under
the cursor. Clearing history asks twice, the first Enter swapping the two lines rather than
acting.

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
handler wrapped so only `http:`/`https:` frames are served.

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

**Palette presets.** Six colour worlds, picked as painted swatches in Look: Aurora (the
original), Ember, Forest, Ocean, Midnight and Mono. `data-palette` on `<html>` overrides the same
ten tokens every time, each authored twice, dark and light, and matched on any descendant as well
as the root so a settings swatch previews the real tokens. "Aurora" is chrome.css's own `:root`
and so the one id that must never reach the attribute. The choice is stored in both
`settings.palette` and `localStorage['palette']`, written together so they cannot drift.

**Settings.** A gear beside the theme toggle opens a popover with thirteen sections, in this order:
Look (dark/light, the six palette swatches as one radiogroup with a roving tabindex, accent hue,
and the bookmarks-bar switch); Claude — the folder new Claude tabs start in (typed, or through
the native picker, and only written once main confirms it is a real directory), the switch for
resuming the last conversation on restore, and `claudeNotify`, behind the Windows notification
described above; Tabs (the background idle time before a tab sleeps, or never); Downloads ("Ask
where to save each file", off by default); Search (Google, DuckDuckGo, Bing, Brave, Startpage);
Websites (the site theme guests see through `prefers-color-scheme`); Site styles and scripts;
Browser style, below; New tab; Privacy (clear browsing history, clear downloads list); Spotify,
the auto-pause switches, the site list and the health check described above; Shortcuts,
the editor described
above rather than a printed table; and About (Electron and Chromium versions). Everything but the
site styles — a view onto sitestyles.js's own store — and the key bindings, which live in their
own `shortcuts` record, persists as one JSON object in `localStorage['settings']`
(`searchEngine`, `siteTheme`, `palette`, `accentHue`, `chips`, `homepage`, `claudeDir`,
`claudeResume`, `claudeNotify`, `tabSleepMinutes`, `downloadsAskWhere`, `newtabBackground`,
`bookmarksBar`); missing keys fall back to defaults, so an older stored object still reads.

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

**New tab page.** A plain `file://` page inside a guest — no preload, no `window.api`. The
chrome passes `?theme`, `?palette`, `?hue`, `?engine`, `?chips` and `?bg` for the first paint
and pushes later changes in with `window.__applySettings`. Those params are frozen when the tab is
made, so a reload re-reads the old ones and a dark chrome came back light; the chrome now pushes
theme, settings, background and recents again on every `dom-ready` (theme first, since the accent
is derived per theme), which covers F5, a crash reload and a script reload alike. Chips show
favicons from
`google.com/s2/favicons`, falling back to the bare label. The page cannot read the history store,
so the chrome pushes it 8 recent sites with `window.__applyRecent`: 6 become tiles under the
chips, the rest feed the capsule's dropdown. Behind the search field is the circuit
board — a socket ring around the capsule, 45-degree traces out to vias and peripheral chips.

**New tab backgrounds.** Three of them, picked in Settings → New tab. *Circuit board* is the
page's own default. *Aurora only* hides the canvas and the packet layer and stops newtab-bg.js
drawing at all, on the same `data-bg` attribute the CSS reads, so nothing hidden still costs
anything. *Your image* is a picture of your own, with a dim slider and a switch for showing the
board over the photo as a texture rather than the subject: decoded with `createImageBitmap`,
drawn down to at most 2560px on its long edge, re-encoded as JPEG at 0.86 — GIF and SVG are
refused — and stored in IndexedDB. The settings JSON keeps only
`{ kind, boardOverImage, dim, rev }`, the fresh `rev` telling `set()` the picture behind it moved.

**Board pause.** A pane with a `backdrop-filter` over the new tab page re-blurs everything under
it on every painted frame — about eleven points of CPU on top of the overlay's own. So while any
panel, menu or suggestion list is open, app.js calls `window.__boardPaused(true)` in every new-tab
guest and the board freezes as a hidden page does: sprites are `Animation.pause()`d rather than
cancelled, so they resume instead of respawning. One `MutationObserver` on `hidden` catches every
pane, so none has to report itself. The same freeze now runs off window focus — `blur` pauses,
`focus` resumes — because visible-but-unfocused is the common case, the window sitting behind
something else while its aurora and board keep the GPU busy for no one.

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
twice and re-passing `--resume` would reopen the picker instead.

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
- **PTY arguments are allowlisted.** `ALLOWED_ARGS` in pty.js is `--continue` and `--resume`,
  bare. Anything else is dropped with a warning and the session still starts, plain, so a bad
  argument costs you a resume and never a tab.
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
With it frozen and no page animating, the idle cost is the aurora's stepped keyframes.

## Files

| File | What it is |
| --- | --- |
| `main.js` | Electron entry. Owns the single BrowserWindow, window state, acrylic, downloads, page screenshots, permissions, guest context menus, the replayed keystrokes, forwarded guest focus, the PTY IPC bridge, the blocking engine and its counters, the folder picker, `permissions.json`, the certificate-error memory, site info and site-data clearing, `session.json`, the Spotify auto-pause IPC and the guests handed to that module, and the guards under Security notes (the webview attach hook, the `file:` navigation block, the download and reveal allowlists). |
| `preload.js` | The `window.api` contextBridge surface: shortcuts, open-url, pty, downloads, paths, versions, `adblock`, `site` (info / setPermission / resetPermissions / clearData / onPermissionsChanged), `capture` (tab / show), `onGuestFocus`, `app` (pickFolder / dirExists), `session`, `autopause` (status / setEnabled / setConfig / doctor / onStatus). |
| `app.js` | The chrome: tab strip, webview lifecycle, omnibox, navigation, theme, Claude tabs, split view (pages and chambers alike), the "Claude needs you" mark and its notification, `askClaude()` and the three prompts it composes (link, screenshot, article), the history-page push and its `console-message` bridge, the new-tab background push and the re-push of theme, settings, background and recents on every `dom-ready`, the watch that freezes the board under panes and off window focus, `claudeStartArgs()` and the resume entry points, session save/restore, tab menu, crash cards. |
| `shortcuts.js` | The one binding table: every rebindable action with its group and default, the combo grammar, the `localStorage['shortcuts']` overrides, and `bindings()` / `actionFor()` / `set()` / `conflict()` / `resetAll()`. Loaded before app.js, which pushes its map to main; main.js keeps a hand copy of the grammar that has to move with it. |
| `workspaces.js` / `workspaces.css` | The workspace instrument: the titlebar pill and the switcher popover (switch, rename, colour, delete, create, and move mode for a tab). Drives app.js's workspace API, which is feature-detected, so a chrome without it renders nothing. |
| `pty.js` | PTY session manager — spawns `claude.exe` under ConPTY with a scrubbed environment and an argument allowlist (`--continue`, `--resume`, bare). |
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
| `tabsearch.js` / `tabsearch.css` | Tab search and the command palette: the titlebar button, the filtering pane over open and recently closed tabs, and — behind a `>` — the browser's own verbs. |
| `sitestyles.js` | Per-host CSS, per-host scripts and force dark; owns `localStorage['sitestyles']` and injects into each guest. |
| `userstyle.js` | `window.UserStyle`: your own stylesheet for the chrome — the `localStorage['userstyle']` string, the `<style id="user-chrome">` kept last in `<head>`, the 64 KB cap, and the Ctrl+Alt+Shift+R reset. |
| `reader.html` / `reader-page.css` / `reader-page.js` | The reading page itself: top bar, text size and width, `window.__applyArticle`, and the second sanitiser sweep over the live tree. Owns `localStorage['reader']`. |
| `newtab.html` / `newtab.css` / `newtab.js` | The search page: chips, engine, favicons, placeholder, and the background layers behind them (`window.__applyBackground`, `data-bg`, `#bg-image` / `#bg-dim`). `newtab-theme.js` runs first on it, resolving `?theme`, `?palette` and `?hue` before the stylesheet. |
| `newtab-bg.js` | The circuit board — canvas painted once per layout, packets as DOM on Web Animations. Owns `window.__boardPaused` / `__boardState`, the freeze the chrome drives while an overlay is open. |
| `smoketest.js` / `cdp-eval.js` / `cdp-profile.js` | Launch the app on CDP port 9222 and assert the chrome ids and a spawning Claude PTY; evaluate one expression in the running instance; CPU-profile it and print the hottest functions by self time. |
| `assets/` | `browser.ico` and `browser.png` (the app/shortcut icon). |
| `CHANGELOG.md` | What changed and why, by area, written to be read instead of the diffs. |

Runtime dependencies beyond Electron: `@homebridge/node-pty-prebuilt-multiarch` (ConPTY),
`@xterm/xterm` with `@xterm/addon-fit`, `@ghostery/adblocker-electron` with
`@ghostery/adblocker-electron-preload` (which nothing here names — the blocker resolves its path
itself), and `@mozilla/readability`, which index.html no longer loads: reader.js injects it out of
`node_modules/` on the first reader open, as a classic script so it leaves a global `Readability`.
`ws` is a devDependency, for CDP.

## Design rules worth keeping

- Every colour resolves through a token. A theme is nothing but a second token block and a
  palette a third, and no rule below the token blocks tests `data-theme` or `data-palette`. The
  light theme is custom properties only; type and metric tokens are inherited, not redeclared.
  The instrument tokens (`--bevel`, `--bevel-lg`, `--radius-ctl`, `--rim`, `--rim-focus`,
  `--rim-soft`, `--pip-glow`, `--pip-amber`, `--pip-amber-strong`, `--seam-v` and
  `--readout-stretch`) are built out of those theme tokens with `var()`, so the one definition
  covers dark, light and all six palettes, and a palette that relights `--ion` relights them with
  it. They are never copied per palette.
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
- A label inside a control that transitions `color` declares its own colour. The theme switch
  rewrites `--fg` underneath that transition, so an inherited label spends its first step on the
  old theme's value, which after a flip to light is near-white type on a white pane.
- Anything floating over a page uses `--panel-bg`, not `--glass`. Glass is see-through, and
  there is nothing behind a popover to blur except the guest's own content.
- No continuous animation under `backdrop-filter`. Everything that moves is stepped, because a
  drifting full-screen effect behind the blur once cost about a quarter of a core for the chrome
  alone — and it is why the new tab's board freezes under any pane, and while unfocused.
- System fonts only: `--ui-font` is Bahnschrift / Segoe UI Variable / Segoe UI, `--icon-font` is
  Segoe Fluent Icons. Glyphs are codepoint escapes so no encoding round-trip can eat one.
- `--ion` (ice cyan, or the palette's accent, or a chosen hue) is the one accent and marks what is
  active. `--amber` means exactly one thing: a Claude session — live, or waiting on you.
- `#views webview` keeps a white background in both themes: a guest page is transparent, so this
  is what a site without its own background paints on.
- A guest is never trusted with a preference it can set itself. Anything a page can flip is
  re-pinned in main before the guest attaches, not read back and checked afterwards.

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
instance you drive by hand should be started with `--test-profile`: its storage and theme choice
stay out of the real profile, at `%LOCALAPPDATA%\Temp\browser-test-profile`, where a test run's
`session.json`, `adblock.json` and `adblock-engine.bin` land too. The test polls for `body.booted`
before it touches any tab, then closes any Claude tabs the restored session brought back.

Never kill every `electron.exe` — I run my own Claude Code instance on Electron and it will go
down with it. Kill only the test instance: find the PID whose command line contains
`remote-debugging-port=9222` and no `--type=`.
