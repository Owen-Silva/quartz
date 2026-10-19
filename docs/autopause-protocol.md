# Spotify auto-pause: the host protocol (version 2)

Mantle and Quartz both ship Spotify auto-pause: Spotify pauses while something else plays video or
lesson audio, and resumes afterwards. Each app works alone. When both run, they cooperate through this
protocol, with exactly one decision maker. This file is identical in both repos (`docs/autopause-protocol.md`).

## The shared code

The protocol lives in three files, kept byte-identical in both repos. Change both copies together.

| Role | Mantle | Quartz |
|---|---|---|
| Rules engine: holds, only-resume-what-we-paused, re-pause back-off, TTLs, inherit | `lib/features/_autopause-core.js` | `autopause-core.js` |
| Host HTTP API and its security gate | `lib/features/_autopause-compat.js` | `autopause-compat.js` |
| Election, client, takeover | `lib/features/_autopause-link.js` | `autopause-link.js` |
| Test (the same file) | `lib/features/autopause-link.test.js` | `autopause-link-harness.js` |

Each app supplies its own eyes and hands:

- **What plays.** Mantle meters desktop apps by audio peak, walking each app's process tree, and reads
  Windows' media sessions. Quartz watches its own tabs (audible, not muted, on a watched site).
- **How Spotify is paused.** Both use the Windows media session API (WinRT
  `GlobalSystemMediaTransportControlsSessionManager`) on Spotify's session. Mantle calls it from its C#
  sidecar (`sidecar/Media.cs`). Quartz calls it from a small PowerShell helper (`autopause-smtc.ps1`),
  because Quartz has no sidecar.

## Roles

1. **Election.** On start, an app probes `GET /ping` on 127.0.0.1:8787, 8788, 8789 and 8790. A reply with
   `"app":"spotify-autopause"` is a host, so the app becomes its **client** (the lowest port wins).
   If nothing answers and the app may host (its auto-pause switch is on), it binds the first free port
   and becomes the **host**. Binding is the lock: if two apps start together, only one gets 8787. A host
   that bound a higher port probes the ports below it once, and yields if it finds a host there. If all
   four ports are taken by other software, the app still decides for itself, but nothing can reach it.
2. **Host.** This app is the only one that pauses or resumes Spotify. Its own holds go straight into its
   engine. Other apps' holds arrive over HTTP. Spotify pauses while any hold exists and resumes when the
   last one ends. It only resumes a pause it made.
3. **Client.** The client sends its holds to the host and never touches Spotify itself. It keeps one
   `/watch` long poll open on the host.
4. **Takeover.** When the host's socket closes, because it quit or crashed, the client elects again
   about 150 ms later. A client that may host binds the port and becomes the host. The old standalone
   bridge has no `/watch`, so a client of it polls `/ping` every 3 s instead.

## Routes (served by the host)

| Route | Meaning |
|---|---|
| `GET /ping`, `GET /status` | The host's status (see below). |
| `GET /pause?src=<id>[&ttl=<ms>][&can=host]` | Take or refresh the hold named `src`. Re-send it every 60 s. `ttl` is the hold's expiry, clamped to 5 s to 10 min (default 180 s). `can=host` means the sender can take over as host. |
| `GET /resume?src=<id>` | Release the hold named `src`. |
| `GET /watch?src=<id>&since=<sig>` | Long poll. The host answers at once if `since` differs from its current `sig`, otherwise when the status changes, or after 240 s. |
| `GET /now`, `POST /control {"cmd":...}`, `GET /config`, `GET /sessions` | Now playing and transport control (`play`, `pause`, `toggle`, `next`, `prev`). While the host holds a pause it refused, `play` and `toggle` answer `{"ok":false,"reason":"held"}`. |

`src` must match `^[A-Za-z0-9:._-]{1,80}$`. Anything else becomes `browser`. The source names in use:

| `src` | Sender |
|---|---|
| `mantle` | Mantle as a client |
| `quartz` | Quartz as a client |
| `browser` | The Opera GX / Chromium extension written for the old bridge |

Status fields: `ok`, `app` (`"spotify-autopause"`), `server` (`"mantle"` or `"quartz"`; absent on the
old bridge), `protocol` (`2`), `port`, `spotifyFound`, `spotifyState`, `heldByUs`, `wePaused`, `holds`,
`repauseSuppressed`, `repauseSuppressedForMs`, `sig`.

## No fighting, no stuck pause

- **One decision maker.** Only the host has a Spotify controller wired to its engine. A client's engine
  sees no Spotify, so it can never pause or resume.
- **Handoff.** A host that stops while a `can=host` client still holds and watches leaves Spotify paused
  and does not resume. The client takes over and inherits the pause, so the music does not stop, start
  and stop again. With no such client, the host resumes what it paused, as it always has.
- **Inherit.** A new host takes over the old host's pause (`wePaused`) only if Spotify is paused now.
  If nothing holds any more, it resumes at once. A host crash therefore cannot leave Spotify stuck.
  It also inherits the "leave Spotify alone" back-off, so a change of host never starts a new fight
  with a user who pressed play.
- **Client crash.** A client whose `/watch` socket closes before the host answered has gone, and its
  hold is dropped at once. The hold's TTL is the backstop for clients that do not watch, such as the
  browser extension.

## Security gate (the same in both hosts)

- **Origin.** A request with an `Origin` header is served only from a browser extension
  (`chrome-extension://`, `moz-extension://`, `extension://`). A web page gets 403.
- **No Origin.** The request counts as a local app only if it also carries no `Sec-Fetch-Site`, or
  `none`. A page's `<img src=".../pause">` or no-cors GET is refused with 403 before any route runs.
- **Host header.** It must be `127.0.0.1` or `localhost`, which stops DNS rebinding.
- **Limits.** Request bodies are capped at 4 KB. `/control` takes only the five commands above.
