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
  | '4h' | '1d';

export const KRONOS_TIMEFRAMES: { key: KronosTimeframe; label: string }[] = [
  { key: '4h', label: '4h (24 ore)' },
  { key: '1d', label: '1 Giorno (sett.)' },
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
  /** Reference price = the LIVE ETF spot (re-anchored every render), already multiplied into display space. */
  lastPrice: number;
  /** The live→forecast anchor ratio applied (liveSpot / forecastAnchor). ≈1.0 for a fresh forecast; >1/<1 realigns an ageing forecast to the current price. */
  scaleRatioUsed: number;
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
 * The UI timeframe now maps 1:1 to a Kronos resolution (no more multi-button
 * aliasing onto the same resolution). Only the two horizons the pipeline
 * generates are selectable:
 *
 *   '4h' → forecast_4h, 6 candles  (6 × 4h = 24h, session + next day)
 *   '1d' → forecast_1d, 5 candles  (5 × 1d = 1 week, primary daily bias)
 */
export function kronosTimeframeResolution(tf: KronosTimeframe): {
  resolution: keyof Pick<KronosForecastItem, 'forecast_4h' | 'forecast_1d'>;
  candleCount: number;
  /** Always true: both remaining horizons are multiday-style (stable scaleRatio). */
  isStable: boolean;
} {
  switch (tf) {
    case '4h': return { resolution: 'forecast_4h', candleCount: 6, isStable: true };
    case '1d': return { resolution: 'forecast_1d', candleCount: 5, isStable: true };
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
  const is4h = tf === '4h';
  const isDaily = tf === '1d';

  const fallbackLabel = is4h
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
  // ALWAYS re-anchor the model output to the LIVE ETF spot. The forecast's
  // own last_price is frozen at generation time; anchoring the candles/spot
  // to it makes the displayed levels drift away from the live market as the
  // forecast ages (this was the root cause of 'spot non corrisponde' / levels
  // misaligned vs the dashboard). scaleRatio = liveSpot/forecastAnchor shifts
  // the whole projected path to start from the CURRENT price — for a fresh
  // forecast this ≈ 1.0, for an older one it realigns the levels to today.
  const scaleRatio = etfSpot / forecastLastPrice;
  const lastPrice = etfSpot * multiplier;

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
    scaleRatioUsed: scaleRatio,
    targetPrice,
    expectedHigh,
    expectedLow,
    volatilityPct,
    trendBias,
    strengthPct,
    candles,
  };
}
