/**
 * Wall Service
 *
 * Computes put/call walls from raw expiration data using simple
 * weighted scoring.
 *
 * Scoring formula: score = weighted_OI × 0.7 + weighted_Vol × 0.3
 *   where weights include time decay: timeWeight = 1 / (1 + DTE / 7)
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
      .filter(([strike, data]) => filterFn(strike) && (data.oi > 0 || data.vol > 0));

    if (entries.length === 0) return [];

    // Score: simple weighted OI + Volume
    const scored = entries.map(([strike, data]) => {
      const rawScore = data.oi * 0.7 + data.vol * 0.3;
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
