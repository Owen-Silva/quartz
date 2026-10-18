// filenav.js -- may a PAGE take a guest onto a file:// URL? The one decision, pure, so
// filenav-harness.js can walk every case without an Electron.
//
// main.js asks it twice: from the guest's will-navigate (a link click, location.assign, a form)
// and from setWindowOpenHandler (target="_blank", window.open). Navigation the CHROME drives --
// the omnibox, loadURL, setAttribute('src') -- never reaches either hook, so typing a file:// path
// is not this file's business.
//
// The rule is Chrome's: a file:// page may open another file:// page; nothing else may.
//
//   from a bundled Quartz page (newtab.html, reader.html)  -> allowed (our own pages)
//   from a file:// page, started BY that file:// page       -> allowed (file -> file, as in Chrome)
//   from http(s), data:, blob:, about:, anything else       -> blocked, and the tab says so
//   from a file:// page, but started by a frame inside it
//     that is NOT file:// (an http iframe doing top.location
//     = 'file:///...')                                      -> blocked
//
// Why file -> file is safe to let through (2026-10-17, the lock was eating plain relative links
// like <a href="1-prism.html"> on a local page and saying nothing):
//
//   - The lock exists to stop a WEB page walking a guest onto file:///C:/Users/... . A file://
//     page is already on the disk side of that line: whatever it could do after the click it
//     could already do before it. A downloaded malicious .html runs as file:// the moment it is
//     opened (from the omnibox, a download, Explorer), and following its own links adds nothing.
//   - What a file:// page can READ is decided by Chromium's file-origin rules and Electron's
//     GrantFileProtocolExtraPrivileges fuse, not by navigation. The guest is pinned to
//     webSecurity: true in will-attach-webview (main.js), so the same-origin policy is on;
//     filelinks-e2e.js records what a file:// guest can fetch on this build. Navigating does not
//     widen it: the new page gets its own file:// document like any other.
//   - The initiator check keeps the one indirect route closed: a web frame embedded in a local
//     page cannot borrow the page's file:// standing to navigate the top frame. Chromium refuses
//     that too ("Not allowed to load local resource"); this is the second lock, as before.
//   - For a new window the handler gets no initiator frame, only a referrer. A file:// page sends
//     none; a web frame inside one sends its own http(s) origin. So a referrer that is neither
//     empty nor file:// is a web frame asking, and is refused.
'use strict';
const { fileURLToPath } = require('url');

const isFileUrl = (url) => typeof url === 'string' && /^file:/i.test(url);

/**
 * @param {string} target     where the page wants to go
 * @param {string} from       the guest's committed URL right now (its main frame)
 * @param {string|null} by    the URL of the frame that started it: will-navigate's initiator, or a
 *                            window.open referrer. null/'' = not known (then `from` stands for it).
 * @param {string} bundledPrefix  the file:// prefix of the app folder (main.js BUNDLED_PAGE_PREFIX)
 * @returns {boolean} true = let it go
 */
function pageMayOpen(target, from, by, bundledPrefix) {
  if (!isFileUrl(target)) return true; // not ours: every other scheme has its own gate
  const isBundled = (u) => typeof u === 'string' && !!bundledPrefix
    && u.toLowerCase().startsWith(String(bundledPrefix).toLowerCase());
  if (isBundled(from)) return true; // the new tab page's field, reader.html's way back
  if (!isFileUrl(from)) return false;
  // A local page. Only the page itself (or another local frame) may move it.
  if (by && !isFileUrl(by)) return false;
  return true;
}

/** "C:\Users\...\x.html" for the notice, or the URL as given when it is not a usable path. */
function displayPath(url) {
  try { return fileURLToPath(url); } catch (e) { return String(url || ''); }
}

/** The one line the tab shows when pageMayOpen() said no. */
function blockedNotice(url) {
  return 'Quartz blocked this page from opening a file on your computer: ' + displayPath(url);
}

module.exports = { isFileUrl, pageMayOpen, displayPath, blockedNotice };
