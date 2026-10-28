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
//      notifications/initialized, tools/list, then tools/call list_tabs, read_page on the first listed
//      tab, highlight a phrase from that page, search_history for a word of its title. Every answer
//      is logged as {"mcp": "<step>", "res": <JSON-RPC message>};
//   4. exits when it reads "__quit__" or after 120 s, whichever is first.
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
process.stdin.on('data', (chunk) => {
  log({ in: chunk });
  seen += chunk;
  if (seen.indexOf('__quit__') !== -1) finish();
});

function finish() {
  log({ done: true });
  try { if (server) server.kill(); } catch (err) { /* gone */ }
  process.stdout.write(ESC + '[?2004l');
  process.exit(0);
}
setTimeout(finish, 120000).unref();

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
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve({ id, timeout: true }); }, 30000);
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
  log({ mcp: 'finished' });
}
