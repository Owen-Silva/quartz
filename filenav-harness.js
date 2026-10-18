// filenav-harness.js -- filenav.js's rule, every case, pure node (no Electron).
//
//   node filenav-harness.js
//
// One summary line: "filenav: N passed, M failed".
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const nav = require('./filenav');

let pass = 0, fail = 0;
const check = (cond, label, detail) => {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

const APP = pathToFileURL(path.join(__dirname, path.sep)).href; // main.js BUNDLED_PAGE_PREFIX
const LOCAL_A = 'file:///C:/Users/you/next-week/lumen/logo/index.html';
const LOCAL_B = 'file:///C:/Users/you/next-week/lumen/logo/1-prism.html';
const SECRET = 'file:///C:/Users/you/.ssh/id_ed25519';
const may = (target, from, by) => nav.pageMayOpen(target, from, by, APP);

// ---- not a file:// target: not this rule's business -------------------------------------------
check(may('https://example.com/', 'https://evil.test/', '') === true, 'an http target is not judged here');
check(may('data:text/html,hi', LOCAL_A, '') === true, 'a data: target is not judged here (its own gates)');

// ---- file -> file: the user's logo page -------------------------------------------------------------
check(may(LOCAL_B, LOCAL_A, LOCAL_A) === true, 'a local page\'s relative link to a sibling file goes through');
check(may(LOCAL_B, LOCAL_A, '') === true, 'file -> file with no initiator known (the page itself) goes through');
check(may(LOCAL_B, LOCAL_A, null) === true, 'file -> file with a null initiator goes through');
check(may(LOCAL_B, 'FILE:///C:/x/a.html', '') === true, 'the scheme test is case-insensitive');
check(may('file:///C:/Users/you/', LOCAL_A, LOCAL_A) === true, 'a local page may open a folder listing, as in Chrome');

// ---- bundled pages, as before ---------------------------------------------------------------------
check(may(LOCAL_A, APP + 'newtab.html', '') === true, 'the new tab page may open a file:// it was given');
check(may(LOCAL_A, APP.toUpperCase() + 'reader.html', '') === true, 'bundled-page test is case-insensitive');

// ---- everything else is refused -------------------------------------------------------------------
check(may(SECRET, 'https://evil.test/', 'https://evil.test/') === false, 'an https page cannot open a file');
check(may(SECRET, 'http://127.0.0.1:8080/x.html', '') === false, 'an http page cannot open a file');
check(may(SECRET, 'data:text/html,<a href=file:///>', '') === false, 'a data: page cannot open a file');
check(may(SECRET, 'blob:https://evil.test/1234', '') === false, 'a blob: page cannot open a file');
check(may(SECRET, 'about:blank', '') === false, 'about:blank cannot open a file');
check(may(SECRET, '', '') === false, 'an unknown current page cannot open a file');
check(may(SECRET, LOCAL_A, 'https://evil.test/frame.html') === false, 'a web iframe inside a local page cannot move it onto a file');
check(may(SECRET, LOCAL_A, 'about:srcdoc') === false, 'a srcdoc frame inside a local page cannot either');

// ---- the notice ----------------------------------------------------------------------------------
const line = nav.blockedNotice('file:///C:/Users/you/My%20Docs/a.html');
check(line === 'Quartz blocked this page from opening a file on your computer: C:\\Users\\you\\My Docs\\a.html'
  || (process.platform !== 'win32' && /My Docs\/a\.html$/.test(line)), 'the notice names the decoded path', line);
check(nav.displayPath('not a url') === 'not a url', 'a broken URL is shown as given');
check(nav.isFileUrl(42) === false && nav.isFileUrl('file:x') === true, 'isFileUrl guards its input');

console.log(`filenav: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
