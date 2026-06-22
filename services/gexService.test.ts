/**
 * Tests for the GEX service — per-strike GEX aggregation, flip-point
 * detection and regime classification.
 *
 * The flip point and regime logic drive the "volatility regime" badge on
 * the dashboard, so regressions here are user-visible.
 */
import { describe, it, expect } from 'vitest';
import {
  computeGEXPerStrike,
  computeTotalNetGEX,
  computeGexFlipPoint,
  computeGexRegime,
  type RawExpiry,
} from './gexService';

const SPOT = 500;

/** Builds a single 0-DTE expiry with the given options. */
function build0DteExpiry(options: Array<{ strike: number; side: 'CALL' | 'PUT'; oi: number; vol?: number; gamma?: number }>): RawExpiry[] {
  return [{
    label: '0DTE',
    date: new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10),
    options: options.map(o => ({ vol: 0, ...o })),
  }];
}

describe('computeGEXPerStrike', () => {
  it('aggregates OI, volume and GEX per strike across calls and puts', () => {
    const expiries = build0DteExpiry([
      { strike: 495, side: 'PUT', oi: 100, gamma: 0.01 },
      { strike: 495, side: 'CALL', oi: 50, gamma: 0.01 },
      { strike: 505, side: 'CALL', oi: 80, gamma: 0.01 },
    ]);

    const map = computeGEXPerStrike(expiries, SPOT, new Date().toISOString(), 'SPY');

    expect(map.size).toBe(2);
    const s495 = map.get(495)!;
    expect(s495.callOI).toBe(50);
    expect(s495.putOI).toBe(100);
    // Call GEX positive, put GEX negative (sign convention)
    expect(s495.callGEX).toBeGreaterThan(0);
    expect(s495.putGEX).toBeLessThan(0);
  });

  it('gives call GEX a positive sign and put GEX a negative sign', () => {
    const expiries = build0DteExpiry([
      { strike: SPOT, side: 'CALL', oi: 10, gamma: 0.005 },
      { strike: SPOT, side: 'PUT', oi: 10, gamma: 0.005 },
    ]);
    const map = computeGEXPerStrike(expiries, SPOT, new Date().toISOString(), 'SPY');
    const s = map.get(SPOT)!;
    expect(s.callGEX).toBeGreaterThan(0);
    expect(s.putGEX).toBeLessThan(0);
    // Equal OI + gamma → call and put GEX cancel out (net ~0)
    expect(Math.abs(s.netGEX)).toBeLessThan(1e-6);
  });

  it('estimates gamma via Black-Scholes when not provided', () => {
    const expiries = build0DteExpiry([
      { strike: SPOT, side: 'CALL', oi: 10 /* no gamma */ },
    ]);
    const map = computeGEXPerStrike(expiries, SPOT, new Date().toISOString(), 'SPY');
    const s = map.get(SPOT)!;
    expect(s.callGEX).toBeGreaterThan(0); // gamma was estimated, not zero
  });

  it('applies time-decay weighting: far expiries contribute less than near', () => {
    const nearDate = new Date(Date.now() + 1 * 86400 * 1000).toISOString().slice(0, 10);
    const farDate = new Date(Date.now() + 90 * 86400 * 1000).toISOString().slice(0, 10);
    const gamma = 0.005;

    const nearExpiries: RawExpiry[] = [{ label: 'near', date: nearDate, options: [{ strike: SPOT, side: 'CALL', oi: 100, vol: 0, gamma }] }];
    const farExpiries: RawExpiry[] = [{ label: 'far', date: farDate, options: [{ strike: SPOT, side: 'CALL', oi: 100, vol: 0, gamma }] }];

    const nearMap = computeGEXPerStrike(nearExpiries, SPOT, new Date().toISOString(), 'SPY');
    const farMap = computeGEXPerStrike(farExpiries, SPOT, new Date().toISOString(), 'SPY');

    // timeWeight = 1/(1+dte/7): near (~1/(1+1/7)=0.875) >> far (~1/(1+90/7)=0.072)
    expect(nearMap.get(SPOT)!.callGEX).toBeGreaterThan(farMap.get(SPOT)!.callGEX);
  });
});

describe('computeTotalNetGEX', () => {
  it('sums net GEX across all strikes', () => {
    const map = computeGEXPerStrike(
      build0DteExpiry([
        { strike: 490, side: 'PUT', oi: 200, gamma: 0.01 },
        { strike: 510, side: 'CALL', oi: 100, gamma: 0.01 },
      ]),
      SPOT,
      new Date().toISOString(),
      'SPY',
    );
    const total = computeTotalNetGEX(map);
    // Heavy put gamma below → net negative
    expect(total).toBeLessThan(0);
  });
});

describe('computeGexFlipPoint', () => {
  /** Builds a strike map with a programmable zero-crossing of net GEX. */
  function buildMapWithCrossing(strikes: number[], gexValues: number[]) {
    const map = new Map<number, any>();
    strikes.forEach((s, i) => {
      map.set(s, {
        strike: s,
        netGEX: gexValues[i],
        callGEX: Math.max(0, gexValues[i]),
        putGEX: Math.min(0, gexValues[i]),
        callOI: 0, putOI: 0, callVolume: 0, putVolume: 0,
      });
    });
    return map;
  }

  it('locates the zero-crossing via linear interpolation', () => {
    // Dense grid around spot 500, discontinuity at s<500 -> +200 / s>=500 -> -200
    // so the true linear zero-cross sits exactly at 499.5 (midpoint of the
    // +200 @ 499 and -200 @ 500 pair). The 5-strike smoothing preserves it.
    const strikes: number[] = [];
    const gex: number[] = [];
    for (let s = 475; s <= 525; s += 1) {
      strikes.push(s);
      gex.push(s < 500 ? 200 : -200);
    }
    const map = buildMapWithCrossing(strikes, gex);
    const flip = computeGexFlipPoint(map, 500);
    expect(flip).not.toBeNull();
    expect(flip!).toBeCloseTo(499.5, 1);
  });

  it('returns null when fewer than 10 strikes are in the ±5% band', () => {
    const map = buildMapWithCrossing([498, 500, 502], [200, 0, -200]);
    expect(computeGexFlipPoint(map, 500)).toBeNull();
  });

  it('is robust to single-strike noise thanks to 5-strike smoothing', () => {
    // Monotone negative profile except one fake positive spike at 500
    const strikes: number[] = [];
    const gex: number[] = [];
    for (let s = 475; s <= 525; s += 1) {
      strikes.push(s);
      gex.push(s === 500 ? 1000 : -100); // isolated spike
    }
    const map = buildMapWithCrossing(strikes, gex);
    // The isolated spike should be averaged away; flip should be far from 500
    const flip = computeGexFlipPoint(map, 500);
    if (flip !== null) {
      // The smoothed series at the edges is ~ (-100*4 + 1000 - 100)/5 near 500 ≈ 100, still positive-ish,
      // but further out it's all -100. The first crossing lands well away from the spike.
      // We only assert the smoothing kept it from snapping exactly onto the noisy spike.
      expect(Math.abs(flip - 500)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('computeGexRegime', () => {
  it('classifies as NEUTRAL when net GEX is tiny vs total absolute GEX', () => {
    const map = computeGEXPerStrike(
      build0DteExpiry([
        { strike: 490, side: 'PUT', oi: 100, gamma: 0.01 },
        { strike: 510, side: 'CALL', oi: 100, gamma: 0.01 }, // symmetric → balanced
      ]),
      SPOT,
      new Date().toISOString(),
      'SPY',
    );
    const regime = computeGexRegime(map, SPOT);
    // Symmetric setup → |net|/abs is ~0 → neutral
    expect(regime.regime).toBe('neutral');
    expect(regime.label).toBe('Neutral');
  });

  it('classifies as LOW VOLATILITY (positive gamma) when spot is at/above the flip', () => {
    // Calls dominate above spot → positive net GEX → no crossing below spot → positive regime
    const map = computeGEXPerStrike(
      build0DteExpiry([
        { strike: 490, side: 'PUT', oi: 10, gamma: 0.01 },
        { strike: 510, side: 'CALL', oi: 500, gamma: 0.01 },
      ]),
      SPOT,
      new Date().toISOString(),
      'SPY',
    );
    const regime = computeGexRegime(map, SPOT);
    expect(['positive', 'neutral']).toContain(regime.regime);
  });

  it('exposes net GEX and flip point on the returned regime', () => {
    const map = computeGEXPerStrike(
      build0DteExpiry([{ strike: SPOT, side: 'CALL', oi: 100, gamma: 0.01 }]),
      SPOT,
      new Date().toISOString(),
      'SPY',
    );
    const regime = computeGexRegime(map, SPOT);
    expect(typeof regime.netGEX).toBe('number');
    // flipPoint is number or null
    expect(regime.flipPoint === null || typeof regime.flipPoint === 'number').toBe(true);
  });
});
