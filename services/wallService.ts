/**
 * Wall Service
 *
 * Computes put/call walls from raw expiration data with the unified scoring
 * formula (Python <-> TS parity, see docs/python-ts-parity.md):
 *
 *   score = (own_oi · w_oi + own_vol · w_vol) · exp(-|dist%| / 2.0)
 *
 *   where w_oi/w_vol depend on the nearest DTE bucket (0DTE trusts volume,
 *   long DTE trusts OI), and the Laplacian distance decay keeps an intraday
 *   focus without zeroing far structural levels. The same time decay
 *   (timeWeight = 1 / (1 + DTE / 7)) is applied during aggregation.
 *
 * Returns max 7 walls per side, normalized to 0-100.
 *
 * @module services/wallService
 */

import { Wall } from '../types';
import { RawExpiry } from './gexService';
import { estimateGamma } from '../utils/gammaEstimate';

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTRACT_SIZE = 100;
const MAX_WALLS_PER_SIDE = 7;

// ---------------------------------------------------------------------------
// Unified wall scoring (Python <-> TypeScript parity)
// ---------------------------------------------------------------------------
//
// Wall "importance" = own-side activity × distance weight, where:
//
//   own_activity    = OI·w_oi + Vol·w_vol     (DTE-dependent bucket)
//   distance_weight = exp(-|dist%| / 2.0)      (Laplacian, lambda = 2%)
//
// Design rationale (see docs/python-ts-parity.md):
//   - Laplacian decay gives a sharp intraday focus (ATM = 1.0, ±2% ≈ 0.37)
//     WITHOUT zeroing out far structural levels (±5% ≈ 0.08, ±8% ≈ 0.02):
//     a giant wall at -4% still surfaces if its OI justifies it.
//   - The old "no proximity decay" version ranked a +4% wall above a +0.5%
//     wall purely on OI, which is wrong for day trading.
//
// DTE-dependent OI/Vol weighting: at 0DTE the OI is noisy (forms and
// dissolves intraday), so volume is the trustworthy signal; at long DTE the
// OI is structural and dominates.
const WALL_DISTANCE_LAMBDA = 2.0;   // % distance scale for the Laplacian decay

/** Returns the (oi_weight, vol_weight) tuple for the given nearest DTE bucket. */
function wallDteWeights(nearestDTE: number): [number, number] {
  if (nearestDTE === 0) return [0.25, 0.75];
  if (nearestDTE <= 3) return [0.50, 0.50];
  return [0.70, 0.30];
}

/**
 * Unified wall importance score. MUST match Python
 * `scripts/fetch_options_data.py:compute_wall_score`.
 *
 *   score = (own_oi·w_oi + own_vol·w_vol) · exp(-|dist%| / lambda)
 *
 * Returns the RAW score (pre-normalization). Callers normalize to 0-100.
 */
export function computeWallScore(
  ownOI: number,
  ownVol: number,
  nearestDTE: number,
  strike: number,
  spot: number,
): number {
  const [oiWeight, volWeight] = wallDteWeights(nearestDTE);
  const ownActivity = ownOI * oiWeight + ownVol * volWeight;
  const distPct = spot > 0 ? (Math.abs(strike - spot) / spot) * 100 : 0;
  const distanceWeight = Math.exp(-distPct / WALL_DISTANCE_LAMBDA);
  return ownActivity * distanceWeight;
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface StrikeAggregate {
  oi: number;
  vol: number;
  gex: number;
  nearestExpiry: string;
  nearestDTE: number;
}

// ============================================================================
// WALL COMPUTATION
// ============================================================================

/**
 * Computes put and call walls from raw expiry data.
 *
 * Aggregates OI and Volume per strike across all expirations (with time-decay
 * weighting), computes a simple score, and selects walls below/above spot.
 *
 * Scores are normalized to 0-100 across both sides.
 */
export function computeWalls(
  expiries: RawExpiry[],
  spotPrice: number,
  generatedAt?: string,
  symbol?: string
): { putWalls: Wall[]; callWalls: Wall[] } {
  const putMap = new Map<number, StrikeAggregate>();
  const callMap = new Map<number, StrikeAggregate>();

  for (const expiry of expiries) {
    const expiryDate = new Date(expiry.date);
    const now = generatedAt ? new Date(generatedAt) : new Date();
    const dte = Math.max(0, Math.ceil(
      (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    ));
    const timeWeight = 1 / (1 + dte / 7);

    for (const opt of expiry.options) {
      const map = opt.side === 'PUT' ? putMap : callMap;
      const existing = map.get(opt.strike) || {
        oi: 0, vol: 0, gex: 0,
        nearestExpiry: expiry.date,
        nearestDTE: dte,
      };

      existing.oi += opt.oi * timeWeight;
      existing.vol += opt.vol * timeWeight;

      // Track nearest expiry
      if (dte < existing.nearestDTE) {
        existing.nearestExpiry = expiry.date;
        existing.nearestDTE = dte;
      }

      // Compute GEX
      const gamma = opt.gamma || estimateGamma({
        spot: spotPrice,
        strike: opt.strike,
        dte,
        isCall: opt.side === 'CALL',
        symbol,
      });
      const sign = opt.side === 'CALL' ? 1 : -1;
      existing.gex += opt.oi * gamma * CONTRACT_SIZE * spotPrice * spotPrice * sign * timeWeight;

      map.set(opt.strike, existing);
    }
  }

  function computeTopWalls(
    ownMap: Map<number, StrikeAggregate>,
    wallType: 'put_wall' | 'call_wall',
    filterFn: (strike: number) => boolean,
    oppositeMap: Map<number, StrikeAggregate>,
  ): Wall[] {
    const entries = Array.from(ownMap.entries())
      .filter(([strike, data]) => {
        if (!filterFn(strike)) return false;
        if (data.oi <= 0 && data.vol <= 0) return false;
        // Strike-range validation: reject strikes outside 30%-300% of spot
        const ratio = strike / spotPrice;
        if (ratio < 0.3 || ratio > 3.0) return false;
        return true;
      });

    if (entries.length === 0) return [];

    // Score: unified formula (own activity × Laplacian distance decay).
    // See computeWallScore above. The old code computed own_activity inline
    // and applied NO distance decay — which over-weighted far strikes.
    const scored = entries.map(([strike, data]) => {
      const rawScore = computeWallScore(data.oi, data.vol, data.nearestDTE, strike, spotPrice);
      const crossData = oppositeMap.get(strike);
      const distance = spotPrice > 0
        ? Math.round((Math.abs(strike - spotPrice) / spotPrice) * 10000) / 100
        : 0;
      return {
        strike,
        rawScore,
        type: wallType,
        score: 0, // placeholder, normalized below
        totalOI: data.oi,
        totalVolume: data.vol,
        callOI: wallType === 'call_wall' ? data.oi : (crossData?.oi ?? 0),
        callVolume: wallType === 'call_wall' ? data.vol : (crossData?.vol ?? 0),
        putOI: wallType === 'put_wall' ? data.oi : (crossData?.oi ?? 0),
        putVolume: wallType === 'put_wall' ? data.vol : (crossData?.vol ?? 0),
        netGEX: data.gex + (crossData?.gex ?? 0),
        distance,
        nearestExpiry: data.nearestExpiry,
      };
    });

    // Sort by raw score descending
    scored.sort((a, b) => b.rawScore - a.rawScore);

    // Take top N
    const top = scored.slice(0, MAX_WALLS_PER_SIDE);

    // Normalize scores to 0-100
    const maxScore = Math.max(...top.map(s => s.rawScore), 0);
    for (const s of top) {
      s.score = maxScore > 0
        ? Math.round((s.rawScore / maxScore) * 1000) / 10
        : 0;
    }

    // Return without rawScore helper field
    return top.map(({ rawScore: _rs, ...wall }) => wall);
  }

  // Put walls: strikes at or below spot price (supports)
  const putWalls = computeTopWalls(putMap, 'put_wall', (strike) => strike <= spotPrice, callMap);
  // Call walls: strikes at or above spot price (resistances)
  const callWalls = computeTopWalls(callMap, 'call_wall', (strike) => strike >= spotPrice, putMap);

  return { putWalls, callWalls };
}
