/**
 * Python <-> TypeScript parity tests.
 *
 * These tests consume scripts/test/parity_fixtures.json, a JSON file produced
 * by scripts/test/generate_parity_fixtures.py running the *Python* quantitative
 * pipeline. If the TS implementation diverges from the Python one, these tests
 * break — surfacing the drift instead of letting it silently produce
 * inconsistent dashboards.
 *
 * To regenerate the fixtures after changing the Python math:
 *     .venv/bin/python scripts/test/generate_parity_fixtures.py
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { estimateGamma } from './gammaEstimate';
import { computeGEXPerStrike } from '../services/gexService';
import type { RawExpiry } from '../services/gexService';
import { computeWallScore } from '../services/wallService';

interface Fixtures {
  gamma_cases: Array<{ spot: number; strike: number; dte: number; symbol: string; implied_vol: number; expected_gamma: number }>;
  gex_cases: Array<{ strike: number; side: 'CALL' | 'PUT'; oi: number; dte: number; gamma: number; expected_gex: number }>;
  dte_weight_cases: Array<{ dte: number; expected_oi_weight: number; expected_vol_weight: number }>;
  wall_score_cases: Array<{ own_oi: number; own_vol: number; nearest_dte: number; strike: number; spot: number; expected_score: number }>;
}

const FIXTURES_PATH = join(__dirname, '..', 'scripts', 'test', 'parity_fixtures.json');
const fixtures: Fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));

describe('Python <-> TS parity: estimateGamma', () => {
  for (const c of fixtures.gamma_cases) {
    it(`gamma(spot=${c.spot}, K=${c.strike}, dte=${c.dte}, σ=${c.implied_vol}) matches Python`, () => {
      const ts = estimateGamma({
        spot: c.spot,
        strike: c.strike,
        dte: c.dte,
        isCall: true, // gamma is the same for calls and puts (verified elsewhere)
        symbol: c.symbol,
        impliedVol: c.implied_vol,
        riskFreeRate: 0.05,
      });
      // Skip extreme deep-OTM cases where gamma underflows to ~0 in both
      // implementations (the relative error is meaningless there).
      if (c.expected_gamma < 1e-30) {
        expect(ts).toBeLessThan(1e-30);
        return;
      }
      expect(ts).toBeCloseTo(c.expected_gamma, 4);
    });
  }
});

describe('Python <-> TS parity: GEX per strike', () => {
  for (const c of fixtures.gex_cases) {
    it(`GEX(strike=${c.strike}, ${c.side}, oi=${c.oi}, dte=${c.dte}) matches Python`, () => {
      // Build a minimal RawExpiry[] with one option, run it through the TS
      // aggregator, and compare the per-strike result against the Python value.
      const expiryDate = new Date(Date.now() + c.dte * 86400 * 1000).toISOString().slice(0, 10);
      const expiries: RawExpiry[] = [{
        label: 'test',
        date: expiryDate,
        options: [{
          strike: c.strike,
          side: c.side,
          oi: c.oi,
          vol: 0,
          gamma: c.gamma, // feed the exact gamma Python used
        }],
      }];
      const SPOT = 500;
      const map = computeGEXPerStrike(expiries, SPOT, new Date().toISOString(), 'SPY');
      const strikeData = map.get(c.strike);
      expect(strikeData).toBeDefined();
      const tsGex = c.side === 'CALL' ? strikeData!.callGEX : strikeData!.putGEX;
      expect(tsGex).toBeCloseTo(c.expected_gex, 0);
    });
  }
});

describe('Python <-> TS parity: unified wall score', () => {
  for (const c of fixtures.wall_score_cases) {
    it(`wall_score(oi=${c.own_oi}, vol=${c.own_vol}, dte=${c.nearest_dte}, K=${c.strike}, spot=${c.spot}) matches Python`, () => {
      const ts = computeWallScore(c.own_oi, c.own_vol, c.nearest_dte, c.strike, c.spot);
      expect(ts).toBeCloseTo(c.expected_score, 4);
    });
  }
});
