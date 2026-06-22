import { describe, it, expect } from 'vitest';
import { estimateGamma } from './gammaEstimate';

/**
 * Reference parity check: the Python estimate_gamma() and the TS estimateGamma()
 * implement the same Black-Scholes formula and MUST agree to ~6 decimals.
 * If this breaks, someone changed the math on one side only.
 *
 * Python reference values (from scripts/fetch_options_data.py via .venv):
 *   estimate_gamma(spot=500, strike=500, dte=7, symbol='SPY', implied_vol=0.15) -> 0.03834880607838442
 */
describe('Python <-> TS parity (gamma)', () => {
  it('matches the Python estimate_gamma at ATM', () => {
    const ts = estimateGamma({ spot: 500, strike: 500, dte: 7, isCall: true, symbol: 'SPY', impliedVol: 0.15, riskFreeRate: 0.05 });
    const PYTHON_ATM = 0.03834880607838442;
    expect(ts).toBeCloseTo(PYTHON_ATM, 6);
  });
});
