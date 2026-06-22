import { describe, it, expect } from 'vitest';
import {
  getActiveKronosForecast,
  kronosTimeframeResolution,
  KRONOS_TIMEFRAMES,
  type KronosTimeframe,
} from './kronos';
import type { KronosForecastItem, KronosPredictedCandle } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const candle = (ts: string, close: number, open = close): KronosPredictedCandle => ({
  timestamp: ts,
  open,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1000,
});

function makeBiasItem(candles: KronosPredictedCandle[]): KronosForecastItem {
  return {
    ticker: 'SPY',
    last_price_5m: 500, last_price_15m: 500, last_price_1h: 500, last_price_4h: 500, last_price_1d: 500,
    trend_bias: 'NEUTRAL',
    strength_pct: 0,
    forecast_5m:  { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
    forecast_15m: { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
    forecast_1h:  { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
    forecast_4h:  { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
    forecast_1d:  { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
  };
}

const tenCandles = Array.from({ length: 10 }, (_, i) =>
  candle(`2026-06-22T15:3${i}:00Z`, 500 + i),
);

// ---------------------------------------------------------------------------
// kronosTimeframeResolution
// ---------------------------------------------------------------------------

describe('kronosTimeframeResolution', () => {
  const cases: Array<[KronosTimeframe, string, number, boolean]> = [
    ['15m', 'forecast_5m', 3, false],
    ['30m', 'forecast_5m', 6, false],
    ['1h', 'forecast_15m', 4, false],
    ['2h', 'forecast_15m', 8, false],
    ['4h', 'forecast_1h', 4, true],
    ['EOD', 'forecast_1h', 7, true],
    ['2D', 'forecast_4h', 4, true],
    ['3D', 'forecast_4h', 6, true],
    ['1W', 'forecast_1d', 5, true],
  ];

  for (const [tf, resolution, count, isStable] of cases) {
    it(`${tf} → ${resolution}, ${count} candles, isStable=${isStable}`, () => {
      expect(kronosTimeframeResolution(tf)).toEqual({ resolution, candleCount: count, isStable });
    });
  }

  it('covers every entry in KRONOS_TIMEFRAMES (no missing timeframe)', () => {
    for (const { key } of KRONOS_TIMEFRAMES) {
      expect(() => kronosTimeframeResolution(key)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — guard clauses
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — guards', () => {
  it('returns null for null biasItem', () => {
    expect(getActiveKronosForecast(null, 500, '1h')).toBeNull();
  });

  it('returns null for undefined biasItem', () => {
    expect(getActiveKronosForecast(undefined, 500, '1h')).toBeNull();
  });

  it('returns null for zero etfSpot', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), 0, '1h')).toBeNull();
  });

  it('returns null for negative etfSpot', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), -1, '1h')).toBeNull();
  });

  it('returns null when resolution has no candles', () => {
    const item = makeBiasItem([]);
    expect(getActiveKronosForecast(item, 500, '1h')).toBeNull();
  });

  it('falls back to legacy top-level candles when resolution is missing', () => {
    // For timeframe '1h' the resolution is forecast_15m (4 × 15m).
    const item: KronosForecastItem = {
      ...makeBiasItem([]),
      forecast_15m: undefined as unknown as KronosForecastItem['forecast_15m'],
      last_price: 500,
      candles: tenCandles,
    };
    const result = getActiveKronosForecast(item, 500, '1h');
    expect(result).not.toBeNull();
    expect(result!.candles).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — intraday scaling
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — intraday (1h)', () => {
  it('scales candles to live spot (scaleRatio = etfSpot / forecastLastPrice)', () => {
    // forecast last_price = 500, live spot = 510 → scaleRatio = 1.02
    const item = makeBiasItem(tenCandles);
    const result = getActiveKronosForecast(item, 510, '1h');
    expect(result).not.toBeNull();
    // first candle close was 500 → 500 * 1.02 = 510
    expect(result!.candles[0].close).toBeCloseTo(510, 4);
    // lastPrice equals live spot for intraday
    expect(result!.lastPrice).toBe(510);
  });

  it('slices to the timeframe candleCount (1h → 4)', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1h')!.candles).toHaveLength(4);
  });

  it('computes volatilityPct from expectedHigh/Low span', () => {
    // candles close 500..503 (sliced to 4), high=close+1, low=close-1, scaleRatio=1
    // expectedHigh = max(500, 501, 502, 503, 504) = 504
    // expectedLow  = min(500, 499, 500, 501, 502) = 499  (first candle low = 500-1)
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1h')!;
    expect(result.expectedHigh).toBeCloseTo(504, 4);
    expect(result.expectedLow).toBeCloseTo(499, 4);
    // volatilityPct = (504-499)/500 * 100 = 1.0
    expect(result.volatilityPct).toBeCloseTo(1.0, 4);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — multiday stability
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — multiday (1W, stable)', () => {
  it('locks scaleRatio to 1.0 (no jitter) and uses model last_price', () => {
    // forecast last_price = 500, live spot = 510, but isStable → scaleRatio = 1
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 510, '1W')!;
    // first candle close was 500 → unscaled
    expect(result!.candles[0].close).toBeCloseTo(500, 4);
    // lastPrice uses model price, not live spot
    expect(result!.lastPrice).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — trendBias
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — trendBias thresholds', () => {
  const biasWithTarget = (targetClose: number): KronosForecastItem => {
    const candles = [
      candle('2026-06-22T15:30:00Z', 500),
      candle('2026-06-22T15:45:00Z', 500),
      candle('2026-06-22T16:00:00Z', 500),
      candle('2026-06-22T16:15:00Z', targetClose),
    ];
    return makeBiasItem(candles);
  };

  it('BULLISH when target > lastPrice + 0.05%', () => {
    // lastPrice=500, target=502 → strengthPct = +0.4% → BULLISH
    expect(getActiveKronosForecast(biasWithTarget(502), 500, '1h')!.trendBias).toBe('BULLISH');
  });

  it('BEARISH when target < lastPrice - 0.05%', () => {
    expect(getActiveKronosForecast(biasWithTarget(498), 500, '1h')!.trendBias).toBe('BEARISH');
  });

  it('NEUTRAL when target is within ±0.05%', () => {
    // lastPrice=500, target=500 → strengthPct = 0 → NEUTRAL
    expect(getActiveKronosForecast(biasWithTarget(500), 500, '1h')!.trendBias).toBe('NEUTRAL');
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — multiplier
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — futures multiplier', () => {
  it('multiplier=10 scales absolute prices but leaves percentages invariant', () => {
    const item = makeBiasItem(tenCandles);
    const etf = getActiveKronosForecast(item, 500, '1h')!;
    const fut = getActiveKronosForecast(item, 500, '1h', { multiplier: 10 })!;

    // Absolute prices scale by 10
    expect(fut.lastPrice).toBeCloseTo(etf.lastPrice * 10, 4);
    expect(fut.targetPrice).toBeCloseTo(etf.targetPrice * 10, 4);
    expect(fut.expectedHigh).toBeCloseTo(etf.expectedHigh * 10, 4);
    expect(fut.expectedLow).toBeCloseTo(etf.expectedLow * 10, 4);
    expect(fut.candles[0].close).toBeCloseTo(etf.candles[0].close * 10, 4);

    // Percentages are invariant
    expect(fut.volatilityPct).toBeCloseTo(etf.volatilityPct, 6);
    expect(fut.strengthPct).toBeCloseTo(etf.strengthPct, 6);
    expect(fut.candles[0].changePct).toBeCloseTo(etf.candles[0].changePct, 6);
  });

  it('default multiplier is 1 (ETF space)', () => {
    const r1 = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1h')!;
    const r2 = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1h', { multiplier: 1 })!;
    expect(r1.lastPrice).toBe(r2.lastPrice);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — chart fields
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — chart fields', () => {
  it('every candle has formattedTime, label, changePct, rawVolume', () => {
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1h')!;
    for (const c of result.candles) {
      expect(typeof c.formattedTime).toBe('string');
      expect(c.formattedTime.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
      expect(typeof c.changePct).toBe('number');
      expect(c.rawVolume).toBe(1000);
    }
  });
});
