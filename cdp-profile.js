// Dev helper: CPU-profile the running test instance for N seconds and print
// the hottest functions by self time.
//   node cdp-profile.js [--guest] [seconds]
const WebSocket = require('ws');

const PORT = 9222;
const args = process.argv.slice(2);
const guest = args[0] === '--guest';
const seconds = Number((guest ? args[1] : args[0]) || 4);

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = guest
    ? targets.find((t) => String(t.url).includes('newtab.html'))
    : targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) { console.error('no target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const my = ++id; pending.set(my, resolve);
    ws.send(JSON.stringify({ id: my, method, params }));
  });

  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 500 });
  await send('Profiler.start');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { result } = await send('Profiler.stop');
  const prof = result.profile;

  const total = prof.nodes.reduce((s, n) => s + (n.hitCount || 0), 0) || 1;
  const rows = prof.nodes
    .filter((n) => n.hitCount)
    .map((n) => ({
      hits: n.hitCount,
      name: n.callFrame.functionName || '(anonymous)',
      where: (n.callFrame.url || '').split('/').pop() + ':' + (n.callFrame.lineNumber + 1),
    }));
  // merge identical frames
  const merged = new Map();
  for (const r of rows) {
    const k = r.name + ' ' + r.where;
    merged.set(k, (merged.get(k) || 0) + r.hits);
  }
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  console.log(`samples: ${total} over ${seconds}s (${guest ? 'guest' : 'chrome'} target)`);
  for (const [k, hits] of top) {
    console.log(`${String((hits / total * 100).toFixed(1)).padStart(5)}%  ${k}`);
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
