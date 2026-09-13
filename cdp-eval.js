// Dev helper: evaluate one JS expression inside the running test instance
// (the one launched by smoketest.js --keep, on debugging port 9222).
//   node cdp-eval.js "document.title"
const WebSocket = require('ws');

// CDP_PORT picks a test instance on another port (never point this at 9222
// while smoketest.js owns it, and never at the live browser).
const PORT = Number(process.env.CDP_PORT) || 9222;
// --guest evaluates inside the new-tab page (the <webview> guest) instead of
// the chrome document.
const args = process.argv.slice(2);
const guest = args[0] === '--guest';
const expr = (guest ? args.slice(1) : args).join(' ');
if (!expr) { console.error('usage: node cdp-eval.js [--guest] "<expression>"'); process.exit(2); }

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = guest
    ? targets.find((t) => String(t.url).includes('newtab.html'))
    : targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) { console.error('no ' + (guest ? 'new-tab guest' : 'chrome page') + ' target on port ' + PORT); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  const result = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === 1) msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => reject(new Error('timeout')), 15000);
  });

  if (result.exceptionDetails) console.log('EXCEPTION: ' + (result.exceptionDetails.text || 'eval threw'));
  else console.log(JSON.stringify(result.result.value));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
