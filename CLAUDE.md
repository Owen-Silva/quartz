# Working on Quartz (for contributors and coding agents)

Read this before editing. The design log is `docs/engineering-notes.md` ("Files" says which file owns
what; "Performance", "Design rules worth keeping" and "Development" hold the rules below in full).
Where a document and the code disagree, the code and its tests are the evidence.

## Where to work

- A clone Quartz is running from is live: its files, `node_modules` and `node_modules/electron` are in
  use. Never edit, check out, stash or reset there, and never launch anything from its Electron (the
  in-app updater swaps `node_modules` and a running copy holds it locked). Work in a linked worktree:
  `git worktree add ../quartz-wt/<name> -b wk/<name> master`. The updater never runs from a worktree.
- If you junction a shared `node_modules` into a worktree, never `git worktree remove --force` that
  worktree: it deletes the junction target's contents. Remove the junction first.
- After every edit to a `.js` file run `node --check <file>`. `app.js` (~12k lines), `main.js` and
  `settings.js` (~9k) are large: read line ranges and grep, don't load them whole.

## Tests

- `node tools/run-suite.js --unit`: the pure-node harnesses, no Electron, a few minutes at most.
  Run it after any change; add or extend a harness (`<area>-harness.js` or `tests/<area>-test.js`, plus
  one manifest entry in `tools/run-suite.js`) for everything you build.
- `node tools/run-suite.js` adds the Electron e2e tests; `--only=a,b`, `--skip=a,b`, `--out=<dir>`.
  Each e2e launches a real off-screen instance, one at a time, and refuses to start under 2.5 GB free
  RAM (shown as SKIP with that reason, never as a pass). On a small machine prefer CI: the `ci` workflow
  runs the unit suite on every push and PR and the full suite nightly (Actions > ci > Run workflow).
- Judge a run by its summary line, never the exit code: each harness ends with
  `<name>: N passed, M failed`, and the suite with
  `quartz-suite: N files: P pass, F FAIL, S skipped | checks ... passed, ... failed`.
  A harness with no summary line counts as a FAIL.

## Test instances

- Anything you launch by hand uses `--test-profile --profile-name=<x>` (storage goes to
  `%TEMP%\browser-test-profile-<x>`, never the real profile) and a debugging port of its own; not 9222
  (`smoketest.js` defaults to it; set `SMOKE_PORT`). Two instances on one profile fight over the same
  LevelDB and `window-state.json`: one port and one profile name each.
- Kill only the PIDs you started, matched by their command line (`--profile-name=<x>`). Never kill by
  image name (`electron.exe`): every other Electron app on the machine goes down with it.
- Before measuring CPU, put the window behind something real: an occluded or minimised window composites
  nothing and reads as free.

## Process split and the renderer

- The window's renderer (`index.html`: `app.js`, `settings.js`, ...) is plain browser scripts with
  `contextIsolation` on and `nodeIntegration` off: no `require`, no `import`. The only bridge is the one
  `window.api` object exposed by `preload.js`. Main is plain CommonJS modules wired by `main.js`.
- Bundled pages (new tab, history, files, search, Lumen) are `file://` guests with no preload and no
  `window.api`; they talk to the chrome with one prefixed console line, which the chrome checks,
  parses and validates before acting.
- A guest is never trusted with a preference it can set itself: re-pin it in main before the guest
  attaches, don't read it back and check afterwards.

## `<webview>` gotchas

- Never move a `<webview>` in the DOM. Re-parenting a guest leaves its webContents alive but stops it
  painting; split view is flex layout on children that are already there.
- `findInPage`: Electron's `findNext: true` STARTS a new find session and `false` continues the last
  one (see `find.js` `callFind`). It reads inverted; keep the mapping in one place.
- `webview.getURL`, `canGoBack`, `canGoForward` and `getZoomLevel` are synchronous IPC into main, not
  property reads. Cache per guest, invalidate on navigation, never call them in a loop or on every tab
  switch. One IPC per real change: memoise pushes against the last value sent.

## Look and motion

- Every colour resolves through a token in `tokens.css`; its names follow Helm's, and a page's older
  names may survive only as aliases onto them, never as new colours. Neutral grey, one restrained
  accent (`--ion`) for state, no glow at rest; focus is the one thing that blooms. Motion uses the
  `--m-*` tokens.
- Nothing animates at rest under `backdrop-filter`: a moving layer behind the blur re-blurs every
  frosted surface above it and once cost a quarter of a core. Anything that must pulse inside a frosted
  row gets its own layer.
- A `display` rule outranks the UA's `[hidden]`; give such elements an explicit `[hidden]` rule.

## No silent failures

Anything off, missing, refused or falling back says so, with its reason in plain words, in the UI it
affects. A log line (`log.js`, `quartz.log`) is in addition to that, never instead of it.

## Public repository

- This repo is public. Code, comments and commit messages say "the user"; no personal names, local
  paths, machine details or private project names.
- Commits may be checked by local secret / personal-data hooks, and `.github/workflows/oss-guard.yml`
  runs gitleaks over the full history on every push and PR. Never bypass a hook with `--no-verify`; if
  one refuses, fix the content.
- Code ported closely from an MPL-2.0 project keeps the MPL-2.0 header in that file plus a line
  "Portions derived from <project> (<url>), MPL-2.0". Ideas and independent re-implementations need no
  notice. Third-party notices live in `CREDITS.md`; the licence is GPL-3.0-only with the exceptions in
  `LICENSE-EXCEPTIONS.md`.
- Issues are welcome; pull requests are not accepted right now (README, Licence).
