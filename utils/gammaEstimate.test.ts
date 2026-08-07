/**
 * Tests for the Black-Scholes gamma estimator.
 *
 * Gamma is the cornerstone of every GEX calculation in the app, so getting
 * its qualitative behaviour right matters more than hitting a 6-decimal
 * reference value. These tests pin down the mathematical invariants.
 *
 * Reference formula (Black-Scholes):
 *   γ = N'(d1) / (S · σ · √T)
 *   d1 = (ln(S/K) + (r + σ²/2)·T) / (σ·√T)
 */
import { describe, it, expect } from 'vitest';
import { estimateGamma } from './gammaEstimate';

describe('estimateGamma', () => {
  const SPY = 500;
  const DTE = 7;
  const IV = 0.15;

  describe('mathematical invariants', () => {
    it('is maximised at-the-money (S = K) for fixed T and σ', () => {
      const atm = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: IV });

      // Probe a grid of OTM and ITM strikes — all must be <= ATM gamma
      for (const offset of [-50, -25, -10, 10, 25, 50]) {
        const off = estimateGamma({
          spot: SPY,
          strike: SPY + offset,
          dte: DTE,
          isCall: true,
          impliedVol: IV,
        });
        expect(off).toBeLessThan(atm);
      }
    });

    it('is much smaller for far OTM strikes than at ATM', () => {
      const atm = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: IV });
      // 10% OTM — far enough to decay strongly, close enough to avoid
      // floating-point underflow of the normal PDF at extreme d1.
      const far = estimateGamma({ spot: SPY, strike: SPY * 1.10, dte: DTE, isCall: true, impliedVol: IV });
      expect(far).toBeGreaterThan(0);
      expect(far).toBeLessThan(atm * 0.01);
    });

    it('is the same for calls and puts at identical (S, K, T, σ) — gamma parity', () => {
      const callGamma = estimateGamma({ spot: SPY, strike: SPY + 10, dte: DTE, isCall: true, impliedVol: IV });
      const putGamma = estimateGamma({ spot: SPY, strike: SPY + 10, dte: DTE, isCall: false, impliedVol: IV });
      expect(callGamma).toBeCloseTo(putGamma, 10);
    });

    it('increases for ATM options as expiration approaches (gamma explosion)', () => {
      const farGamma = estimateGamma({ spot: SPY, strike: SPY, dte: 30, isCall: true, impliedVol: IV });
      const midGamma = estimateGamma({ spot: SPY, strike: SPY, dte: 7, isCall: true, impliedVol: IV });
      const nearGamma = estimateGamma({ spot: SPY, strike: SPY, dte: 1, isCall: true, impliedVol: IV });
      expect(nearGamma).toBeGreaterThan(midGamma);
      expect(midGamma).toBeGreaterThan(farGamma);
    });

    it('decays for deep OTM options as expiration approaches', () => {
      const otmStrike = SPY * 1.20; // 20% OTM
      const farGamma = estimateGamma({ spot: SPY, strike: otmStrike, dte: 60, isCall: true, impliedVol: IV });
      const nearGamma = estimateGamma({ spot: SPY, strike: otmStrike, dte: 1, isCall: true, impliedVol: IV });
      expect(nearGamma).toBeLessThan(farGamma);
    });
  });

  describe('numerical sanity', () => {
    it('returns a positive, finite number for ordinary inputs', () => {
      const g = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: IV });
      expect(g).toBeGreaterThan(0);
      expect(Number.isFinite(g)).toBe(true);
    });

    it('never returns NaN/Infinity even for edge-case inputs', () => {
      // dte = 0 is floored to 1 day internally
      expect(Number.isFinite(estimateGamma({ spot: SPY, strike: SPY, dte: 0, isCall: true, impliedVol: IV }))).toBe(true);
      // Very low IV is floored to 5%
      expect(Number.isFinite(estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: 0.001 }))).toBe(true);
      // Deep ITM / OTM
      expect(Number.isFinite(estimateGamma({ spot: SPY, strike: 1, dte: DTE, isCall: true, impliedVol: IV }))).toBe(true);
    });

    it('matches an independent Black-Scholes reference at ATM', () => {
      // Hand-computed reference: S=K=500, σ=0.15, T=7/365, r=0.05
      const T = 7 / 365;
      const sigma = 0.15;
      const r = 0.05;
      const d1 = (Math.log(1) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
      const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
      const reference = pdf / (SPY * sigma * Math.sqrt(T));

      const result = estimateGamma({ spot: SPY, strike: SPY, dte: 7, isCall: true, impliedVol: 0.15, riskFreeRate: 0.05 });
      expect(result).toBeCloseTo(reference, 6);
    });
  });

  describe('IV resolution', () => {
    it('uses the explicit impliedVol when provided', () => {
      const high = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: 0.40 });
      const low = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, impliedVol: 0.10 });
      // ATM gamma decreases as σ increases (the classic bell curve flattens)
      expect(high).toBeLessThan(low);
    });

    it('falls back to per-symbol defaults when impliedVol is omitted', () => {
      // SPY/SPX default = 15%, QQQ/NDX default = 20%
      const spyGamma = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, symbol: 'SPY' });
      const qqqGamma = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, symbol: 'QQQ' });
      // Higher default IV → lower ATM gamma
      expect(qqqGamma).toBeLessThan(spyGamma);
    });

    it('is case-insensitive on the symbol', () => {
      const upper = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, symbol: 'SPY' });
      const lower = estimateGamma({ spot: SPY, strike: SPY, dte: DTE, isCall: true, symbol: 'spy' });
      expect(upper).toBeCloseTo(lower, 10);
    });
  });
});
