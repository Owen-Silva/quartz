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
  onOpenUrl: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('open-url', handler);
    return () => ipcRenderer.removeListener('open-url', handler);
  },
  // Paths only the main process knows for sure -- never guess at them here.
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    // The theme GUEST PAGES see (prefers-color-scheme), not the chrome's own:
    // 'system' | 'light' | 'dark'. Main has no access to localStorage, so the
    // renderer replays the stored choice at load and on every change.
    setSiteTheme: (mode) => ipcRenderer.send('app:site-theme', { mode }),
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
  pty: {
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
