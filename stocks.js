'use strict';

/*
 * stocks.js — live prices for the new tab page's bottom-right tile.
 *
 * WHY THIS IS A MAIN-PROCESS MODULE. Two reasons, and both of them are hard
 * requirements rather than tidiness:
 *
 *   1. The Finnhub key never leaves this process. Nothing returns it — not
 *      IPC, not the guest push, not a log line. `describe()` hands out a mask
 *      ("••••4f21") and a boolean, and that is the only shape anything else
 *      ever sees. The Settings pane can show whether a key is set and can
 *      replace it; it cannot read it back.
 *
 *   2. The new tab page is a preload-less file:// guest. It could not reach
 *      finnhub.io if it wanted to (CORS answers a file:// origin with a wall),
 *      and the websocket URL carries the key in its query string, so a page
 *      that opened it would be a page that holds the key. Every byte of
 *      network here is main's.
 *
 * THE CHANNEL. The same one the process list and the dock use, because the
 * guest has no preload and a logged line is the whole of what it can say:
 *
 *      page -> main   console.log('newtab:stocks {"action":"subscribe"}')
 *      main -> page   contents.executeJavaScript('window.__applyStocks(…)')
 *
 * app.js is not in the path at all. This module puts its own listener on
 * every <webview> guest that loads one of our bundled pages, so the tile
 * works whether or not the chrome knows it exists.
 *
 * WHAT IS PERSISTED. One JSON object in <userData>/stocks.json:
 *
 *   { enabled:    true | false,      // the Settings switch
 *     finnhubKey: '' | '<key>',      // never leaves this process
 *     symbols:    ['SPY', …],        // at most MAX_SYMBOLS, upper case
 *     selected:   'SPY' }            // which row the chart is drawing
 *
 * Read as the settings keys `stocks.enabled`, `stocks.finnhubKey`,
 * `stocks.symbols` and `stocks.selected`. They are NOT in settings.js's
 * localStorage object: that store lives in the chrome renderer, and a secret
 * in a renderer is a secret in a devtools console.
 *
 * WHERE THE NUMBERS COME FROM.
 *
 *   live      wss://ws.finnhub.io?token=KEY, one subscribe frame per symbol,
 *             trade messages {type:'trade',data:[{s,p,t,v}]}. Reconnects with
 *             backoff and resubscribes; symbols that leave the list are
 *             unsubscribed rather than filtered.
 *   snapshot  GET /api/v1/quote — {c,d,dp,h,l,o,pc,t}. The day's open, high,
 *             low and previous close come from here; the socket only moves
 *             `c` after that.
 *   history   GET /api/v1/stock/candle first, ONCE per session. Free keys
 *             have been answered 403 on that endpoint since 2023, so the 403
 *             is a documented outcome rather than a failure: the whole thing
 *             falls through to Yahoo's keyless chart JSON, which needs no key
 *             and gives the same minute closes.
 *
 * THE CALL BUDGET. The free tier is 60 REST calls a minute. `createBudget`
 * is a plain token bucket over a 60 s window and every REST call goes through
 * it — a call that cannot afford a token is skipped, not queued, because a
 * queued quote is a stale quote. Polling backs off on its own besides:
 * POLL_MS while the socket is down, SLOW_POLL_MS while it is healthy, and
 * nothing at all while the market is closed except one slow keep-alive.
 *
 * COST WHEN NOBODY IS LOOKING. Ref-counted per webContents, exactly like
 * stats.js: the page subscribes when it becomes visible and unsubscribes when
 * it hides, and with the count at zero this module holds no socket, no timer
 * and no interest in the network.
 */

const path = require('path');
const fs = require('fs');

/* --- what the tile starts with ------------------------------------------ */

/** The user trades tech and growth; the two index ETFs are the frame around it. */
const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL'];

/** A watchlist, not a screener. Also the ceiling on a polling round. */
const MAX_SYMBOLS = 8;

/* --- endpoints ----------------------------------------------------------- */

const FINNHUB_REST = 'https://finnhub.io/api/v1';
const FINNHUB_WS = 'wss://ws.finnhub.io';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/** Yahoo answers a bare fetch with 403; it wants to see a browser. */
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* --- timings ------------------------------------------------------------- */

/** The free tier's ceiling, and the window it is measured over. */
const BUDGET_CALLS = 60;
const BUDGET_WINDOW_MS = 60000;

/** No REST round may start closer together than this. The task's floor. */
const POLL_MS = 10000;
/** …and this is the spacing once the socket is carrying the prices instead. */
const SLOW_POLL_MS = 60000;
/** Market closed: one round every five minutes, only to notice a new session. */
const CLOSED_POLL_MS = 300000;

/** Trades are coalesced into at most this many pushes a second. */
const PUSH_MS = 500;

/** Socket reconnect backoff: doubles from the first to the last. */
const WS_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

/** A rejected key is not retried faster than this, and never in a loop. */
const KEY_DENIED_BACKOFF_MS = 60000;

/** A push is dropped rather than sent once the tile has this many points. */
const MAX_SERIES_POINTS = 600;

/** How many points a row's sparkline carries. */
const SPARK_POINTS = 40;

/** A network call that has not answered in this long is a failed call. */
const FETCH_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------------ */
/* Pure helpers — every one of these is what the harness exercises.          */
/* ------------------------------------------------------------------------ */

/**
 * A symbol as Finnhub spells it: upper case, letters, digits, dot and dash.
 * Anything else is not a ticker and is refused rather than cleaned, because a
 * cleaned symbol silently watches the wrong instrument.
 */
function normalizeSymbol(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s || s.length > 12) return '';
  return /^[A-Z0-9][A-Z0-9.\-]*$/.test(s) ? s : '';
}

/** The stored list, cleaned: valid, unique, capped. */
function normalizeSymbols(list) {
  const out = [];
  if (Array.isArray(list)) {
    for (const raw of list) {
      const s = normalizeSymbol(raw);
      if (!s || out.indexOf(s) >= 0) continue;
      out.push(s);
      if (out.length >= MAX_SYMBOLS) break;
    }
  }
  return out;
}

/**
 * Last four characters behind bullets — enough for the user to tell which key is
 * in there, useless to anyone reading a screenshot. A short key is all
 * bullets: showing most of a short secret is worse than showing none of it.
 */
function maskKey(key) {
  const s = String(key == null ? '' : key);
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return '••••' + s.slice(-4);
}

/**
 * US equities, in Eastern time, from a timestamp:
 *   'pre' 04:00–09:30, 'open' 09:30–16:00, 'after' 16:00–20:00, else 'closed'.
 * Weekends are closed. Holidays are NOT known here — a holiday reads 'open'
 * and simply never ticks, which is the same picture as a halted tape and not
 * worth a calendar to fix.
 */
function marketState(at) {
  const when = at instanceof Date ? at : new Date(at == null ? Date.now() : at);
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(when);
  } catch {
    return 'closed';
  }
  const get = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? hit.value : '';
  };
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return 'closed';
  let hour = Number(get('hour'));
  const minute = Number(get('minute'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'closed';
  if (hour === 24) hour = 0;                       // some ICU builds say 24:00
  const mins = hour * 60 + minute;
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'open';
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre';
  if (mins >= 16 * 60 && mins < 20 * 60) return 'after';
  return 'closed';
}

/**
 * A token bucket over a rolling window. `take()` is the whole API: true means
 * a call may go out and the token is spent, false means it may not and
 * nothing was spent. No queue, deliberately — see the header.
 */
function createBudget(limit, windowMs, now) {
  const cap = Number.isFinite(limit) ? limit : BUDGET_CALLS;
  const span = Number.isFinite(windowMs) ? windowMs : BUDGET_WINDOW_MS;
  const clock = typeof now === 'function' ? now : () => Date.now();
  /** Timestamps of the calls still inside the window, oldest first. */
  let spent = [];

  function prune(t) {
    const edge = t - span;
    let cut = 0;
    while (cut < spent.length && spent[cut] <= edge) cut += 1;
    if (cut) spent = spent.slice(cut);
  }

  return {
    take(count) {
      const want = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
      const t = clock();
      prune(t);
      if (spent.length + want > cap) return false;
      for (let i = 0; i < want; i += 1) spent.push(t);
      return true;
    },
    /** How many calls are still affordable right now. */
    left() {
      const t = clock();
      prune(t);
      return Math.max(0, cap - spent.length);
    },
    reset() { spent = []; },
  };
}

/** Reconnect delay for attempt n (0-based), flat at the last step. */
function backoffDelay(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return WS_BACKOFF_MS[Math.min(n, WS_BACKOFF_MS.length - 1)];
}

/** `newtab:stocks {json}` off a guest's console. null for every other line. */
function parseGuestLine(line) {
  const s = String(line == null ? '' : line);
  if (s.slice(0, 14) !== 'newtab:stocks ') return null;
  let body;
  try { body = JSON.parse(s.slice(14)); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const action = String(body.action || '');
  if (!action) return null;
  return {
    action,
    symbol: body.symbol === undefined ? undefined : String(body.symbol),
  };
}

/**
 * Finnhub's /quote. `c` of 0 with a `pc` of 0 is how it answers an unknown
 * ticker — a real price is never 0 — so that reads as null rather than as a
 * stock that fell to nothing.
 */
function parseQuote(json) {
  if (!json || typeof json !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const last = num(json.c);
  const prevClose = num(json.pc);
  if (last === null || (last === 0 && (prevClose === null || prevClose === 0))) return null;
  const change = num(json.d);
  const changePct = num(json.dp);
  return {
    last,
    prevClose,
    open: num(json.o),
    high: num(json.h),
    low: num(json.l),
    change: change === null && prevClose !== null ? last - prevClose : change,
    changePct: changePct === null && prevClose ? ((last - prevClose) / prevClose) * 100 : changePct,
    /* Finnhub stamps in seconds; everything above this line is milliseconds. */
    t: num(json.t) ? Math.round(num(json.t) * 1000) : null,
  };
}

/**
 * A websocket frame. Only 'trade' carries prices; 'ping' and the error frame
 * are answered as themselves so the caller can act on them, and anything else
 * is an empty batch rather than a throw.
 */
function parseSocketMessage(raw) {
  let json = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try { json = JSON.parse(String(raw)); } catch { return { type: 'junk', trades: [] }; }
  }
  if (!json || typeof json !== 'object') return { type: 'junk', trades: [] };
  const type = String(json.type || '');
  if (type !== 'trade') return { type: type || 'junk', trades: [], message: json.msg || '' };
  const trades = [];
  if (Array.isArray(json.data)) {
    for (const row of json.data) {
      if (!row || typeof row !== 'object') continue;
      const symbol = normalizeSymbol(row.s);
      const price = typeof row.p === 'number' && Number.isFinite(row.p) ? row.p : null;
      if (!symbol || price === null || price <= 0) continue;
      trades.push({
        symbol,
        price,
        t: typeof row.t === 'number' && Number.isFinite(row.t) ? row.t : Date.now(),
        volume: typeof row.v === 'number' && Number.isFinite(row.v) ? row.v : 0,
      });
    }
  }
  return { type: 'trade', trades };
}

/**
 * Finnhub's /stock/candle. `s:'no_data'` is a legitimate answer (a symbol
 * with no bars in the window), not an error, and reads as null the same way a
 * malformed body does — the caller only ever asks "did I get a series".
 */
function parseCandles(json) {
  if (!json || typeof json !== 'object') return null;
  if (String(json.s || '') !== 'ok') return null;
  const t = Array.isArray(json.t) ? json.t : null;
  const c = Array.isArray(json.c) ? json.c : null;
  if (!t || !c || !t.length || t.length !== c.length) return null;
  const out = [];
  for (let i = 0; i < t.length; i += 1) {
    const stamp = Number(t[i]);
    const close = Number(c[i]);
    if (!Number.isFinite(stamp) || !Number.isFinite(close) || close <= 0) continue;
    out.push({ t: Math.round(stamp * 1000), c: close });
  }
  return out.length ? out : null;
}

/**
 * Yahoo's keyless chart JSON — the fallback the free tier actually gets.
 * `close[]` carries nulls for minutes with no trade; those are dropped rather
 * than interpolated, so a thin pre-market draws as the gaps it really is.
 */
function parseYahooChart(json) {
  const result = json && json.chart && Array.isArray(json.chart.result)
    ? json.chart.result[0] : null;
  if (!result || typeof result !== 'object') return null;
  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators && Array.isArray(result.indicators.quote)
    ? result.indicators.quote[0] : null;
  const closes = quote && Array.isArray(quote.close) ? quote.close : [];
  const points = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const stamp = Number(stamps[i]);
    const close = Number(closes[i]);
    if (!Number.isFinite(stamp) || !Number.isFinite(close) || close <= 0) continue;
    points.push({ t: Math.round(stamp * 1000), c: close });
  }
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : {};
  const prevClose = Number.isFinite(Number(meta.chartPreviousClose))
    ? Number(meta.chartPreviousClose)
    : (Number.isFinite(Number(meta.previousClose)) ? Number(meta.previousClose) : null);
  const last = Number.isFinite(Number(meta.regularMarketPrice))
    ? Number(meta.regularMarketPrice)
    : (points.length ? points[points.length - 1].c : null);
  if (!points.length && last === null) return null;
  return { points, prevClose, last };
}

/**
 * Is this HTTP answer the key being refused, rather than the network failing?
 * 401 and 403 both mean it, and Finnhub says 403 with a body about access for
 * an endpoint a free key may not have — which is the candle endpoint, and is
 * NOT a bad key. The caller separates those two by which call it was.
 */
function isKeyRejection(status) {
  return status === 401 || status === 403;
}

/** The last `n` closes of a series, for a row's sparkline. */
function sparkOf(points, n) {
  const want = Number.isFinite(n) && n > 0 ? n : SPARK_POINTS;
  if (!Array.isArray(points) || !points.length) return [];
  const start = Math.max(0, points.length - want);
  const out = [];
  for (let i = start; i < points.length; i += 1) out.push(points[i].c);
  return out;
}

/**
 * Push one live trade onto a stored series. A trade inside the last bar's
 * minute REPLACES it — a minute chart with one point per tick is a minute
 * chart no more — and the series is trimmed from the front at the cap.
 */
function extendSeries(points, price, at, bucketMs) {
  const list = Array.isArray(points) ? points : [];
  const span = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : 60000;
  const stamp = Number.isFinite(at) ? at : Date.now();
  const bucket = Math.floor(stamp / span) * span;
  const last = list.length ? list[list.length - 1] : null;
  if (last && Math.floor(last.t / span) * span === bucket) {
    list[list.length - 1] = { t: last.t, c: price };
  } else {
    list.push({ t: bucket, c: price });
  }
  return list.length > MAX_SERIES_POINTS ? list.slice(list.length - MAX_SERIES_POINTS) : list;
}

/* ------------------------------------------------------------------------ */
/* The module                                                                */
/* ------------------------------------------------------------------------ */

/**
 * deps:
 *   app            electron's app, for userData. Required for persistence;
 *                  without it the store is in-memory and says so.
 *   ipcMain        wires the four `stocks:*` channels the Settings pane uses.
 *   isChromeSender (event) => bool — main's own gate; nothing else may call.
 *   isBundledPage  (url) => bool — which guests get a listener.
 *   netFetch       injected fetch, for the harness.
 *   openSocket     injected websocket factory, for the harness.
 *   setTimer/clearTimer/now — injected clocks, for the harness.
 */
function create(deps) {
  const d = deps || {};
  const electronApp = d.app || null;
  const setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const now = d.now || (() => Date.now());
  const isBundledPage = typeof d.isBundledPage === 'function' ? d.isBundledPage : () => false;
  /* Quiet by default. --stocks-log turns it on, and NOTHING it prints may
     contain the key: every call site below passes a URL that has already had
     its token stripped, or no URL at all. */
  const log = d.log || ((...parts) => {
    if (process.argv.includes('--stocks-log')) console.warn('[stocks]', ...parts);
  });

  const budget = createBudget(BUDGET_CALLS, BUDGET_WINDOW_MS, now);

  /* --- the store ------------------------------------------------------- */

  let store = {
    enabled: true,
    finnhubKey: '',
    symbols: DEFAULT_SYMBOLS.slice(),
    selected: DEFAULT_SYMBOLS[0],
  };
  let storeLoaded = false;

  function storePath() {
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return path.join(electronApp.getPath('userData'), 'stocks.json'); } catch { return ''; }
  }

  function loadStore() {
    if (storeLoaded) return store;
    storeLoaded = true;
    const file = storePath();
    if (!file) return store;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return store; }
    let json;
    try { json = JSON.parse(raw); } catch { return store; }
    if (!json || typeof json !== 'object') return store;
    if (typeof json.enabled === 'boolean') store.enabled = json.enabled;
    if (typeof json.finnhubKey === 'string') store.finnhubKey = json.finnhubKey.trim();
    const symbols = normalizeSymbols(json.symbols);
    if (symbols.length) store.symbols = symbols;
    const selected = normalizeSymbol(json.selected);
    if (selected && store.symbols.indexOf(selected) >= 0) store.selected = selected;
    else store.selected = store.symbols[0] || '';
    return store;
  }

  function saveStore() {
    const file = storePath();
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify({
        enabled: store.enabled,
        finnhubKey: store.finnhubKey,
        symbols: store.symbols,
        selected: store.selected,
      }, null, 2), 'utf8');
    } catch (err) {
      log('store write failed:', (err && err.code) || 'unknown');
    }
  }

  /* --- live state ------------------------------------------------------ */

  /** symbol -> { last, prevClose, open, high, low, change, changePct, t } */
  const quotes = new Map();
  /** symbol -> [{ t, c }] — the day, minute by minute. */
  const series = new Map();
  /** symbol -> true once its history has been fetched this session. */
  const historyDone = new Set();

  /** webContents id -> { contents, count } — the whole on/off switch. */
  const subscribers = new Map();

  /** 'idle' | 'connecting' | 'live' | 'down' */
  let socketState = 'idle';
  let socket = null;
  let socketAttempt = 0;
  let socketTimer = null;
  /** What the socket believes it is subscribed to, so a change is a delta. */
  let socketSymbols = [];

  let pollTimer = null;
  let pushTimer = null;
  let lastPushAt = 0;
  /** symbol -> true: quotes that changed since the last push. */
  let dirty = new Set();

  /** '' | 'rejected' — a key Finnhub refused. Cleared when the key changes. */
  let keyState = '';
  let keyDeniedAt = 0;
  /**
   * Which history path this key gets. 'unknown' until the first candle call,
   * then 'finnhub' or 'yahoo' — reported, because it is the one thing about a
   * free key that cannot be known without trying it.
   */
  let historyPath = 'unknown';
  /** The last time any price moved, for the tile's "as of" line. */
  let lastTickAt = 0;
  /** Set while the machine (or the endpoint) is unreachable. */
  let offline = false;

  function hasKey() { return !!store.finnhubKey; }

  function symbols() { return store.symbols.slice(); }

  /* --- network --------------------------------------------------------- */

  /**
   * One JSON GET, through the budget, with the timeout the free tier needs to
   * not wedge a poll round. Resolves { ok, status, json } — it never throws,
   * because every caller's failure path is the same: leave the last value up
   * and mark it stale.
   *
   * `label` is what gets logged. The URL never is: it carries the token.
   */
  async function getJson(url, label, headers) {
    const fetchFn = d.netFetch || defaultFetch();
    if (!fetchFn) return { ok: false, status: 0, json: null, reason: 'no-fetch' };
    if (!budget.take(1)) return { ok: false, status: 0, json: null, reason: 'budget' };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimer(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetchFn(url, {
        signal: controller ? controller.signal : undefined,
        headers: headers || undefined,
      });
      if (timer) clearTimer(timer);
      offline = false;
      if (!res || !res.ok) {
        const status = res ? res.status : 0;
        log(label, 'http', status);
        return { ok: false, status, json: null, reason: 'http' };
      }
      let json = null;
      try { json = await res.json(); } catch { return { ok: false, status: res.status, json: null, reason: 'body' }; }
      return { ok: true, status: res.status, json };
    } catch (err) {
      if (timer) clearTimer(timer);
      offline = true;
      log(label, 'failed:', (err && err.name) || 'error');
      return { ok: false, status: 0, json: null, reason: 'network' };
    }
  }

  /** Electron's net.fetch where it exists (proxy-aware), else Node's. */
  function defaultFetch() {
    try {
      const { net } = require('electron');
      if (net && typeof net.fetch === 'function') return (u, o) => net.fetch(u, o);
    } catch { /* not in electron: the harness */ }
    return typeof fetch === 'function' ? fetch : null;
  }

  function markKeyRejected() {
    keyState = 'rejected';
    keyDeniedAt = now();
    stopSocket();
    stopPolling();
    pushNow();
  }

  /** True while a rejected key is inside its backoff and must not be retried. */
  function keyInBackoff() {
    return keyState === 'rejected' && (now() - keyDeniedAt) < KEY_DENIED_BACKOFF_MS;
  }

  /* --- REST: the day's numbers ---------------------------------------- */

  async function fetchQuote(symbol) {
    const url = `${FINNHUB_REST}/quote?symbol=${encodeURIComponent(symbol)}` +
      `&token=${encodeURIComponent(store.finnhubKey)}`;
    const res = await getJson(url, 'quote ' + symbol);
    if (!res.ok) {
      /* A refused key on /quote is the key itself: every free key may quote. */
      if (isKeyRejection(res.status)) markKeyRejected();
      return false;
    }
    const quote = parseQuote(res.json);
    if (!quote) return false;
    const prev = quotes.get(symbol) || {};
    quotes.set(symbol, Object.assign({}, prev, quote, { stale: false }));
    if (quote.t) lastTickAt = Math.max(lastTickAt, quote.t);
    dirty.add(symbol);
    return true;
  }

  /**
   * The day's minute closes. Finnhub first, once, because a paid key should
   * get the better series; Yahoo for everyone else. Which one answered is
   * remembered in `historyPath` and reported — that is the only way to know
   * what a given key allows.
   */
  async function fetchHistory(symbol) {
    if (historyDone.has(symbol)) return;
    historyDone.add(symbol);

    if (historyPath !== 'yahoo') {
      const to = Math.floor(now() / 1000);
      const from = to - 60 * 60 * 24;            // a day back: enough for 1-minute
      const url = `${FINNHUB_REST}/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=1&from=${from}&to=${to}&token=${encodeURIComponent(store.finnhubKey)}`;
      const res = await getJson(url, 'candle ' + symbol);
      if (res.ok) {
        const points = parseCandles(res.json);
        if (points) {
          historyPath = 'finnhub';
          series.set(symbol, points);
          dirty.add(symbol);
          return;
        }
        /* 200 with no_data: the endpoint works, this symbol has no bars. */
        historyPath = 'finnhub';
      } else if (isKeyRejection(res.status)) {
        /* THE documented free-tier outcome. Not a bad key — /quote proves the
           key — so it moves the history path over and says nothing else. */
        historyPath = 'yahoo';
        log('candle denied (' + res.status + '): free tier, using yahoo');
      }
    }

    await fetchYahoo(symbol);
  }

  async function fetchYahoo(symbol) {
    const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}` +
      '?interval=1m&range=1d&includePrePost=true';
    const res = await getJson(url, 'yahoo ' + symbol, {
      'User-Agent': YAHOO_UA,
      Accept: 'application/json',
    });
    if (!res.ok) return;
    const chart = parseYahooChart(res.json);
    if (!chart) return;
    if (historyPath === 'unknown') historyPath = 'yahoo';
    if (chart.points.length) {
      series.set(symbol, chart.points.slice(-MAX_SERIES_POINTS));
      dirty.add(symbol);
    }
    /* Yahoo also carries the previous close, which is what the dashed line on
       the chart is — worth taking when Finnhub has not answered yet. */
    const prev = quotes.get(symbol);
    if (chart.prevClose && (!prev || prev.prevClose == null)) {
      quotes.set(symbol, Object.assign({}, prev || {}, { prevClose: chart.prevClose }));
      dirty.add(symbol);
    }
  }

  /** One round: every symbol's quote, plus history for anything missing it. */
  async function pollRound() {
    if (!hasKey() || keyInBackoff() || !subscribers.size) return;
    const list = symbols();
    /* Never start a round the budget cannot finish: a half round leaves half
       the tile stale, which looks like a bug rather than like a limit. */
    if (budget.left() < list.length) {
      log('round skipped: budget', budget.left(), 'of', list.length);
      return;
    }
    for (const symbol of list) {
      await fetchQuote(symbol);
      if (keyState === 'rejected') return;
    }
    for (const symbol of list) {
      if (!historyDone.has(symbol)) await fetchHistory(symbol);
      if (keyState === 'rejected') return;
    }
    schedulePush();
  }

  function pollDelay() {
    const state = marketState(now());
    if (state === 'closed') return CLOSED_POLL_MS;
    return socketState === 'live' ? SLOW_POLL_MS : POLL_MS;
  }

  function startPolling() {
    if (pollTimer || !subscribers.size || !hasKey()) return;
    const tick = () => {
      pollTimer = null;
      Promise.resolve(pollRound()).catch(() => {}).then(() => {
        if (subscribers.size && hasKey() && !keyInBackoff()) {
          pollTimer = setTimer(tick, pollDelay());
        } else if (subscribers.size && hasKey()) {
          /* A rejected key still gets one retry, a minute out, and then that
             retry's answer decides again. This is the "no retry storm" rule. */
          pollTimer = setTimer(tick, KEY_DENIED_BACKOFF_MS);
        }
      });
    };
    pollTimer = setTimer(tick, 0);
  }

  function stopPolling() {
    if (pollTimer) { clearTimer(pollTimer); pollTimer = null; }
  }

  /* --- the websocket --------------------------------------------------- */

  /**
   * Electron's main process has no DOM WebSocket, but Node 22 (which is what
   * Electron 44 carries) has a global one, and `ws` is in the tree besides.
   * Either will do; neither being there is a fallback to REST polling, which
   * is exactly what a down socket already is.
   */
  function openSocket(url) {
    if (typeof d.openSocket === 'function') return d.openSocket(url);
    if (typeof WebSocket === 'function') return new WebSocket(url);
    try {
      const WS = require('ws');
      return new WS(url, { perMessageDeflate: false });
    } catch {
      return null;
    }
  }

  function sendFrame(obj) {
    if (!socket || socketState !== 'live') return false;
    try { socket.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function startSocket() {
    if (socket || socketTimer || !hasKey() || keyInBackoff() || !subscribers.size) return;
    const url = `${FINNHUB_WS}?token=${encodeURIComponent(store.finnhubKey)}`;
    let ws;
    try { ws = openSocket(url); } catch { ws = null; }
    if (!ws) { socketState = 'down'; return; }
    socket = ws;
    socketState = 'connecting';
    socketSymbols = [];

    /* Both shapes: `ws` is an EventEmitter, the global is an EventTarget. */
    const on = (name, fn) => {
      if (typeof ws.on === 'function') ws.on(name, fn);
      else ws['on' + name] = fn;
    };

    on('open', () => {
      socketState = 'live';
      socketAttempt = 0;
      syncSocketSymbols();
      schedulePush();
    });
    on('message', (ev) => {
      const raw = ev && ev.data !== undefined ? ev.data : ev;
      takeSocketMessage(raw);
    });
    on('error', () => { /* 'close' always follows; the reconnect lives there */ });
    on('close', () => {
      socket = null;
      /* Finnhub closes the socket outright on a bad token, so a connection
         that never reached 'live' and keeps closing is a key problem. */
      const neverOpened = socketState === 'connecting';
      socketState = 'down';
      socketSymbols = [];
      if (neverOpened) socketAttempt += 1;
      if (subscribers.size && hasKey() && !keyInBackoff()) scheduleReconnect();
      schedulePush();
    });
  }

  function scheduleReconnect() {
    if (socketTimer) return;
    const wait = backoffDelay(socketAttempt);
    socketAttempt += 1;
    socketTimer = setTimer(() => {
      socketTimer = null;
      startSocket();
    }, wait);
  }

  function stopSocket() {
    if (socketTimer) { clearTimer(socketTimer); socketTimer = null; }
    if (socket) {
      try { socket.close(); } catch { /* already gone */ }
      socket = null;
    }
    socketState = 'idle';
    socketSymbols = [];
    socketAttempt = 0;
  }

  /** Subscribe what is new, unsubscribe what left. A delta, never a resubscribe. */
  function syncSocketSymbols() {
    if (socketState !== 'live') return;
    const want = symbols();
    for (const symbol of want) {
      if (socketSymbols.indexOf(symbol) >= 0) continue;
      if (sendFrame({ type: 'subscribe', symbol })) socketSymbols.push(symbol);
    }
    for (const symbol of socketSymbols.slice()) {
      if (want.indexOf(symbol) >= 0) continue;
      sendFrame({ type: 'unsubscribe', symbol });
      socketSymbols = socketSymbols.filter((s) => s !== symbol);
    }
  }

  function takeSocketMessage(raw) {
    const msg = parseSocketMessage(raw);
    if (msg.type === 'ping') return;
    if (msg.type === 'error') {
      log('socket error frame');
      return;
    }
    if (!msg.trades.length) return;
    const live = symbols();
    for (const trade of msg.trades) {
      if (live.indexOf(trade.symbol) < 0) continue;
      const prev = quotes.get(trade.symbol) || {};
      const prevClose = prev.prevClose == null ? null : prev.prevClose;
      quotes.set(trade.symbol, Object.assign({}, prev, {
        last: trade.price,
        change: prevClose == null ? prev.change : trade.price - prevClose,
        changePct: prevClose ? ((trade.price - prevClose) / prevClose) * 100 : prev.changePct,
        t: trade.t,
        stale: false,
      }));
      series.set(trade.symbol, extendSeries(series.get(trade.symbol) || [], trade.price, trade.t));
      lastTickAt = Math.max(lastTickAt, trade.t);
      dirty.add(trade.symbol);
    }
    schedulePush();
  }

  /* --- what the page is told ------------------------------------------- */

  /**
   * The tile's whole world, as one object. The key is not in it, and cannot
   * be: `hasKey` is a boolean and `keyMask` is bullets.
   */
  function snapshot() {
    const list = symbols();
    const rows = list.map((symbol) => {
      const q = quotes.get(symbol) || {};
      return {
        symbol,
        last: q.last == null ? null : q.last,
        change: q.change == null ? null : q.change,
        changePct: q.changePct == null ? null : q.changePct,
        prevClose: q.prevClose == null ? null : q.prevClose,
        t: q.t || null,
        spark: sparkOf(series.get(symbol), SPARK_POINTS),
      };
    });
    const selected = list.indexOf(store.selected) >= 0 ? store.selected : (list[0] || '');
    const points = series.get(selected) || [];
    const sel = quotes.get(selected) || {};
    return {
      enabled: store.enabled !== false,
      hasKey: hasKey(),
      keyState,
      market: marketState(now()),
      socket: socketState,
      offline,
      historyPath,
      lastTickAt: lastTickAt || null,
      selected,
      rows,
      series: {
        symbol: selected,
        prevClose: sel.prevClose == null ? null : sel.prevClose,
        points: points.map((p) => [p.t, p.c]),
      },
    };
  }

  /** The masked shape the Settings pane and the IPC gate hand out. */
  function describe() {
    loadStore();
    return {
      enabled: store.enabled !== false,
      hasKey: hasKey(),
      keyMask: maskKey(store.finnhubKey),
      keyState,
      symbols: symbols(),
      selected: store.selected,
      historyPath,
      market: marketState(now()),
      socket: socketState,
    };
  }

  function pushTo(contents, payload) {
    if (!contents || contents.isDestroyed()) return;
    let json;
    try { json = JSON.stringify(payload); } catch { return; }
    /* JSON is not quite a JS literal: U+2028/9 are line terminators in source
       but legal inside a JSON string, and this string becomes source. */
    const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const code = 'window.__applyStocks && window.__applyStocks(' + safe + ')';
    try {
      const answer = contents.executeJavaScript(code, true);
      if (answer && typeof answer.catch === 'function') answer.catch(() => {});
    } catch { /* the guest navigated away mid-push */ }
  }

  function pushNow() {
    if (!subscribers.size) return;
    lastPushAt = now();
    dirty = new Set();
    const payload = snapshot();
    for (const rec of subscribers.values()) pushTo(rec.contents, payload);
  }

  /**
   * At most one push every PUSH_MS. Trades arrive in bursts of dozens a
   * second on a busy open; the tile is a readout, not a tape.
   */
  function schedulePush() {
    if (pushTimer || !subscribers.size) return;
    const since = now() - lastPushAt;
    if (since >= PUSH_MS) { pushNow(); return; }
    pushTimer = setTimer(() => { pushTimer = null; pushNow(); }, PUSH_MS - since);
  }

  /* --- the guest channel ----------------------------------------------- */

  function subscribe(contents) {
    if (!contents || contents.isDestroyed()) return;
    const id = contents.id;
    const rec = subscribers.get(id);
    if (rec) rec.count += 1;
    else {
      subscribers.set(id, { contents, count: 1 });
      contents.once('destroyed', () => drop(id));
    }
    loadStore();
    if (store.enabled === false) { pushTo(contents, snapshot()); return; }
    if (hasKey()) { startSocket(); startPolling(); }
    pushTo(contents, snapshot());
  }

  function unsubscribe(contents) {
    if (!contents) return;
    drop(contents.id, true);
  }

  function drop(id, oneOnly) {
    const rec = subscribers.get(id);
    if (!rec) return;
    if (oneOnly) rec.count -= 1;
    else rec.count = 0;
    if (rec.count > 0) return;
    subscribers.delete(id);
    if (!subscribers.size) idle();
  }

  /** Nobody is looking: no socket, no timers, no network. */
  function idle() {
    stopSocket();
    stopPolling();
    if (pushTimer) { clearTimer(pushTimer); pushTimer = null; }
  }

  /** One `newtab:stocks` line from a guest. Returns true if it was ours. */
  function handleGuestLine(contents, line) {
    const msg = parseGuestLine(line);
    if (!msg) return false;
    loadStore();
    switch (msg.action) {
      case 'subscribe':
        subscribe(contents);
        return true;
      case 'unsubscribe':
        unsubscribe(contents);
        return true;
      case 'select': {
        const symbol = normalizeSymbol(msg.symbol);
        if (symbol && store.symbols.indexOf(symbol) >= 0) {
          store.selected = symbol;
          saveStore();
          if (!series.has(symbol)) {
            historyDone.delete(symbol);
            Promise.resolve(fetchHistory(symbol)).catch(() => {}).then(schedulePush);
          }
        }
        pushNow();
        return true;
      }
      case 'add': {
        const symbol = normalizeSymbol(msg.symbol);
        if (symbol && store.symbols.indexOf(symbol) < 0 && store.symbols.length < MAX_SYMBOLS) {
          store.symbols.push(symbol);
          store.selected = symbol;
          saveStore();
          syncSocketSymbols();
          if (hasKey() && !keyInBackoff()) {
            Promise.resolve(fetchQuote(symbol))
              .then(() => fetchHistory(symbol))
              .catch(() => {})
              .then(schedulePush);
          }
        }
        pushNow();
        return true;
      }
      case 'remove': {
        const symbol = normalizeSymbol(msg.symbol);
        const at = symbol ? store.symbols.indexOf(symbol) : -1;
        if (at >= 0) {
          store.symbols.splice(at, 1);
          quotes.delete(symbol);
          series.delete(symbol);
          historyDone.delete(symbol);
          if (store.selected === symbol) store.selected = store.symbols[0] || '';
          saveStore();
          syncSocketSymbols();
        }
        pushNow();
        return true;
      }
      case 'refresh':
        historyDone.clear();
        if (hasKey()) {
          keyState = '';
          startSocket();
          stopPolling();
          startPolling();
        }
        pushNow();
        return true;
      default:
        return false;
    }
  }

  /**
   * Electron has changed this event's shape: ≥36 emits one details object,
   * older builds emit (event, level, message, …). Both are read, so the
   * module does not break on an Electron bump in either direction.
   */
  function messageOf(first, args) {
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    /* The pre-36 shape: (event, level, message, line, sourceId). Read off
       `arguments` rather than as declared parameters, because Electron 44
       deprecation-warns on any console-message listener with more than one. */
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string') return args[1];
    return '';
  }

  /**
   * Put a listener on one guest. Called for every <webview> main creates; the
   * URL test is done per MESSAGE rather than once here, because a guest is
   * created before it has navigated anywhere.
   */
  function watchGuest(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('console-message', function (details) {
      let url = '';
      try { url = contents.getURL(); } catch { url = ''; }
      if (!isBundledPage(url)) return;
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('guest line failed:', (err && err.message) || 'error');
      }
    });
  }

  /* --- the Settings pane's side ---------------------------------------- */

  function setKey(raw) {
    loadStore();
    const next = String(raw == null ? '' : raw).trim();
    if (next === store.finnhubKey) return describe();
    store.finnhubKey = next;
    keyState = '';
    keyDeniedAt = 0;
    historyPath = 'unknown';
    historyDone.clear();
    quotes.clear();
    series.clear();
    saveStore();
    stopSocket();
    stopPolling();
    if (subscribers.size && store.enabled !== false && next) { startSocket(); startPolling(); }
    pushNow();
    return describe();
  }

  function setEnabled(on) {
    loadStore();
    const next = on !== false;
    if (next === (store.enabled !== false)) return describe();
    store.enabled = next;
    saveStore();
    if (!next) idle();
    else if (subscribers.size && hasKey()) { startSocket(); startPolling(); }
    pushNow();
    return describe();
  }

  function setSymbols(list) {
    loadStore();
    const next = normalizeSymbols(list);
    if (!next.length) return describe();
    store.symbols = next;
    if (next.indexOf(store.selected) < 0) store.selected = next[0];
    saveStore();
    syncSocketSymbols();
    pushNow();
    return describe();
  }

  /**
   * The four channels the Settings pane uses, behind main's own chrome gate.
   * There is no channel that returns the key, by design.
   */
  function registerIpc(ipcMain, isChromeSender) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    const gate = typeof isChromeSender === 'function' ? isChromeSender : () => false;
    ipcMain.handle('stocks:describe', (event) => (gate(event) ? describe() : null));
    ipcMain.handle('stocks:set-key', (event, key) => (gate(event) ? setKey(key) : null));
    ipcMain.handle('stocks:set-enabled', (event, on) => (gate(event) ? setEnabled(on) : null));
    ipcMain.handle('stocks:set-symbols', (event, list) => (gate(event) ? setSymbols(list) : null));
  }

  /* --- wiring ---------------------------------------------------------- */

  loadStore();

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try {
        if (contents && contents.getType() === 'webview') watchGuest(contents);
      } catch { /* a guest that died between creation and here */ }
    });
  }
  if (d.ipcMain) registerIpc(d.ipcMain, d.isChromeSender);

  return {
    describe,
    snapshot,
    setKey,
    setEnabled,
    setSymbols,
    subscribe,
    unsubscribe,
    handleGuestLine,
    watchGuest,
    registerIpc,
    /* For the harness, and for a doctor line later. */
    budget,
    state: () => ({
      subscribers: subscribers.size,
      socket: socketState,
      polling: !!pollTimer,
      historyPath,
      keyState,
      budgetLeft: budget.left(),
    }),
    stop: idle,
  };
}

module.exports = {
  create,
  createBudget,
  normalizeSymbol,
  normalizeSymbols,
  maskKey,
  marketState,
  backoffDelay,
  parseGuestLine,
  parseQuote,
  parseSocketMessage,
  parseCandles,
  parseYahooChart,
  isKeyRejection,
  sparkOf,
  extendSeries,
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  BUDGET_CALLS,
  BUDGET_WINDOW_MS,
  POLL_MS,
  SLOW_POLL_MS,
  CLOSED_POLL_MS,
  PUSH_MS,
  WS_BACKOFF_MS,
  KEY_DENIED_BACKOFF_MS,
  MAX_SERIES_POINTS,
  SPARK_POINTS,
};
