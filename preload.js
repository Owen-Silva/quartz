'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const HOME_DIR = 'C:\\Users\\you';

// Claude chambers start with --dangerously-skip-permissions unless the
// renderer has said otherwise (api.pty.setPrefs). It is kept HERE rather than
// only at the call site in app.js because pty.start() is the one funnel every
// spawn goes through: terminal.js drops the first-spawn flags when the user
// presses Enter to restart a finished session, and that restart should skip
// prompts exactly like the tab it replaces. pty.js de-duplicates, so a call
// that already carries the flag is unaffected.
const SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions';
let ptySkipPermissions = true; // default until the renderer says otherwise

function withSkipPermissions(opts) {
  const out = (opts && typeof opts === 'object') ? { ...opts } : {};
  if (!ptySkipPermissions) return out;
  const args = Array.isArray(out.args) ? out.args.slice() : [];
  if (args.indexOf(SKIP_PERMISSIONS_ARG) === -1) args.unshift(SKIP_PERMISSIONS_ARG);
  out.args = args;
  return out;
}

contextBridge.exposeInMainWorld('api', {
  homeDir: HOME_DIR,
  // Shortcuts the main process caught on our behalf because focus was inside a
  // <webview> and the keystroke never reached this renderer.
  onShortcut: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },
  // A context-menu item in a page asked for a URL to be opened as a tab:
  // { url, background }. background:true means do not steal focus.
  // Fired by main whenever a guest webContents gains focus: { wcId }.
  onGuestFocus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('guest-focus', handler);
    return () => ipcRenderer.removeListener('guest-focus', handler);
  },
  onOpenUrl: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('open-url', handler);
    return () => ipcRenderer.removeListener('open-url', handler);
  },
  // A page's context menu asked for what is on screen to be handed to a Claude
  // chamber: { url, title, selection }. `selection` is '' for the whole-page
  // item, and is Chromium's already-truncated selectionText for the other one.
  // The renderer composes the prompt and pastes it into the session's INPUT --
  // nothing here ever runs anything.
  onAskClaude: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('ask-claude', handler);
    return () => ipcRenderer.removeListener('ask-claude', handler);
  },
  // Paths only the main process knows for sure -- never guess at them here.
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    // The theme GUEST PAGES see (prefers-color-scheme), not the chrome's own:
    // 'system' | 'light' | 'dark'. Main has no access to localStorage, so the
    // renderer replays the stored choice at load and on every change.
    setSiteTheme: (mode) => ipcRenderer.send('app:site-theme', { mode }),
    // Native "choose a folder for Claude" dialog. Resolves to the chosen
    // absolute path, or null if the user cancelled.
    pickFolder: (defaultPath) => ipcRenderer.invoke('app:pick-folder', { defaultPath }),
    // True only for an existing directory -- used to validate a typed path.
    dirExists: (path) => ipcRenderer.invoke('app:dir-exists', { path }),
    // Close and reopen the browser, tabs and all: the same graceful shutdown a
    // window close does, then a relaunch with this run's own argv (so a test
    // instance comes back a test instance). Nothing to await -- the process is
    // gone before a reply could arrive.
    restart: () => ipcRenderer.send('app:restart'),
    // Sync: these are already in this process, so nothing has to be awaited.
    versions: () => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    })
  },
  // The window is frameless: the chrome draws its own caption buttons and
  // drives the real window through these.
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    info: () => ipcRenderer.invoke('win:info'),
    toggleFullscreen: () => ipcRenderer.send('win:fullscreen-toggle'),
    onMaximized: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.removeListener('win:maximized', handler);
    },
    onFullscreen: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:fullscreen', handler);
      return () => ipcRenderer.removeListener('win:fullscreen', handler);
    },
    // The REAL window's focus, as { focused }. Not the same thing as this
    // document's blur/focus: clicking into a <webview> blurs the chrome
    // document while the window itself never lost focus. Main sends the
    // current state once the page has loaded, then on every change.
    onFocus: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:focus', handler);
      return () => ipcRenderer.removeListener('win:focus', handler);
    }
  },
  // Downloads land in the Downloads folder with no prompt; main streams every
  // state change here as { id, filename, url, savePath, state, received,
  // total, paused, startedAt, finishedAt }.
  downloads: {
    list: () => ipcRenderer.invoke('dl:list'),
    cancel: (id) => ipcRenderer.send('dl:cancel', { id }),
    pause: (id) => ipcRenderer.send('dl:pause', { id }),
    resume: (id) => ipcRenderer.send('dl:resume', { id }),
    open: (id) => ipcRenderer.invoke('dl:open', { id }),
    show: (id) => ipcRenderer.send('dl:show', { id }),
    clear: () => ipcRenderer.send('dl:clear'),
    // "Ask where to save each file" lives in the renderer's settings store,
    // which main cannot read -- so the renderer pushes it at boot and on every
    // change. { askWhere:true } makes main show the native Save dialog.
    setPrefs: (prefs) => ipcRenderer.send('dl:prefs', { askWhere: !!(prefs && prefs.askWhere) }),
    // The Downloads folder itself, in Explorer -- not one file in it.
    openFolder: () => ipcRenderer.send('dl:open-folder'),
    downloadUrl: (url) => ipcRenderer.send('dl:download-url', { url }),
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('dl:update', handler);
      return () => ipcRenderer.removeListener('dl:update', handler);
    }
  },
  // Page screenshots. capturePage() belongs to the guest's webContents, so main
  // does the work and writes the PNG into the Downloads folder itself -- it is
  // NOT a download item, so nothing about it comes back over dl:update.
  // `wcId` is a <webview>'s webContents id (webview.getWebContentsId()).
  capture: {
    // Resolves to { path, width, height } or { error }; never rejects.
    // `full` is reserved for a future full-page capture and does nothing yet.
    tab: (wcId, full) => ipcRenderer.invoke('capture:tab', { wcId, full: !!full }),
    // Reveal a finished screenshot in Explorer.
    show: (path) => ipcRenderer.send('capture:show', { path })
  },
  // The new tab's moving background. A renderer can read a picked picture on
  // its own, but a clip has to keep playing after the file moves -- so main
  // runs the dialog and copies the chosen file into <userData>/backgrounds/,
  // and settings.js stores only the file:// URL it hands back.
  background: {
    // Resolves { ok: true, fileUrl, fileName, bytes } or { ok: false, reason }
    // ('cancelled', 'too-large' past 512 MB, or a message). Never rejects.
    chooseVideo: () => ipcRenderer.invoke('background:choose-video'),
    // Deletes the copied clip; resolves { ok: true } either way.
    clearVideo: () => ipcRenderer.invoke('background:clear-video')
  },
  // Ad / tracker blocking. The engine lives in main and covers every guest at
  // once, so everything here is either a preference or a per-tab counter.
  // `wcId` is a <webview>'s webContents id (webview.getWebContentsId()).
  adblock: {
    // { enabled, ready, allow: string[] } -- `ready` is "engine built AND
    // hooked into the session", so it is false both when the lists failed to
    // load and when blocking is switched off.
    state: () => ipcRenderer.invoke('adblock:state'),
    // { blocked, host, allowed } for one tab, right now.
    count: (wcId) => ipcRenderer.invoke('adblock:count', { wcId }),
    setEnabled: (on) => ipcRenderer.send('adblock:set-enabled', { on }),
    // host is normalised in main: lowercased, `www.` stripped.
    allowHost: (host, on) => ipcRenderer.send('adblock:allow-host', { host, on }),
    // { wcId, blocked, host, allowed }, throttled to <= 4/sec per tab.
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('adblock:update', handler);
      return () => ipcRenderer.removeListener('adblock:update', handler);
    },
    // Same shape as state(), pushed whenever the engine or prefs change.
    onStateChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('adblock:state-changed', handler);
      return () => ipcRenderer.removeListener('adblock:state-changed', handler);
    }
  },
  // Everything behind the padlock for one page: how the connection is secured,
  // the explicit permission decisions for its origin, and the two destructive
  // actions. Every call resolves -- a failure comes back as { error: string }
  // rather than rejecting.
  site: {
    // { origin, host, scheme, secure, reason, permissions, promptable }.
    // reason is 'https' | 'http' | 'certificate' | 'local' | 'other';
    // permissions holds ONLY origins' explicit decisions ('allow' | 'block'),
    // and promptable lists the names that would raise a dialog.
    info: (url) => ipcRenderer.invoke('site:info', { url }),
    // decision: 'allow' | 'block' | 'ask' -- 'ask' forgets it, so the next
    // request prompts again. Resolves to the origin's updated map.
    setPermission: (origin, permission, decision) =>
      ipcRenderer.invoke('site:set-permission', { origin, permission, decision }),
    // Forget every decision for this origin. Resolves to the (empty) map.
    resetPermissions: (origin) => ipcRenderer.invoke('site:reset-permissions', { origin }),
    // Storage + cookies for one origin, host and parent domain: { cookiesRemoved }.
    clearData: (origin) => ipcRenderer.invoke('site:clear-data', { origin }),
    // { origin }, pushed after any permission change -- including ones made in
    // another window's popover or by answering a prompt.
    onPermissionsChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('site:permissions-changed', handler);
      return () => ipcRenderer.removeListener('site:permissions-changed', handler);
    }
  },
  // Durable mirror of the session localStorage holds. write() is fire-and-
  // forget (main writes it atomically); read() returns the parsed object or
  // null. The renderer decides which copy is newer by comparing savedAt.
  session: {
    write: (snapshot) => ipcRenderer.send('session:write', { snapshot }),
    read: () => ipcRenderer.invoke('session:read')
  },
  // Key bindings live in the renderer (shortcuts.js). A key pressed inside a
  // guest page is matched by main, so main needs the same map: it is mirrored
  // over at boot and again after every change. Fire-and-forget -- main keeps
  // its own defaults until something arrives.
  shortcuts: {
    set: (bindings) => ipcRenderer.send('shortcuts:set', { bindings })
  },
  // Spotify auto-pause. Two switches behind one group: `setEnabled` is the
  // WHOLE COMPUTER (the SpotifyAutoPause scheduled task and its local bridge),
  // `setConfig.browserHold` is only this browser's own tabs. Every call
  // resolves -- a bridge that is not running comes back as
  // { bridge: 'stopped', error: '...' }, never as a rejection.
  autopause: {
    // Status = { installed, enabled, bridge, port, spotify, wePaused, holds,
    //            browserHold, audibleTabs, config, error }. Answers in ~1.5 s
    //            even with nothing running, so it is safe to poll.
    status: () => ipcRenderer.invoke('autopause:status'),
    setEnabled: (on) => ipcRenderer.invoke('autopause:set-enabled', { on: !!on }),
    // Only the three known keys travel, and only in the right shape: main
    // re-validates anyway, but a typo here should not reach it as a mystery.
    // Hosts are sent as trimmed strings; main normalises and de-duplicates.
    setConfig: (patch) => {
      const p = patch && typeof patch === 'object' ? patch : {};
      const out = {};
      if (typeof p.browserHold === 'boolean') out.browserHold = p.browserHold;
      if (typeof p.anySite === 'boolean') out.anySite = p.anySite;
      if (Array.isArray(p.sites)) {
        out.sites = p.sites
          .map((s) => String(s == null ? '' : s).trim().slice(0, 253))
          .filter((s) => s.length > 0)
          .slice(0, 100);
      }
      return ipcRenderer.invoke('autopause:set-config', out);
    },
    // Runs doctor.ps1 -Json, which is read-only: { ok, text, json }.
    doctor: () => ipcRenderer.invoke('autopause:doctor'),
    // Pushed on every state change main sees (a hold taken or handed back, the
    // switch moving, a tab starting or stopping). Returns an unsubscribe.
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('autopause:changed', handler);
      return () => ipcRenderer.removeListener('autopause:changed', handler);
    }
  },
  // System stats for the new tab page (CPU, memory, disk, network, GPU).
  // Ref-counted in main: every subscribe() needs its own unsubscribe(), and
  // main samples nothing at all while the count is zero -- so the chrome
  // subscribes only while a new-tab page is actually in front of the user.
  // Samples land every 2000 ms; the first one arrives within 2 s.
  stats: {
    subscribe: () => ipcRenderer.send('stats:subscribe'),
    unsubscribe: () => ipcRenderer.send('stats:unsubscribe'),
    // fn({ t, cpu, mem, disk, net, gpu, uptimeSec }); a null field means the
    // counter is not available on this machine and the page draws a dash.
    // Returns an unsubscribe function for the LISTENER -- it does not touch
    // the sampler's ref count, which is subscribe()/unsubscribe()'s job.
    onSample: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('stats:sample', handler);
      return () => ipcRenderer.removeListener('stats:sample', handler);
    },
    // End the processes behind one row of the new tab page's process table.
    // pids is a plain array of numbers (at most 64; main drops the rest).
    // Resolves to [{ pid, ok, reason }] -- one entry per pid main accepted,
    // with the refusals ('self', 'protected', 'unavailable') spelled out so
    // the page can say why instead of just failing.
    endTask: (pids) => ipcRenderer.invoke('stats:end-task', Array.isArray(pids) ? pids : []),
    // The icon of the executable behind each process group, by the sample's own
    // group keys ('spotify', 'svchost'). At most 64 keys, each at most 64 chars
    // -- main drops the rest. Resolves to { [key]: dataUrl | null } with an
    // entry for every key main accepted; a null means "no icon for this one"
    // (unknown path, no icon in the exe), and it is worth asking again later.
    // Known keys come back from main's cache without touching the disk.
    procIcons: (keys) => ipcRenderer.invoke('stats:proc-icons', Array.isArray(keys) ? keys : [])
  },
  // Installed native apps: the new tab page's dock and the palette's
  // "Open <app>" rows. Main builds the index from Start Menu shortcuts plus
  // Get-StartApps, caches it for a day, and is the only one that ever starts a
  // process -- nothing here carries a command line.
  apps: {
    // { builtAt, buildMs, fromCache, iconsOmitted, counts, apps: [...] } where
    // each entry is { id, name, kind: 'exe'|'store', path, args, exe,
    // iconDataUrl }. `exe` is the lowercased basename ('spotify.exe') or null,
    // and it is what the caller matches against a stats sample's process
    // groups to know whether the app is running. `iconDataUrl` is a 32px PNG,
    // or null when the whole set was too big for one message -- then
    // iconsOmitted is true and icon(id) fetches them one at a time.
    // The first call of a session may take a second or two (the build); every
    // later one is served from memory.
    list: () => ipcRenderer.invoke('apps:list'),
    // One 32px PNG data URL by entry id, or null.
    icon: (id) => ipcRenderer.invoke('apps:icon', String(id == null ? '' : id)),
    // Start an app by entry id -> { ok, reason }. Detached: it resolves as soon
    // as Windows has taken the request, not when the app has drawn.
    launch: (id) => ipcRenderer.invoke('apps:launch', String(id == null ? '' : id)),
    // Bring a RUNNING app's main window forward by pid -> { ok, reason }.
    // This one does steal focus, because it only ever runs off a click on a
    // tile that was already showing a running dot.
    focus: (pid) => ipcRenderer.invoke('apps:focus', Number(pid)),
    // Rebuild the index from source (a newly installed app, a changed icon)
    // and resolve to the same shape as list().
    refresh: () => ipcRenderer.invoke('apps:refresh')
  },
  pty: {
    // opts: { cwd, cols, rows, args } -- args is an allowlist (`--continue`).
    // Called by terminal.js for the first spawn AND for the Enter-to-restart
    // one, so this is where the skip-permissions flag is guaranteed.
    start: (opts) => ipcRenderer.invoke('pty:start', withSkipPermissions(opts)),
    // { skipPermissions } -- the Settings switch, pushed by app.js at boot and
    // on every change. Nothing crosses IPC: it only steers start() above.
    setPrefs: (prefs) => {
      ptySkipPermissions = !(prefs && prefs.skipPermissions === false);
    },
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pty:data', handler);
      return () => ipcRenderer.removeListener('pty:data', handler);
    },
    onExit: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.removeListener('pty:exit', handler);
    }
  }
});
