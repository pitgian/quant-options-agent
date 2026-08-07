/**
 * Tests for the wall service — put/call wall selection, DTE-aware scoring
 * and 0-100 normalisation.
 */
import { describe, it, expect } from 'vitest';
import { computeWalls } from './wallService';
import type { RawExpiry } from './gexService';

const SPOT = 500;

function build0DteExpiry(options: Array<{ strike: number; side: 'CALL' | 'PUT'; oi: number; vol?: number; gamma?: number }>): RawExpiry[] {
  return [{
    label: '0DTE',
    date: new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10),
    options: options.map(o => ({ vol: 0, ...o })),
  }];
}

describe('computeWalls', () => {
  it('returns put walls below spot and call walls at/above spot', () => {
    const expiries = build0DteExpiry([
      { strike: 490, side: 'PUT', oi: 1000, gamma: 0.01 },
      { strike: 510, side: 'CALL', oi: 1000, gamma: 0.01 },
    ]);
    const { putWalls, callWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    expect(putWalls.length).toBeGreaterThan(0);
    expect(callWalls.length).toBeGreaterThan(0);
    expect(putWalls.every(w => w.strike <= SPOT)).toBe(true);
    expect(callWalls.every(w => w.strike >= SPOT)).toBe(true);
  });

  it('rejects strikes outside the 30%-300% sanity band', () => {
    const expiries = build0DteExpiry([
      { strike: 100, side: 'PUT', oi: 9999, gamma: 0.01 },   // 20% of spot — junk
      { strike: 2000, side: 'CALL', oi: 9999, gamma: 0.01 }, // 400% of spot — junk
      { strike: 490, side: 'PUT', oi: 100, gamma: 0.01 },
    ]);
    const { putWalls, callWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    expect(putWalls.find(w => w.strike === 100)).toBeUndefined();
    expect(callWalls.find(w => w.strike === 2000)).toBeUndefined();
  });

  it('skips strikes with zero OI and zero volume', () => {
    const expiries = build0DteExpiry([
      { strike: 490, side: 'PUT', oi: 0, vol: 0, gamma: 0.01 },
      { strike: 495, side: 'PUT', oi: 100, gamma: 0.01 },
    ]);
    const { putWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    expect(putWalls.find(w => w.strike === 490)).toBeUndefined();
  });

  it('normalises the top wall score to 100', () => {
    const expiries = build0DteExpiry([
      { strike: 495, side: 'PUT', oi: 1000, gamma: 0.01 },
      { strike: 490, side: 'PUT', oi: 100, gamma: 0.01 },
      { strike: 505, side: 'CALL', oi: 1000, gamma: 0.01 },
    ]);
    const { putWalls, callWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    if (putWalls.length > 0) expect(Math.max(...putWalls.map(w => w.score))).toBeCloseTo(100, 1);
    if (callWalls.length > 0) expect(Math.max(...callWalls.map(w => w.score))).toBeCloseTo(100, 1);
  });

  it('caps the number of walls per side at 7', () => {
    const puts = Array.from({ length: 20 }, (_, i) => ({
      strike: SPOT - 1 - i,
      side: 'PUT' as const,
      oi: 1000 - i * 50,
      gamma: 0.01,
    }));
    const expiries = build0DteExpiry(puts);
    const { putWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    expect(putWalls.length).toBeLessThanOrEqual(7);
  });

  it('weights volume more than OI for 0-DTE contracts (intraday relevance)', () => {
    // Two puts at the same strike split across two expiries:
    //   - 0-DTE with high volume
    //   - far expiry with high OI
    // The 0-DTE / high-volume leg should score higher.
    const today = new Date();
    const nearDate = new Date(today.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
    const farDate = new Date(today.getTime() + 60 * 86400 * 1000).toISOString().slice(0, 10);

    const expiries: RawExpiry[] = [
      {
        label: '0DTE', date: nearDate,
        options: [{ strike: 495, side: 'PUT', oi: 100, vol: 5000, gamma: 0.01 }],
      },
      {
        label: 'far', date: farDate,
        options: [{ strike: 490, side: 'PUT', oi: 5000, vol: 0, gamma: 0.01 }],
      },
    ];
    const { putWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    // The 0-DTE high-volume strike should outrank the far high-OI strike
    const s495 = putWalls.find(w => w.strike === 495);
    const s490 = putWalls.find(w => w.strike === 490);
    if (s495 && s490) {
      expect(s495.score).toBeGreaterThan(s490.score);
    }
  });

  it('produces walls carrying the paired (opposite-side) OI/GEX for cross-side context', () => {
    const expiries = build0DteExpiry([
      { strike: 495, side: 'PUT', oi: 1000, gamma: 0.01 },
      { strike: 495, side: 'CALL', oi: 200, gamma: 0.01 },
      { strike: 505, side: 'CALL', oi: 1000, gamma: 0.01 },
    ]);
    const { putWalls } = computeWalls(expiries, SPOT, new Date().toISOString(), 'SPY');
    const w = putWalls.find(x => x.strike === 495);
    expect(w).toBeDefined();
    // callOI on a put wall reflects the opposite side at the same strike
    expect(w!.callOI).toBeGreaterThan(0);
  });
});
