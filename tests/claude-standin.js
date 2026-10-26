// tests/claude-standin.js -- a stand-in for claude.exe, for askclaude-harness.js (and an e2e on a
// test profile). pty.js runs it in place of the real CLI only when the process was started with
// --test-profile AND QUARTZ_TEST_CLAUDE names this file, so no test ever starts a real Claude
// Code session.
//
// What it does, in a real PTY:
//   1. writes {"argv": [...], "cwd": "..."} as the first line of the log file named by
//      QUARTZ_STANDIN_LOG (the flags and folder it was actually started with);
//   2. turns bracketed paste ON (DECSET 2004), the way Claude Code does when its input box is up,
//      and prints a banner long enough (> 200 bytes) for terminal.js to see a first quiet;
//   3. appends every chunk it reads from its input to the log as a JSON line {"in": "<text>"},
//      so a test can see exactly which bytes arrived and whether any escape code was among them;
//   4. exits when it reads the line "__quit__" or after 120 s, whichever is first.
'use strict';
const fs = require('fs');

const logFile = process.env.QUARTZ_STANDIN_LOG || '';
function log(obj) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, JSON.stringify(obj) + '\n'); } catch (err) { /* nowhere to say it */ }
}

log({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() });

const ESC = String.fromCharCode(27);
process.stdout.write(ESC + '[?2004h');
process.stdout.write('claude stand-in (test only). This is not Claude Code: it records what it is sent.\r\n'
  + 'The lines below pad the first burst past the idle threshold so a queued paste goes in.\r\n'
  + '.........................................................................\r\n'
  + '.........................................................................\r\n> ');

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
// Raw mode is on from here: a test writes only after this row, or the console's line editing
// would eat escape sequences before this program ever saw them.
log({ pid: process.pid, ready: true });
let seen = '';
process.stdin.on('data', (chunk) => {
  log({ pid: process.pid, in: chunk });
  seen += chunk;
  if (seen.indexOf('__quit__') !== -1) finish();
});

function finish() {
  log({ pid: process.pid, done: true });
  process.stdout.write(ESC + '[?2004l');
  process.exit(0);
}
setTimeout(finish, 120000).unref();
