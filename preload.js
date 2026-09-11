'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const HOME_DIR = 'C:\\Users\\you';

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
  pty: {
    // opts: { cwd, cols, rows, args } -- args is an allowlist (`--continue`).
    start: (opts) => ipcRenderer.invoke('pty:start', opts),
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
