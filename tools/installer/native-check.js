'use strict';
/*
 * tools/installer/native-check.js -- the installed copy's native modules, loaded by its own runtime.
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<install>\Quartz.exe" tools\installer\native-check.js "<install>\resources\app" <out.json>
 *
 * Run by install-test.js with the INSTALLED Quartz.exe as Node (same Electron, same Node-API), so
 * this proves the binaries that shipped load from where they were installed:
 *   - node-pty: a real ConPTY session runs `echo quartz-%OS%-ok` in cmd.exe. The typed command
 *     echoes the literal %OS%; only cmd's own output says quartz-Windows_NT-ok.
 *   - koffi: kernel32!GetCurrentProcessId answers this process's pid.
 * Writes { electron, node, modules, pty: {ok, why}, koffi: {ok, why} } to out.json.
 */
const fs = require('fs');
const path = require('path');

const appDir = process.argv[2];
const out = process.argv[3];
const result = { electron: process.versions.electron || '', node: process.versions.node, modules: process.versions.modules, pty: { ok: false, why: '' }, koffi: { ok: false, why: '' } };

function write() { fs.writeFileSync(out, JSON.stringify(result, null, 2)); }
function why(e) { return String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300); }

try {
  const koffi = require(path.join(appDir, 'node_modules', 'koffi'));
  const k32 = koffi.load('kernel32.dll');
  const pidFn = k32.func('uint32_t __stdcall GetCurrentProcessId(void)');
  const pid = pidFn();
  result.koffi = pid === process.pid ? { ok: true, why: 'GetCurrentProcessId = ' + pid } : { ok: false, why: 'GetCurrentProcessId said ' + pid + ', this process is ' + process.pid };
} catch (e) {
  result.koffi = { ok: false, why: why(e) };
}

let pty;
try {
  pty = require(path.join(appDir, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'));
} catch (e) {
  result.pty = { ok: false, why: 'require failed: ' + why(e) };
  write();
  process.exit(0);
}

let text = '';
let done = false;
let term = null;
function finish(r) {
  if (done) return;
  done = true;
  result.pty = r;
  try { if (term) term.kill(); } catch { /* already gone */ }
  write();
  setTimeout(() => process.exit(0), 500);
}
try {
  term = pty.spawn('cmd.exe', ['/d', '/q'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.env.SystemRoot || 'C:\\Windows', env: process.env, useConpty: true });
  term.onData((d) => {
    text += d;
    if (/quartz-Windows_NT-ok/.test(text)) finish({ ok: true, why: 'ConPTY ran cmd.exe (pid ' + term.pid + ') and its output came back' });
  });
  term.onExit((e) => finish({ ok: /quartz-Windows_NT-ok/.test(text), why: 'cmd.exe exited (' + JSON.stringify(e) + ') before its output arrived; got: ' + JSON.stringify(text.slice(-200)) }));
  setTimeout(() => term.write('echo quartz-%OS%-ok\r'), 800);
  setTimeout(() => finish({ ok: false, why: 'no output in 20 s; got: ' + JSON.stringify(text.slice(-200)) }), 20000);
} catch (e) {
  finish({ ok: false, why: 'spawn failed: ' + why(e) });
}
