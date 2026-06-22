/**
 * Shared Kronos forecast computation — single source of truth.
 *
 * Before this module existed, the same ~60-line timeframe→resolution mapping
 * + candle scaling logic was duplicated across three components
 * (MarketStructureView, DayTradingView, KronosForecastView). The three copies
 * had drifted slightly (one supported a futures/ETF display multiplier, one
 * computed extra chart fields) but the core was identical.
 *
 * @module lib/kronos
 */

import {
  KronosForecastItem,
  KronosResolutionForecast,
  KronosPredictedCandle,
} from '../types';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type KronosTimeframe =
  | '15m' | '30m' | '1h' | '2h' | '4h' | 'EOD' | '2D' | '3D' | '1W';

export const KRONOS_TIMEFRAMES: { key: KronosTimeframe; label: string }[] = [
  { key: '15m', label: '15m' },
  { key: '30m', label: '30m' },
  { key: '1h', label: '1h' },
  { key: '2h', label: '2h' },
  { key: '4h', label: '4h' },
  { key: 'EOD', label: 'EOD (1 G)' },
  { key: '2D', label: '2 Giorni' },
  { key: '3D', label: '3 Giorni' },
  { key: '1W', label: '1 Settimana' },
];

/**
 * A Kronos candle scaled for display (includes derived chart fields).
 *
 * The raw candle fields are scaled by `scaleRatio` (intraday alignment to
 * live spot) and optionally by `multiplier` (ETF→futures conversion). The
 * extra fields (`changePct`, `formattedTime`, `label`, `rawVolume`) are
 * pre-computed for the chart tooltip/axis.
 */
export interface ScaledKronosCandle extends KronosPredictedCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  changePct: number;
  formattedTime: string;
  label: string;
  rawVolume: number;
}

export interface ActiveKronosForecast {
  /** Reference price (= live ETF spot for intraday, model price for multiday), already multiplied. */
  lastPrice: number;
  targetPrice: number;
  expectedHigh: number;
  expectedLow: number;
  volatilityPct: number;
  trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Signed expected move from lastPrice to targetPrice, in %. */
  strengthPct: number;
  candles: ScaledKronosCandle[];
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Maps a UI timeframe to the raw model resolution + number of candles to show.
 *
 *   '15m' → forecast_5m,  3 candles  (3 × 5m)
 *   '30m' → forecast_5m,  6 candles  (6 × 5m)
 *   '1h'  → forecast_15m, 4 candles  (4 × 15m)
 *   '2h'  → forecast_15m, 8 candles  (8 × 15m)
 *   '4h'  → forecast_1h,  4 candles  (4 × 1h)
 *   'EOD' → forecast_1h,  7 candles  (7 × 1h ≈ 7h to session close)
 *   '2D'  → forecast_4h,  4 candles  (4 × 4h = 16h)
 *   '3D'  → forecast_4h,  6 candles  (6 × 4h = 24h)
 *   '1W'  → forecast_1d,  5 candles  (5 × 1d)
 */
export function kronosTimeframeResolution(tf: KronosTimeframe): {
  resolution: keyof Pick<KronosForecastItem, 'forecast_5m' | 'forecast_15m' | 'forecast_1h' | 'forecast_4h' | 'forecast_1d'>;
  candleCount: number;
  /** True for multiday forecasts (4h/1d candles): scaleRatio locked to 1.0 to avoid sub-second jitter. */
  isStable: boolean;
} {
  switch (tf) {
    case '15m': return { resolution: 'forecast_5m',  candleCount: 3, isStable: false };
    case '30m': return { resolution: 'forecast_5m',  candleCount: 6, isStable: false };
    case '1h':  return { resolution: 'forecast_15m', candleCount: 4, isStable: false };
    case '2h':  return { resolution: 'forecast_15m', candleCount: 8, isStable: false };
    case '4h':  return { resolution: 'forecast_1h',  candleCount: 4, isStable: true };
    case 'EOD': return { resolution: 'forecast_1h',  candleCount: 7, isStable: true };
    case '2D':  return { resolution: 'forecast_4h',  candleCount: 4, isStable: true };
    case '3D':  return { resolution: 'forecast_4h',  candleCount: 6, isStable: true };
    case '1W':  return { resolution: 'forecast_1d',  candleCount: 5, isStable: true };
  }
}

/**
 * Format the candle timestamp for the chart axis/tooltip, based on the
 * resolution band the timeframe belongs to.
 */
function formatCandleTime(
  candle: KronosPredictedCandle,
  idx: number,
  tf: KronosTimeframe,
  isStable: boolean,
): string {
  const is5m = tf === '15m' || tf === '30m';
  const is15m = tf === '1h' || tf === '2h';
  const is1h = tf === '4h' || tf === 'EOD';
  const is4h = tf === '2D' || tf === '3D';
  const isDaily = tf === '1W';

  const fallbackLabel = is5m
    ? `+${(idx + 1) * 5}m`
    : is15m
      ? `+${(idx + 1) * 15}m`
      : is1h
        ? `+${idx + 1}h`
        : is4h
          ? `+${(idx + 1) * 4}h`
          : `+${idx + 1}d`;

  try {
    const d = new Date(candle.timestamp);
    if (isDaily) {
      return d.toLocaleDateString([], { weekday: 'short', month: '2-digit', day: '2-digit' });
    }
    if (isStable) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return fallbackLabel;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface GetActiveKronosForecastOptions {
  /**
   * Display multiplier applied to all absolute prices (candles, lastPrice,
   * target, expectedHigh/Low). Defaults to 1.0 (ETF space). Pass the
   * futures/ETF ratio to render prices in futures terms.
   *
   * Percentage fields (changePct, volatilityPct, strengthPct) are invariant
   * under the multiplier.
   */
  multiplier?: number;
}

/**
 * Extract and scale the active Kronos forecast for a given timeframe.
 *
 * Pure function — depends only on its inputs. Replaces the three duplicated
 * inline implementations.
 *
 * @returns null if inputs are missing or the forecast has no candles.
 */
export function getActiveKronosForecast(
  biasItem: KronosForecastItem | null | undefined,
  etfSpot: number,
  timeframe: KronosTimeframe,
  options: GetActiveKronosForecastOptions = {},
): ActiveKronosForecast | null {
  if (!biasItem || !etfSpot || etfSpot <= 0) return null;

  const { resolution, candleCount, isStable } = kronosTimeframeResolution(timeframe);
  const multiplier = options.multiplier ?? 1.0;

  const resolutionData: KronosResolutionForecast | undefined = biasItem[resolution];

  // Fallback to legacy top-level fields if the JSON hasn't been re-written yet
  const activeData: KronosResolutionForecast = resolutionData ?? {
    last_price: biasItem.last_price ?? 0,
    expected_high: biasItem.expected_high ?? 0,
    expected_low: biasItem.expected_low ?? 0,
    predicted_volatility_pct: biasItem.predicted_volatility_pct ?? 0,
    candles: biasItem.candles ?? [],
  };

  if (!activeData?.candles || activeData.candles.length === 0) return null;

  const forecastLastPrice = activeData.last_price || etfSpot;
  // For multiday forecasts (4h/1d), keep scaleRatio at 1.0 to prevent
  // sub-second jitters; for intraday, scale dynamically to align with the
  // live ETF spot.
  const scaleRatio = isStable ? 1.0 : etfSpot / forecastLastPrice;
  const baseLastPrice = isStable ? (activeData.last_price || etfSpot) : etfSpot;
  const lastPrice = baseLastPrice * multiplier;

  const sliced = activeData.candles.slice(0, candleCount);
  if (sliced.length === 0) return null;

  const candles: ScaledKronosCandle[] = sliced.map((c, idx) => {
    const open = c.open * scaleRatio * multiplier;
    const high = c.high * scaleRatio * multiplier;
    const low = c.low * scaleRatio * multiplier;
    const close = c.close * scaleRatio * multiplier;
    const changePct = ((close - lastPrice) / lastPrice) * 100;
    return {
      ...c,
      open,
      high,
      low,
      close,
      changePct,
      formattedTime: formatCandleTime(c, idx, timeframe, isStable),
      label: formatCandleTime(c, idx, timeframe, isStable),
      rawVolume: c.volume,
    };
  });

  const targetPrice = candles[candles.length - 1]?.close ?? lastPrice;
  const expectedHigh = Math.max(lastPrice, ...candles.map(c => c.high));
  const expectedLow = Math.min(lastPrice, ...candles.map(c => c.low));
  const volatilityPct = ((expectedHigh - expectedLow) / lastPrice) * 100;
  const strengthPct = ((targetPrice - lastPrice) / lastPrice) * 100;

  let trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (strengthPct > 0.05) {
    trendBias = 'BULLISH';
  } else if (strengthPct < -0.05) {
    trendBias = 'BEARISH';
  }

  return {
    lastPrice,
    targetPrice,
    expectedHigh,
    expectedLow,
    volatilityPct,
    trendBias,
    strengthPct,
    candles,
  };
}
