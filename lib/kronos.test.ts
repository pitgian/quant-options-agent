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
    last_price_4h: 500, last_price_1d: 500,
    trend_bias: 'NEUTRAL',
    strength_pct: 0,
    forecast_4h: { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
    forecast_1d: { last_price: 500, expected_high: 505, expected_low: 495, predicted_volatility_pct: 2, candles },
  };
}

const tenCandles = Array.from({ length: 10 }, (_, i) =>
  candle(`2026-06-22T15:3${i}:00Z`, 500 + i),
);

// ---------------------------------------------------------------------------
// kronosTimeframeResolution
// ---------------------------------------------------------------------------

describe('kronosTimeframeResolution', () => {
  const cases: Array<[KronosTimeframe, 'forecast_4h' | 'forecast_1d', number, boolean]> = [
    ['4h', 'forecast_4h', 6, true],
    ['1d', 'forecast_1d', 5, true],
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
    expect(getActiveKronosForecast(null, 500, '1d')).toBeNull();
  });

  it('returns null for undefined biasItem', () => {
    expect(getActiveKronosForecast(undefined, 500, '1d')).toBeNull();
  });

  it('returns null for zero etfSpot', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), 0, '1d')).toBeNull();
  });

  it('returns null for negative etfSpot', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), -1, '1d')).toBeNull();
  });

  it('returns null when resolution has no candles', () => {
    const item = makeBiasItem([]);
    expect(getActiveKronosForecast(item, 500, '1d')).toBeNull();
  });

  it('falls back to legacy top-level candles when resolution is missing', () => {
    // For timeframe '1d' the resolution is forecast_1d.
    const item: KronosForecastItem = {
      ...makeBiasItem([]),
      forecast_1d: undefined as unknown as KronosForecastItem['forecast_1d'],
      last_price: 500,
      candles: tenCandles,
    };
    const result = getActiveKronosForecast(item, 500, '1d');
    expect(result).not.toBeNull();
    expect(result!.candles).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — multiday stability (both remaining timeframes)
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — multiday (4h, 1d)', () => {
  it('locks scaleRatio to 1.0 (no jitter) and uses model last_price (4h)', () => {
    // forecast last_price = 500, live spot = 510, but isStable → scaleRatio = 1
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 510, '4h')!;
    // first candle close was 500 → unscaled
    expect(result.candles[0].close).toBeCloseTo(500, 4);
    // lastPrice uses model price, not live spot
    expect(result.lastPrice).toBe(500);
  });

  it('locks scaleRatio to 1.0 (no jitter) and uses model last_price (1d)', () => {
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 510, '1d')!;
    expect(result.candles[0].close).toBeCloseTo(500, 4);
    expect(result.lastPrice).toBe(500);
  });

  it('slices to the timeframe candleCount (4h → 6)', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), 500, '4h')!.candles).toHaveLength(6);
  });

  it('slices to the timeframe candleCount (1d → 5)', () => {
    expect(getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1d')!.candles).toHaveLength(5);
  });

  it('computes volatilityPct from expectedHigh/Low span (4h)', () => {
    // candles close 500..509 (sliced to 6), high=close+1, low=close-1, scaleRatio=1
    // expectedHigh = max(500, 502, 503, 504, 505, 506) = 506  (sliced closes 500..505, +1)
    // expectedLow  = min(500, 499, 500, 501, 502, 503) = 499
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '4h')!;
    expect(result.expectedHigh).toBeCloseTo(506, 4);
    expect(result.expectedLow).toBeCloseTo(499, 4);
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
      candle('2026-06-22T16:15:00Z', 500),
      candle('2026-06-22T16:30:00Z', targetClose),
    ];
    return makeBiasItem(candles);
  };

  it('BULLISH when target > lastPrice + 0.05%', () => {
    // lastPrice=500, target=502 → strengthPct = +0.4% → BULLISH
    expect(getActiveKronosForecast(biasWithTarget(502), 500, '1d')!.trendBias).toBe('BULLISH');
  });

  it('BEARISH when target < lastPrice - 0.05%', () => {
    expect(getActiveKronosForecast(biasWithTarget(498), 500, '1d')!.trendBias).toBe('BEARISH');
  });

  it('NEUTRAL when target is within ±0.05%', () => {
    expect(getActiveKronosForecast(biasWithTarget(500), 500, '1d')!.trendBias).toBe('NEUTRAL');
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — multiplier
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — futures multiplier', () => {
  it('multiplier=10 scales absolute prices but leaves percentages invariant', () => {
    const item = makeBiasItem(tenCandles);
    const etf = getActiveKronosForecast(item, 500, '1d')!;
    const fut = getActiveKronosForecast(item, 500, '1d', { multiplier: 10 })!;

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
    const r1 = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1d')!;
    const r2 = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1d', { multiplier: 1 })!;
    expect(r1.lastPrice).toBe(r2.lastPrice);
  });
});

// ---------------------------------------------------------------------------
// getActiveKronosForecast — chart fields
// ---------------------------------------------------------------------------

describe('getActiveKronosForecast — chart fields', () => {
  it('every candle has formattedTime, label, changePct, rawVolume', () => {
    const result = getActiveKronosForecast(makeBiasItem(tenCandles), 500, '1d')!;
    for (const c of result.candles) {
      expect(typeof c.formattedTime).toBe('string');
      expect(c.formattedTime.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
      expect(typeof c.changePct).toBe('number');
      expect(c.rawVolume).toBe(1000);
    }
  });
});
