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
 * Computes the GEX flip point — the interpolated strike where net GEX crosses zero.
 *
 * Employs a 5-strike moving average to smooth out single-strike noise spikes
 * (especially common on dense 0DTE option chains) and returns the crossing
 * that is closest to the current spot price.
 *
 * Bounded to ±5% of spot price. Returns null if flip can't be reliably computed.
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

  // Filter and sort strikes in range
  const strikesInRange = Array.from(strikeMap.keys())
    .filter(s => s >= lowerBound && s <= upperBound)
    .sort((a, b) => a - b);

  // Need at least 10 strikes in range for reliable calculations
  if (strikesInRange.length < 10) return null;

  // Apply a 5-strike moving average to smooth net GEX profile
  const smoothedGex: number[] = [];
  const halfWindow = 2; // 2 before, 2 after + current = 5 strikes window
  for (let i = 0; i < strikesInRange.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j >= 0 && j < strikesInRange.length) {
        sum += strikeMap.get(strikesInRange[j])?.netGEX ?? 0;
        count++;
      }
    }
    smoothedGex.push(sum / count);
  }

  // Find all zero crossings (both directions)
  const crossings: { strike: number; dist: number }[] = [];
  for (let i = 0; i < strikesInRange.length - 1; i++) {
    const s1 = strikesInRange[i];
    const s2 = strikesInRange[i + 1];
    const g1 = smoothedGex[i];
    const g2 = smoothedGex[i + 1];

    if ((g1 <= 0 && g2 > 0) || (g1 >= 0 && g2 < 0)) {
      if (g2 !== g1) {
        const zeroCross = s1 + (0 - g1) * (s2 - s1) / (g2 - g1);
        crossings.push({
          strike: zeroCross,
          dist: Math.abs(zeroCross - spotPrice),
        });
      }
    }
  }

  if (crossings.length === 0) return null;

  // Return the crossing closest to the current spot price
  crossings.sort((a, b) => a.dist - b.dist);
  return Math.round(crossings[0].strike * 100) / 100;
}

/**
 * Computes the GEX regime from per-strike GEX data.
 *
 * Regime determination:
 *   - Near zero (|netGEX| < 5% of total absolute GEX) → "Neutral"
 *   - Local flip point available:
 *       - Spot >= Flip Point → "Low Volatility" (Positive Gamma)
 *       - Spot < Flip Point → "High Volatility" (Negative Gamma)
 *   - Fallback (no local flip point):
 *       - Positive net GEX → "Low Volatility"
 *       - Negative net GEX → "High Volatility"
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
  } else if (flipPoint !== null) {
    // Determine regime relative to the closest local flip point
    if (spotPrice >= flipPoint) {
      regime = 'positive';
      label = 'Low Volatility';
    } else {
      regime = 'negative';
      label = 'High Volatility';
    }
  } else {
    // Fallback if no flip point can be calculated
    if (totalNetGEX > 0) {
      regime = 'positive';
      label = 'Low Volatility';
    } else {
      regime = 'negative';
      label = 'High Volatility';
    }
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
