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
 * ETFs (SPY, QQQ) and futures (ES=F, NQ=F) stream near real-time. To get a
 * fresh index print we derive it from the corresponding futures' intraday
 * return applied to the index's previous close:
 *
 *     derived_SPX = prev_SPX × (live_ES / prev_ES)
 *     derived_NDX = prev_NDX × (live_NQ / prev_NQ)
 *
 * ETFs are derived the same way for symmetry (so the dashboard stays coherent
 * with the futures-based regime logic), falling back to the ETF's own previous
 * close when futures are unavailable.
 *
 * @module lib/spotPrices
 */

/** Yahoo Finance symbols we query in parallel. */
const YAHOO_SYMBOLS = ['SPY', 'QQQ', 'ES=F', 'NQ=F', '^SPX', '^NDX'] as const;

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** Browser-like UA — Yahoo blocks requests without one. */
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface SpotPrices {
  SPX: number | null;
  NDX: number | null;
  SPY: number | null;
  QQQ: number | null;
  ES: number | null;
  NQ: number | null;
  timestamp: string;
}

interface Quote {
  live: number | null;
  prevClose: number | null;
}

async function fetchQuote(symbol: string): Promise<Quote> {
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(
    symbol,
  )}?interval=1m&range=5m&includePrePost=true`;

  try {
    const response = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as any;
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];

    // Prefer the last non-null intraday candle, fall back to regularMarketPrice
    let lastCandlePrice: number | null = null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined) {
        lastCandlePrice = closes[i];
        break;
      }
    }

    const live = meta?.regularMarketPrice ?? lastCandlePrice;
    const prevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? lastCandlePrice;

    return { live, prevClose };
  } catch (err) {
    console.error(`[spotPrices] Error fetching ${symbol}:`, err);
    return { live: null, prevClose: null };
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
  const quotes: Record<string, Quote> = {};
  await Promise.all(
    YAHOO_SYMBOLS.map(async (symbol) => {
      quotes[symbol] = await fetchQuote(symbol);
    }),
  );

  const spyPrev = quotes['SPY']?.prevClose ?? null;
  const qqqPrev = quotes['QQQ']?.prevClose ?? null;

  const esLive = quotes['ES=F']?.live ?? null;
  const esPrev = quotes['ES=F']?.prevClose ?? null;

  const nqLive = quotes['NQ=F']?.live ?? null;
  const nqPrev = quotes['NQ=F']?.prevClose ?? null;

  const spxPrev = quotes['^SPX']?.prevClose ?? null;
  const ndxPrev = quotes['^NDX']?.prevClose ?? null;

  // Derive spot from active futures returns 24/5
  const esRatio = esLive !== null && esPrev !== null ? esLive / esPrev : 1.0;
  const nqRatio = nqLive !== null && nqPrev !== null ? nqLive / nqPrev : 1.0;

  return {
    SPX: spxPrev !== null ? round2(spxPrev * esRatio) : null,
    NDX: ndxPrev !== null ? round2(ndxPrev * nqRatio) : null,
    SPY: spyPrev !== null ? round2(spyPrev * esRatio) : null,
    QQQ: qqqPrev !== null ? round2(qqqPrev * nqRatio) : null,
    ES: esLive,
    NQ: nqLive,
    timestamp: new Date().toISOString(),
  };
}
