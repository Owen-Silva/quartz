// tests/mcp-claude-standin.js -- a stand-in for claude.exe that also plays Claude Code's MCP CLIENT,
// for mcp-e2e.js. pty.js runs it in place of the real CLI only when the process was started with
// --test-profile AND QUARTZ_TEST_CLAUDE names this file, so no test ever starts a real Claude Code
// session.
//
// What it does, in a real PTY:
//   1. writes {"argv": [...], "cwd": "..."} as the first line of the log file named by
//      QUARTZ_STANDIN_LOG (the flags and folder it was actually started with);
//   2. turns bracketed paste ON and prints a banner, exactly like tests/claude-standin.js, and logs
//      every chunk it reads from its input as {"in": "<text>"};
//   3. if its argv carries `--mcp-config <file>`, reads that file and logs what it holds (whether the
//      pane's key is in it: it must not be; whether the key is in this process's environment: it must
//      be), then starts the server the file names the way Claude Code does (command + args, env =
//      this process's env plus the config's env, stdio pipes) and speaks MCP to it: initialize,
//      notifications/initialized, tools/list, then logs {"mcp": "waiting"} and acts on what it reads
//      (Quartz asks the user before a read, so the test drives each pane and answers its bar):
//        "__script__"            tools/call list_tabs, read_page on the first listed tab, highlight a
//                                phrase from that page, search_history for a word of its title, then
//                                read_page of the same tab again (logged "read_page_2"), then "finished";
//        "Look at tab <N> in Quartz" (the Ask about this page paste)   read_page N, logged "ask_read",
//                                as Claude would on that prompt;
//        "__read <N>__"          read_page N, logged "cmd_read".
//      Every answer is logged as {"mcp": "<step>", "res": <JSON-RPC message>}. A tool call waits up
//      to 75 s: longer than Quartz's 60 s wait for the user's answer, so a timed-out ask is seen as
//      Quartz's refusal, not as this client giving up;
//   4. exits when it reads "__quit__" or after 240 s, whichever is first.
// The key itself is never logged.
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const logFile = process.env.QUARTZ_STANDIN_LOG || '';
function log(obj) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, JSON.stringify(Object.assign({ pid: process.pid }, obj)) + '\n'); } catch (err) { /* nowhere to say it */ }
}

const args = process.argv.slice(2);
log({ argv: args, cwd: process.cwd() });

const ESC = String.fromCharCode(27);
process.stdout.write(ESC + '[?2004h');
process.stdout.write('claude stand-in with an MCP client (test only). This is not Claude Code.\r\n'
  + 'The lines below pad the first burst past the idle threshold so a queued paste goes in.\r\n'
  + '.........................................................................\r\n'
  + '.........................................................................\r\n> ');

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
log({ ready: true });
let seen = '';
let server = null;
let wake = null; // the command loop, parked until more input comes
process.stdin.on('data', (chunk) => {
  log({ in: chunk });
  seen += chunk;
  if (seen.indexOf('__quit__') !== -1) finish();
  if (wake) { const w = wake; wake = null; w(); }
});

function finish() {
  log({ done: true });
  try { if (server) server.kill(); } catch (err) { /* gone */ }
  process.stdout.write(ESC + '[?2004l');
  process.exit(0);
}
setTimeout(finish, 240000).unref();

// ---- the MCP client -------------------------------------------------------------------------------
const at = args.indexOf('--mcp-config');
if (at !== -1) {
  runClient(args[at + 1]).catch((err) => log({ mcp: 'error', error: String((err && err.stack) || err) }));
}

async function runClient(file) {
  const key = process.env.QUARTZ_MCP_TOKEN || '';
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { log({ mcp: 'config', error: 'unreadable: ' + err.message, file }); return; }
  let cfg = null;
  try { cfg = JSON.parse(raw); } catch (err) { log({ mcp: 'config', error: 'not JSON: ' + err.message, file }); return; }
  const srv = cfg && cfg.mcpServers && cfg.mcpServers.quartz;
  log({
    mcp: 'config',
    file,
    envToken: key.length > 0,
    tokenInFile: key.length > 0 && raw.indexOf(key) !== -1,
    tokenNameInFile: raw.indexOf('QUARTZ_MCP_TOKEN') !== -1,
    servers: Object.keys((cfg && cfg.mcpServers) || {}),
    type: srv && srv.type,
    command: srv && srv.command,
    args: srv && srv.args,
    envKeys: Object.keys((srv && srv.env) || {}),
  });
  if (!srv || !srv.command) return;

  server = spawn(srv.command, Array.isArray(srv.args) ? srv.args : [], {
    env: Object.assign({}, process.env, srv.env || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  log({ mcp: 'spawned', serverPid: server.pid });
  server.on('error', (err) => log({ mcp: 'spawn-error', error: err.message }));
  server.on('exit', (code, sig) => log({ mcp: 'server-exit', code, sig }));
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (d) => log({ mcp: 'stderr', text: String(d).slice(0, 400) }));

  const waiting = new Map();
  let buf = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (err) { log({ mcp: 'garbage', line: line.slice(0, 300) }); continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
      else log({ mcp: 'unsolicited', res: msg });
    }
  });
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    // A tool call may wait on the user (Quartz gives up after 60 s and says so): wait longer than that.
    const waitMs = method === 'tools/call' ? 75000 : 30000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve({ id, timeout: true }); }, waitMs);
      waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const textOf = (m) => ((m && m.result && m.result.content) || []).map((c) => c.text || '').join('\n');
  async function step(name, method, params) {
    const res = await request(method, params);
    log({ mcp: name, res });
    return res;
  }

  await step('initialize', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'quartz-test-standin', version: '1.0.0' },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await step('tools/list', 'tools/list', {});

  // What to do comes from the input, one command at a time, in the order it arrived.
  const COMMAND = /__script__|__read (\d+)__|Look at tab (\d+) in Quartz/g;
  let cursor = 0;
  function nextCommand() {
    COMMAND.lastIndex = cursor;
    const m = COMMAND.exec(seen);
    if (!m) return null;
    cursor = COMMAND.lastIndex;
    if (m[0] === '__script__') return { kind: 'script' };
    if (m[1]) return { kind: 'cmd_read', tabId: Number(m[1]) };
    return { kind: 'ask_read', tabId: Number(m[2]) };
  }
  log({ mcp: 'waiting' });
  for (;;) {
    const c = nextCommand();
    if (!c) { await new Promise((r) => { wake = r; }); continue; }
    log({ mcp: 'command', kind: c.kind, tabId: c.tabId });
    if (c.kind === 'script') await script();
    else await step(c.kind, 'tools/call', { name: 'read_page', arguments: { tabId: c.tabId } });
  }

  async function script() {
    const list = await step('list_tabs', 'tools/call', { name: 'list_tabs', arguments: {} });
    const m = /- tab (\d+)[^:\n]*: "([^"\n]*)"/.exec(textOf(list));
    if (!m) { log({ mcp: 'stop', why: 'list_tabs named no tab' }); return; }
    const tabId = Number(m[1]);
    const title = m[2];
    const read = await step('read_page', 'tools/call', { name: 'read_page', arguments: { tabId } });
    // A phrase from the page: QUARTZ_STANDIN_QUOTE when the test names one and the page has it,
    // else the first long line of the fenced body.
    const text = textOf(read);
    let quote = process.env.QUARTZ_STANDIN_QUOTE || '';
    if (!quote || text.indexOf(quote) === -1) {
      const body = text.split('\n').filter((l) => l.length > 30 && !/^(---|\(|Tab \d)/.test(l));
      quote = body.length ? body[0].slice(0, 40).trim() : '';
    }
    log({ mcp: 'quote', quote });
    if (quote) await step('highlight', 'tools/call', { name: 'highlight', arguments: { tabId, quote } });
    const word = title.split(/[^A-Za-z0-9]+/).sort((a, b) => b.length - a.length)[0] || 'page';
    log({ mcp: 'word', word });
    await step('search_history', 'tools/call', { name: 'search_history', arguments: { query: word } });
    // The same tab again: the test answers this one with Deny.
    await step('read_page_2', 'tools/call', { name: 'read_page', arguments: { tabId } });
    log({ mcp: 'finished' });
  }
}
