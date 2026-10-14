// argvurl.js - the URL on a command line Windows (or anything else) started
// Quartz with. Pure: no Electron, so argvurl-harness.js runs it under plain node.
//
// Three shapes arrive:
//   http(s)://...      the URL association's "%1" (a clicked link)
//   file:///C:/x.html  a caller that already holds a URL (e.g. `Quartz.exe <root>
//                      file:///C:/x.html`); until 2026-10-14 this fell through
//                      to the path branch below and became the nonsense path
//                      <cwd>\file:\C:\x.html
//   C:\dir\x.html      the .htm/.html association's "%1", which is a PATH
// Anything else - Electron's own switches, the app directory, junk - is skipped.
const path = require('path');
const { pathToFileURL } = require('url');

/** A file: URL that parses and names a local file, as its canonical href, or null. */
function fileUrl(arg) {
  try {
    const u = new URL(arg);
    if (u.protocol !== 'file:' || !u.pathname || u.pathname === '/') return null;
    return u.href;
  } catch (err) {
    return null;
  }
}

/**
 * The URL on a command line, or null. A switch starts with '-'; the app path
 * is neither a URL nor an .htm(l) file. The LAST candidate wins, which is where
 * Windows puts the '%1' it substitutes.
 */
function urlFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = String(args[i] || '').trim();
    if (!arg || arg.startsWith('-')) continue;
    if (/^https?:\/\/[^\s/]/i.test(arg)) return arg;
    // Checked BEFORE the path branch: a file: URL ending in .html would match
    // that too, and path.resolve() would glue it onto the working directory.
    if (/^file:/i.test(arg)) {
      const href = fileUrl(arg);
      if (href) return href;
      continue;
    }
    // The .htm / .html association hands over a PATH, not a URL.
    if (/\.html?$/i.test(arg)) {
      // Any other scheme ("ftp://x/y.html", "javascript:...html") is not a path.
      if (/^[a-z][a-z0-9+.-]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) continue;
      try {
        return pathToFileURL(path.resolve(arg)).href;
      } catch (err) {
        return null;
      }
    }
  }
  return null;
}

module.exports = { urlFromArgv };
