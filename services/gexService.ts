/**
 * GEX (Gamma Exposure) Service
 *
 * Computes per-strike GEX, total net GEX, GEX flip point, and GEX regime
 * from raw expiration data.
 *
 * GEX formula: OI × gamma × 100 × spot² × sign × timeWeight
 *   sign = +1 for calls, -1 for puts
 *   timeWeight = 1 / (1 + DTE / 7)
 *
 * @module services/gexService
 */

import { GexStrikeData, GexRegime } from '../types';
import { estimateGamma } from '../utils/gammaEstimate';

// ============================================================================
// INTERNAL TYPES
// ============================================================================

export interface RawExpiry {
  label: string;
  date: string;
  options: RawOption[];
}

export interface RawOption {
  strike: number;
  side: 'CALL' | 'PUT';
  oi: number;
  vol: number;
  gamma?: number;
}

// ============================================================================
// GEX COMPUTATION
// ============================================================================

const CONTRACT_SIZE = 100;

/**
 * Computes GEX per strike from raw expiration data.
 *
 * Returns a Map<strike, GexStrikeData> with time-decay weighted values.
 *
 * @param expiries - raw expiration data
 * @param spotPrice - current spot price
 * @param generatedAt - data generation timestamp
 * @param symbol - symbol for per-symbol IV defaults
 */
export function computeGEXPerStrike(
  expiries: RawExpiry[],
  spotPrice: number,
  generatedAt?: string,
  symbol?: string
): Map<number, GexStrikeData> {
  const strikeMap = new Map<number, GexStrikeData>();

  for (const expiry of expiries) {
    const expiryDate = new Date(expiry.date);
    const now = generatedAt ? new Date(generatedAt) : new Date();
    const dte = Math.max(0, Math.ceil(
      (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    ));
    const timeWeight = 1 / (1 + dte / 7);

    for (const opt of expiry.options) {
      const existing = strikeMap.get(opt.strike) || {
        strike: opt.strike,
        netGEX: 0,
        callGEX: 0,
        putGEX: 0,
        callOI: 0,
        putOI: 0,
        callVolume: 0,
        putVolume: 0,
      };

      // Use provided gamma or estimate via simplified Black-Scholes
      const gamma = opt.gamma || estimateGamma({
        spot: spotPrice,
        strike: opt.strike,
        dte,
        isCall: opt.side === 'CALL',
        symbol,
      });

      if (opt.side === 'CALL') {
        existing.callOI += opt.oi * timeWeight;
        existing.callVolume += opt.vol * timeWeight;
        existing.callGEX += opt.oi * gamma * CONTRACT_SIZE * spotPrice * spotPrice * 1 * timeWeight;
      } else {
        existing.putOI += opt.oi * timeWeight;
        existing.putVolume += opt.vol * timeWeight;
        existing.putGEX += opt.oi * gamma * CONTRACT_SIZE * spotPrice * spotPrice * (-1) * timeWeight;
      }

      existing.netGEX = existing.callGEX + existing.putGEX;
      strikeMap.set(opt.strike, existing);
    }
  }

  return strikeMap;
}

/**
 * Computes total net GEX by summing all strike GEX values.
 */
export function computeTotalNetGEX(strikeMap: Map<number, GexStrikeData>): number {
  let totalNetGEX = 0;
  for (const data of strikeMap.values()) {
    totalNetGEX += data.netGEX;
  }
  return Math.round(totalNetGEX * 100) / 100;
}

/**
 * Computes the GEX flip point — the interpolated strike where
 * cumulative net GEX crosses from positive to negative.
 *
 * Key fixes:
 *   - Search bounded to ±5% of spot price
 *   - Requires at least 10 strikes with non-zero GEX within range
 *   - Returns null if flip can't be reliably computed
 *
 * @param strikeMap - per-strike GEX data
 * @param spotPrice - current spot price for bounding the search
 */
export function computeGexFlipPoint(
  strikeMap: Map<number, GexStrikeData>,
  spotPrice: number
): number | null {
  // Bound search to ±5% of spot
  const lowerBound = spotPrice * 0.95;
  const upperBound = spotPrice * 1.05;

  const netGexByStrike = new Map<number, number>();
  for (const [strike, data] of strikeMap.entries()) {
    if (data.netGEX !== 0 && strike >= lowerBound && strike <= upperBound) {
      netGexByStrike.set(strike, data.netGEX);
    }
  }

  // Need at least 10 strikes with non-zero GEX for reliable interpolation
  if (netGexByStrike.size < 10) return null;

  const sortedStrikes = Array.from(netGexByStrike.entries())
    .sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < sortedStrikes.length - 1; i++) {
    const [s1, g1] = sortedStrikes[i];
    const [s2, g2] = sortedStrikes[i + 1];
    if (g1 > 0 && g2 < 0) {
      return Math.round((s1 + (0 - g1) * (s2 - s1) / (g2 - g1)) * 100) / 100;
    }
  }

  return null;
}

/**
 * Computes the GEX regime from per-strike GEX data.
 *
 * Regime determination:
 *   - Positive net GEX → "Low Volatility" (dealer hedging suppresses vol)
 *   - Negative net GEX → "High Volatility" (dealer hedging amplifies vol)
 *   - Near zero → "Neutral"
 *
 * "Near zero" is defined as |netGEX| < 5% of total absolute GEX.
 */
export function computeGexRegime(
  strikeMap: Map<number, GexStrikeData>,
  spotPrice: number
): GexRegime {
  const totalNetGEX = computeTotalNetGEX(strikeMap);

  // Compute total absolute GEX for neutral threshold
  let totalAbsGEX = 0;
  for (const data of strikeMap.values()) {
    totalAbsGEX += Math.abs(data.callGEX) + Math.abs(data.putGEX);
  }

  const flipPoint = computeGexFlipPoint(strikeMap, spotPrice);

  // Determine regime
  const ratio = totalAbsGEX > 0 ? Math.abs(totalNetGEX) / totalAbsGEX : 0;
  const NEUTRAL_THRESHOLD = 0.05; // 5% of total absolute GEX

  let regime: 'positive' | 'negative' | 'neutral';
  let label: string;

  if (ratio < NEUTRAL_THRESHOLD) {
    regime = 'neutral';
    label = 'Neutral';
  } else if (totalNetGEX > 0) {
    regime = 'positive';
    label = 'Low Volatility';
  } else {
    regime = 'negative';
    label = 'High Volatility';
  }

  return { regime, label, netGEX: totalNetGEX, flipPoint };
}

/**
 * Aggregates per-strike data into a sorted array for chart rendering.
 * Rounds all values to 2 decimal places.
 */
export function computeGexStrikeData(strikeMap: Map<number, GexStrikeData>): GexStrikeData[] {
  return Array.from(strikeMap.values())
    .map(d => ({
      strike: d.strike,
      netGEX: Math.round(d.netGEX * 100) / 100,
      callGEX: Math.round(d.callGEX * 100) / 100,
      putGEX: Math.round(d.putGEX * 100) / 100,
      callOI: Math.round(d.callOI * 100) / 100,
      putOI: Math.round(d.putOI * 100) / 100,
      callVolume: Math.round(d.callVolume * 100) / 100,
      putVolume: Math.round(d.putVolume * 100) / 100,
    }))
    .sort((a, b) => a.strike - b.strike);
}
