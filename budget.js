'use strict';

/*
 * budget.js — the Claude Code usage readout (main process).
 *
 * SCAFFOLD: the contract below is fixed; the body is filled in by the
 * readouts lane. Until then describe() answers a visible "not built" state so
 * nothing downstream can mistake a stub for a working reading.
 *
 * SOURCE. Claude Code's statusLine hook writes one JSON per session to
 *   C:\Users\you\mission-control\data\statusline\<session>.json
 * with `receivedAt`, `cost.total_cost_usd`, `rate_limits.five_hour
 * .{used_percentage,resets_at}` and `rate_limits.seven_day.{...}` (resets_at
 * is epoch SECONDS). The newest file by mtime is the truth; a file older than
 * ten minutes is reported as stale, never silently.
 *
 * CONTRACT
 *   create({ app, ipcMain, isChromeSender, isBundledPage, send })
 *     -> { snapshot(), stop() }
 *   snapshot() -> {
 *     state: 'ok' | 'stale' | 'error' | 'unbuilt',
 *     reason: string,                       // plain words, always set when state != 'ok'
 *     at: number,                            // ms, when this snapshot was taken
 *     fiveHour: { pct: number, resetsAt: number } | null,   // resetsAt in ms
 *     week:     { pct: number, resetsAt: number } | null,
 *     todayUsd: number | null,               // sum over sessions touched today
 *     sessionsToday: number,
 *     source: { file: string, receivedAt: number, ageMs: number } | null
 *   }
 *   IPC (chrome only, gated by isChromeSender):
 *     'budget:describe' -> snapshot()
 *   Push (chrome): send('budget:update', snapshot()) on every change, 30 s poll.
 *   New-tab guests have no preload: a guest prints
 *     console.log('newtab:budget {"action":"subscribe"}')
 *   and main answers with contents.executeJavaScript('window.__applyBudget(...)')
 *   exactly the way stocks.js does for its tile.
 */

function create(options) {
  const opts = options || {};
  const ipcMain = opts.ipcMain;
  const gate = typeof opts.isChromeSender === 'function' ? opts.isChromeSender : () => false;

  function snapshot() {
    return {
      state: 'unbuilt',
      reason: 'budget.js is a scaffold: the readout has not been built yet',
      at: Date.now(),
      fiveHour: null,
      week: null,
      todayUsd: null,
      sessionsToday: 0,
      source: null
    };
  }

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('budget:describe', (event) => (gate(event) ? snapshot() : null));
  }

  return { snapshot, stop() {} };
}

module.exports = { create };
