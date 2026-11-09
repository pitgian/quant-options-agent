/**
 * Spot Price Fetcher (shared)
 *
 * Single source of truth for deriving live spot prices for SPX / NDX / SPY / QQQ
 * from Yahoo Finance. Used by:
 *   - the Vite dev-server middleware (vite.config.ts)
 *   - the Vercel serverless function (api/index.ts)
 *
 * Strategy
 * --------
 * Indices (^SPX, ^NDX) are published with a ~15-minute delay on Yahoo, while
 * ETFs (SPY, QQQ) stream near real-time. Yahoo futures (ES=F, NQ=F) turn out
 * to lag ~10 minutes too (measured 2026-11: regularMarketTime 10 min behind
 * wall clock). To get a truly live index print we therefore read ES/NQ from
 * TradingView's public symbol endpoint (scanner.tradingview.com), which
 * serves near real-time CME mini futures (~6 s lag measured), and derive:
 *
 *     derived_SPX = prev_SPX × (live_ES / prev_ES)
 *     derived_NDX = prev_NDX × (live_NQ / prev_NQ)
 *
 * The scanner endpoint is unofficial: if it fails or is rate-limited we fall
 * back to Yahoo ES=F / NQ=F (delayed ~10 min but reliable). ETFs are derived
 * the same way for symmetry (so the dashboard stays coherent with the
 * futures-based regime logic), falling back to the ETF's own previous close
 * when futures are unavailable.
 *
 * @module lib/spotPrices
 */

/** Yahoo Finance symbols we query in parallel. */
const YAHOO_SYMBOLS = ['SPY', 'QQQ', 'ES=F', 'NQ=F', '^SPX', '^NDX'] as const;

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** TradingView public symbol endpoint — serves near real-time futures quotes
 *  (~6 s lag measured) where Yahoo futures run ~10 min behind. Unofficial:
 *  treat as best-effort and always keep the Yahoo fallback. */
const TRADINGVIEW_SYMBOL_URL = 'https://scanner.tradingview.com/symbol';
const TV_FUTURES: Record<'ES' | 'NQ', string> = {
  ES: 'CME_MINI:ES1!',
  NQ: 'CME_MINI:NQ1!',
};
const TV_FIELDS = 'close,change_abs,update_time';

/** Browser-like UA — Yahoo blocks requests without one. */
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Per-request timeout (ms). Keeps the whole function well under Vercel's
 *  platform timeout even when Yahoo is slow to respond. */
const FETCH_TIMEOUT_MS = 3500;

/** Short in-memory cache so repeated requests (the client polls every 30s)
 *  don't re-hit Yahoo 6x each time, reducing rate-limit / timeout risk on the
 *  Vercel serverless IP. */
const CACHE_TTL_MS = 15_000;
let _cache: { ts: number; data: SpotPrices } | null = null;

function withTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

export interface SpotPrices {
  SPX: number | null;
  NDX: number | null;
  SPY: number | null;
  QQQ: number | null;
  ES: number | null;
  NQ: number | null;
  timestamp: string;
  /** Epoch (ms) of the last ES/NQ tick reported by TradingView, when it was
   *  the source (null → ES/NQ came from Yahoo fallback or are unavailable). */
  esUpdateTime?: number | null;
  nqUpdateTime?: number | null;
}

interface Quote {
  live: number | null;
  prevClose: number | null;
  updateTime?: number | null;
}

async function fetchQuote(symbol: string): Promise<Quote> {
  // Daily candles: meta.regularMarketPrice stays real-time regardless of
  // interval, and the completed daily candles give a reliable previous close.
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=6d`;

  try {
    const response = await withTimeout(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as any;
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    const times: number[] = result?.timestamp || [];

    // Prefer the last non-null candle, fall back to regularMarketPrice
    let lastCandlePrice: number | null = null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined) {
        lastCandlePrice = closes[i];
        break;
      }
    }

    const live = meta?.regularMarketPrice ?? lastCandlePrice;

    // Previous close = last completed daily candle (session date strictly
    // before today in the exchange timezone). meta.chartPreviousClose is NOT
    // usable: on intraday ranges it proved unreliable (it can point two
    // sessions back for indices, or to a stale intraday bar for futures).
    const tz: string = meta?.exchangeTimezoneName ?? 'America/New_York';
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const today = fmt.format(new Date());
    let prevClose: number | null = null;
    for (let i = times.length - 1; i >= 0; i--) {
      if (fmt.format(new Date(times[i] * 1000)) < today) {
        prevClose = closes[i] ?? null;
        break;
      }
    }

    return { live, prevClose };
  } catch (err) {
    console.error(`[spotPrices] Error fetching ${symbol}:`, err);
    return { live: null, prevClose: null };
  }
}

/** Fetches one continuous futures contract from TradingView's public symbol
 *  endpoint. `change_abs` is vs the previous daily close, so prevClose can be
 *  recovered as close − change_abs (null early in the session or when flat). */
async function fetchTradingViewFuture(symbol: string): Promise<Quote> {
  const url =
    `${TRADINGVIEW_SYMBOL_URL}?symbol=${encodeURIComponent(symbol)}` +
    `&fields=${TV_FIELDS}&no_404=true`;

  try {
    const response = await withTimeout(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const d = (await response.json()) as {
      close?: number;
      change_abs?: number | null;
      update_time?: number;
    };

    const live = typeof d.close === 'number' ? d.close : null;
    const prevClose =
      live !== null && typeof d.change_abs === 'number' ? live - d.change_abs : null;
    const updateTime = typeof d.update_time === 'number' ? d.update_time * 1000 : null;

    return { live, prevClose, updateTime };
  } catch (err) {
    console.error(`[spotPrices] TradingView error for ${symbol}:`, err);
    return { live: null, prevClose: null, updateTime: null };
  }
}

function round2(n: number | null): number | null {
  return n === null ? null : Number(n.toFixed(2));
}

/**
 * Fetches and derives live spot prices for the four tracked symbols.
 * Throws only on a catastrophic failure (all sources down); individual
 * symbol failures degrade gracefully to `null`.
 */
export async function fetchSpotPrices(): Promise<SpotPrices> {
  // Short in-memory cache: avoid hammering Yahoo on every poll and bound the
  // chance of hitting a slow/timeout response on the serverless IP.
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.data;
  }

  const quotes: Record<string, Quote> = {};
  await Promise.all([
    ...YAHOO_SYMBOLS.map(async (symbol) => {
      quotes[symbol] = await fetchQuote(symbol);
    }),
    ...(['ES', 'NQ'] as const).map(async (k) => {
      quotes[`TV_${k}`] = await fetchTradingViewFuture(TV_FUTURES[k]);
    }),
  ]);

  const spyPrev = quotes['SPY']?.prevClose ?? null;
  const qqqPrev = quotes['QQQ']?.prevClose ?? null;

  // Live futures: prefer TradingView (real-time, ~6 s lag), fall back to the
  // ~10-min-delayed Yahoo futures quote. Previous close: prefer the anchor
  // implied by TV's change_abs (same source as the live tick), then the
  // last-completed-daily-candle close from Yahoo.
  const esLive = quotes['TV_ES']?.live ?? quotes['ES=F']?.live ?? null;
  const esPrev = quotes['TV_ES']?.prevClose ?? quotes['ES=F']?.prevClose ?? null;
  const esTime = quotes['TV_ES']?.live != null ? quotes['TV_ES']?.updateTime ?? null : null;

  const nqLive = quotes['TV_NQ']?.live ?? quotes['NQ=F']?.live ?? null;
  const nqPrev = quotes['TV_NQ']?.prevClose ?? quotes['NQ=F']?.prevClose ?? null;
  const nqTime = quotes['TV_NQ']?.live != null ? quotes['TV_NQ']?.updateTime ?? null : null;

  const spxPrev = quotes['^SPX']?.prevClose ?? null;
  const ndxPrev = quotes['^NDX']?.prevClose ?? null;

  // Derive spot from active futures returns 24/5
  const esRatio = esLive !== null && esPrev !== null ? esLive / esPrev : 1.0;
  const nqRatio = nqLive !== null && nqPrev !== null ? nqLive / nqPrev : 1.0;

  const data: SpotPrices = {
    SPX: spxPrev !== null ? round2(spxPrev * esRatio) : null,
    NDX: ndxPrev !== null ? round2(ndxPrev * nqRatio) : null,
    SPY: spyPrev !== null ? round2(spyPrev * esRatio) : null,
    QQQ: qqqPrev !== null ? round2(qqqPrev * nqRatio) : null,
    ES: esLive,
    NQ: nqLive,
    timestamp: new Date().toISOString(),
    esUpdateTime: esTime,
    nqUpdateTime: nqTime,
  };

  // Only cache a payload that actually carries live data, so a transient
  // Yahoo outage doesn't pin nulls for 15s.
  if (data.ES !== null || data.NQ !== null) {
    _cache = { ts: Date.now(), data };
  }
  return data;
}
