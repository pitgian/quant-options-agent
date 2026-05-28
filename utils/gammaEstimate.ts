/**
 * Gamma Estimation Utility
 *
 * Provides a client-side Black-Scholes gamma approximation for use when
 * raw options data does not include gamma values.
 *
 * γ = N'(d1) / (S × σ × √T)
 *
 * Where:
 *   N'(d1) = standard normal PDF evaluated at d1
 *   d1 = (ln(S/K) + (r + σ²/2) × T) / (σ × √T)
 *   S = spot price, K = strike, σ = implied vol, T = time in years
 *
 * @module utils/gammaEstimate
 */

// ============================================================================
// PER-SYMBOL IV DEFAULTS
// ============================================================================

const DEFAULT_IV: Record<string, number> = {
  'SPY': 0.15,
  'QQQ': 0.20,
  'SPX': 0.15,
  'NDX': 0.20,
};

const FALLBACK_IV = 0.20;

// ============================================================================
// STANDARD NORMAL DISTRIBUTION HELPERS
// ============================================================================

/**
 * Standard normal probability density function (PDF).
 *
 * N'(x) = e^(-x²/2) / √(2π)
 */
function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface GammaEstimateParams {
  spot: number;
  strike: number;
  dte: number;           // days to expiration
  isCall: boolean;
  symbol?: string;       // for per-symbol IV defaults
  impliedVol?: number;   // optional, overrides default
  riskFreeRate?: number; // optional, defaults to 0.05 (5%)
}

/**
 * Estimate Black-Scholes gamma for an option.
 *
 * Uses per-symbol IV defaults when no explicit IV is provided:
 *   - SPY/SPX: 15%
 *   - QQQ/NDX: 20%
 *   - Fallback: 20%
 *
 * Other defaults:
 *   - Default risk-free rate: 5%
 *   - Minimum DTE: 1 day (avoids division by zero)
 *   - Minimum IV: 5% (avoids numerical instability)
 *
 * The estimate is directional — accurate enough for GEX sign/flip detection
 * but not intended for precise pricing.
 */
export function estimateGamma(params: GammaEstimateParams): number {
  const {
    spot,
    strike,
    dte,
    symbol,
    impliedVol,
    riskFreeRate = 0.05,
  } = params;

  // Resolve IV: explicit > per-symbol default > fallback
  const defaultIV = (symbol && DEFAULT_IV[symbol.toUpperCase()]) || FALLBACK_IV;
  const sigma_input = impliedVol ?? defaultIV;

  // Guard: time in years, minimum 1 day to avoid division by zero
  const T = Math.max(dte / 365, 1 / 365);
  // Guard: floor IV at 5% to avoid numerical instability
  const sigma = Math.max(sigma_input, 0.05);
  const sqrtT = Math.sqrt(T);

  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * sigma * sigma) * T) /
    (sigma * sqrtT);

  const gamma = normalPDF(d1) / (spot * sigma * sqrtT);

  return gamma;
}
