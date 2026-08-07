import { describe, it, expect } from 'vitest';
import { computeMetrics, formatCi95 } from './forecastScoreService';
import type { ForecastSnapshot } from '../types';

// ---------------------------------------------------------------------------
// Helpers to build snapshots concisely.
// ---------------------------------------------------------------------------

let seq = 0;
function snap(overrides: Partial<ForecastSnapshot>): ForecastSnapshot {
  seq += 1;
  return {
    v: 1,
    issued_at: `2026-07-${String(10).padStart(2, '0')}T10:00:00Z`,
    symbol: 'SPY',
    horizon: '1d',
    target_at: '2026-07-15',
    anchor_price: 100,
    predicted_target: 102,
    predicted_high: 104,
    predicted_low: 98,
    predicted_direction: 'UP',
    trend_bias: 'BULLISH',
    realized_price: 101,
    direction_correct: true,
    abs_pct_error: 1,
    range_hit: true,
    scored_at: '2026-07-15T20:00:00Z',
    ...overrides,
  };
}

// Force every snapshot into a fresh, recent day so the 30-day default window
// never drops them. Called per-suite.
function recentDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString();
}

describe('computeMetrics', () => {
  it('computes directional accuracy = hits / directional samples', () => {
    const snaps = [
      snap({ direction_correct: true }),
      snap({ direction_correct: true }),
      snap({ direction_correct: false }),
    ];
    const m = computeMetrics(snaps);
    expect(m.overall.directionalAccuracy).toBeCloseTo(2 / 3, 6);
    expect(m.overall.directionalN).toBe(3);
  });

  it('excludes FLAT/NEUTRAL (direction_correct === null) from directional accuracy', () => {
    // 2 hits + 1 miss among directional; 3 NEUTRAL that must NOT count as misses.
    const snaps = [
      snap({ direction_correct: true }),
      snap({ direction_correct: true }),
      snap({ direction_correct: false }),
      snap({ predicted_direction: 'FLAT', direction_correct: null }),
      snap({ predicted_direction: 'FLAT', direction_correct: null }),
      snap({ predicted_direction: 'FLAT', direction_correct: null }),
    ];
    const m = computeMetrics(snaps);
    expect(m.overall.directionalN).toBe(3); // FLAT excluded
    expect(m.overall.directionalAccuracy).toBeCloseTo(2 / 3, 6);
  });

  it('returns null directional accuracy when no directional samples', () => {
    const snaps = [
      snap({ predicted_direction: 'FLAT', direction_correct: null }),
      snap({ predicted_direction: 'FLAT', direction_correct: null }),
    ];
    const m = computeMetrics(snaps);
    expect(m.overall.directionalAccuracy).toBeNull();
    expect(m.overall.directionalN).toBe(0);
    expect(m.overall.directionalCi95).toBeNull();
  });

  it('computes Wilson CI95 that shrinks as n grows', () => {
    // All-correct at small n → high centre but wide CI.
    const small = Array.from({ length: 3 }, () => snap({ direction_correct: true }));
    // All-correct at large n → high centre, narrow CI.
    const large = Array.from({ length: 300 }, () => snap({ direction_correct: true }));
    const mSmall = computeMetrics(small).overall;
    const mLarge = computeMetrics(large).overall;
    expect(mSmall.directionalCi95).not.toBeNull();
    expect(mLarge.directionalCi95).not.toBeNull();
    expect(mLarge.directionalCi95!).toBeLessThan(mSmall.directionalCi95!);
  });

  it('computes MAPE as mean of abs_pct_error with std-dev', () => {
    const snaps = [
      snap({ abs_pct_error: 1 }),
      snap({ abs_pct_error: 3 }),
      snap({ abs_pct_error: 5 }),
    ];
    const m = computeMetrics(snaps).overall;
    expect(m.mape).toBeCloseTo(3, 6);
    expect(m.mapeN).toBe(3);
    expect(m.mapeStd).not.toBeNull();
    // sample std-dev of [1,3,5]: variance = ((4)+(0)+(4))/(3-1) = 4 → std=2
    expect(m.mapeStd).toBeCloseTo(2, 6);
  });

  it('computes range coverage as hits / range samples', () => {
    const snaps = [
      snap({ range_hit: true }),
      snap({ range_hit: true }),
      snap({ range_hit: false }),
      snap({ range_hit: null }), // unscored range → excluded
    ];
    const m = computeMetrics(snaps).overall;
    expect(m.rangeN).toBe(3);
    expect(m.rangeCoverage).toBeCloseTo(2 / 3, 6);
  });

  it('computes Monte Carlo band coverage, ignoring legacy snapshots without band_hit', () => {
    // v2 snapshots with a band_hit; plus a v1 snapshot without band fields that
    // must be excluded from bandN (so it cannot inflate or deflate bandCoverage).
    const snaps = [
      snap({ v: 2, band_p10: 99, band_p90: 103, band_hit: true }),
      snap({ v: 2, band_p10: 99, band_p90: 103, band_hit: true }),
      snap({ v: 2, band_p10: 99, band_p90: 103, band_hit: false }),
      snap({ v: 2, band_p10: 99, band_p90: 103, band_hit: null }),  // unscored → excluded
      snap({ v: 1 }),  // legacy, no band fields → excluded
    ];
    const m = computeMetrics(snaps).overall;
    expect(m.bandN).toBe(3);
    expect(m.bandCoverage).toBeCloseTo(2 / 3, 6);
    expect(m.bandCi95).not.toBeNull();
  });

  it('returns null band coverage when no v2 snapshots have band_hit', () => {
    const snaps = [
      snap({ v: 1 }),  // legacy
      snap({ v: 2, band_p10: 99, band_p90: 103, band_hit: null }),  // unscored
    ];
    const m = computeMetrics(snaps).overall;
    expect(m.bandN).toBe(0);
    expect(m.bandCoverage).toBeNull();
    expect(m.bandCi95).toBeNull();
  });

  it('splits metrics by symbol × horizon in byGroup', () => {
    const snaps = [
      snap({ symbol: 'SPY', horizon: '4h', direction_correct: true }),
      snap({ symbol: 'SPY', horizon: '1d', direction_correct: false }),
      snap({ symbol: 'QQQ', horizon: '4h', direction_correct: true }),
      snap({ symbol: 'QQQ', horizon: '1d', direction_correct: true }),
    ];
    const m = computeMetrics(snaps);
    expect(Object.keys(m.byGroup).sort()).toEqual(['QQQ|1d', 'QQQ|4h', 'SPY|1d', 'SPY|4h']);
    expect(m.byGroup['SPY|4h'].directionalAccuracy).toBe(1);
    expect(m.byGroup['SPY|1d'].directionalAccuracy).toBe(0);
  });

  it('counts pending = unscored (realized_price null) and totalScored', () => {
    const snaps = [
      snap({ realized_price: 101 }),                                   // scored
      snap({ realized_price: 101 }),                                   // scored
      snap({ realized_price: null, direction_correct: null, abs_pct_error: null, range_hit: null, scored_at: null }), // pending
    ];
    const m = computeMetrics(snaps);
    expect(m.pendingCount).toBe(1);
    expect(m.overall.totalScored).toBe(2);
    expect(m.totalCount).toBe(3);
  });

  it('respects windowDays cutoff (drops old snapshots)', () => {
    // One recent, one ancient (1000 days ago). windowDays=30 keeps only the recent.
    const snaps = [
      snap({ issued_at: recentDay(1), direction_correct: true }),
      snap({ issued_at: recentDay(1000), direction_correct: false }),
    ];
    const m = computeMetrics(snaps, { windowDays: 30 });
    expect(m.totalCount).toBe(1);
    expect(m.overall.directionalAccuracy).toBe(1);
  });

  it('respects symbol and horizon filters', () => {
    const snaps = [
      snap({ symbol: 'SPY', horizon: '4h', direction_correct: true }),
      snap({ symbol: 'SPY', horizon: '1d', direction_correct: false }),
      snap({ symbol: 'QQQ', horizon: '4h', direction_correct: true }),
      snap({ symbol: 'QQQ', horizon: '1d', direction_correct: true }),
    ];
    expect(computeMetrics(snaps, { symbol: 'SPY' }).totalCount).toBe(2);
    expect(computeMetrics(snaps, { horizon: '4h' }).totalCount).toBe(2);
    expect(computeMetrics(snaps, { symbol: 'QQQ', horizon: '1d' }).totalCount).toBe(1);
  });

  it('builds a rolling accuracy point per day × horizon (FLAT excluded)', () => {
    const day = recentDay(1).slice(0, 10);
    const snaps = [
      snap({ issued_at: recentDay(1), horizon: '4h', direction_correct: true }),
      snap({ issued_at: recentDay(1), horizon: '4h', direction_correct: false }),
      snap({ issued_at: recentDay(1), horizon: '1d', direction_correct: true }),
      // FLAT on the same day — must not enter the rolling directional series
      snap({ issued_at: recentDay(1), horizon: '1d', predicted_direction: 'FLAT', direction_correct: null }),
    ];
    const m = computeMetrics(snaps, { windowDays: 30 });
    const r4h = m.rolling.find((p) => p.day === day && p.horizon === '4h');
    const r1d = m.rolling.find((p) => p.day === day && p.horizon === '1d');
    expect(r4h?.n).toBe(2);
    expect(r4h?.accuracy).toBe(0.5);
    expect(r1d?.n).toBe(1); // FLAT excluded
    expect(r1d?.accuracy).toBe(1);
  });

  it('returns empty overall metrics for an empty input', () => {
    const m = computeMetrics([]);
    expect(m.overall.directionalAccuracy).toBeNull();
    expect(m.overall.mape).toBeNull();
    expect(m.totalCount).toBe(0);
    expect(m.rolling).toEqual([]);
  });
});

describe('formatCi95', () => {
  it('formats a half-width as percentage points', () => {
    // ci95 is the FULL width; formatCi95 shows ± half of it.
    expect(formatCi95(0.10)).toBe('±5.0pp');
  });
  it('returns em-dash for null', () => {
    expect(formatCi95(null)).toBe('—');
  });
});
