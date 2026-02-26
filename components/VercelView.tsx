/**
 * VercelView Component
 *
 * A public-facing component for the Vercel site that displays
 * options levels and quantitative metrics with a 4-tab system
 * for SPY, QQQ, SPX, and NDX symbols.
 *
 * Now includes complete quantitative analysis matching QuantPanel.
 *
 * @module components/VercelView
 */

import React, { useState, useEffect, useMemo, ReactElement } from 'react';
import {
  VercelOptionsData,
  fetchVercelOptionsData,
  getSymbolData,
  getLastUpdateTime,
  getDataAgeMinutes
} from '../services/vercelDataService';
import { SymbolData, ExpiryData, OptionData, QuantMetrics, PutCallRatios, VolatilitySkew, GEXData, SelectedLevels, AIAnalysis, AILevel, AIOutlook } from '../types';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Available symbols for the tab system
 */
const SYMBOLS = ['SPY', 'QQQ', 'SPX', 'NDX'] as const;
type Symbol = typeof SYMBOLS[number];

/**
 * Expiry type labels for display
 */
const EXPIRY_LABELS: Record<string, string> = {
  '0DTE': '0DTE (Today)',
  'WEEKLY': 'Weekly',
  'MONTHLY': 'Monthly',
};

// Tooltips for metrics
const TOOLTIPS = {
  gammaFlip: `Gamma Flip - Gamma Inversion Point

WHAT IT IS: The price where cumulative gamma exposure shifts from positive to negative.

HOW TO USE IT:
• If price > Gamma Flip: dealers buy on rallies (bullish support)
• If price < Gamma Flip: dealers sell on drops (bearish pressure)
• Closer to current price = higher probability of directional movement

STRATEGY: Key level to understand market direction.`,

  totalGex: `Total GEX - Total Gamma Exposure

WHAT IT IS: Sum of all dealer gamma exposure in billions of dollars.

HOW TO USE IT:
• GEX > 0 (positive): Stable market, dealers absorb volatility
• GEX < 0 (negative): Volatile market, dealers amplify movements
• |GEX| > 5B = significant impact

STRATEGY: Negative GEX = avoid large positions, use tight stop losses.`,

  maxPain: `Max Pain - Maximum Trader Pain

WHAT IT IS: The strike price where total option value at expiration is minimal.

HOW TO USE IT:
• Market makers push price toward this level
• Distance < 2% from spot = strong magnetic attraction

STRATEGY: If price is far from Max Pain, expect a move toward it.`,

  pcrOiBased: `Put/Call Ratio based on Open Interest

WHAT IT IS: Ratio between Put OI and Call OI.
• PCR > 1.0 = bearish sentiment
• PCR < 0.7 = bullish sentiment
• Extreme PCR (>1.5 or <0.5) = possible contrarian reversal`,

  pcrVolume: `Put/Call Ratio based on Volume

WHAT IT IS: Ratio between today's put and call volume.
• Volume PCR > OI PCR = increased put activity (new fear)
• Volume PCR < OI PCR = increased call activity (new optimism)`,

  pcrWeighted: `Weighted Put/Call Ratio

WHAT IT IS: PCR weighted by volume. Gives more weight to options with high activity.
• More sensitive to ATM and near-term options`,

  pcrDeltaAdj: `Delta-Adjusted Put/Call Ratio

WHAT IT IS: PCR weighted by option delta.
• The most sophisticated for professional risk analysis.`,

  skewType: `Volatility Skew Type

WHAT IT IS: The shape of the implied volatility curve.
• SMIRK: Expensive puts = fear, defensive market
• REVERSE SMIRK: Expensive calls = euphoria, aggressive market`,

  skewRatio: `Skew Ratio - Put/Call IV Ratio

WHAT IT IS: Ratio between average OTM put and call implied volatility.
• Ratio > 1.2 = BEARISH SKEW
• Ratio < 0.9 = BULLISH SKEW`
};

// ============================================================================
// QUANTITATIVE CALCULATION FUNCTIONS (Ported from Python)
// ============================================================================

/**
 * Calculate Black-Scholes gamma
 */
function calculateBlackScholesGamma(spot: number, strike: number, T: number, r: number, iv: number): number {
  if (iv <= 0 || T <= 0 || spot <= 0) {
    return 0.0;
  }

  try {
    const d1 = (Math.log(spot / strike) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
    const gamma = Math.exp(-0.5 * d1 * d1) / (spot * iv * Math.sqrt(2 * Math.PI * T));
    return gamma;
  } catch {
    return 0.0;
  }
}

/**
 * Calculate time to expiry in years
 */
function calculateTimeToExpiry(expiryDate: string): number {
  try {
    const expiry = new Date(expiryDate);
    const now = new Date();
    const days = Math.max(Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)), 1);
    return days / 365.0;
  } catch {
    return 1 / 365.0;
  }
}

/**
 * Calculate Total Gamma Exposure
 */
function calculateTotalGEX(options: OptionData[], spot: number, T: number, r: number = 0.05): number {
  let totalGex = 0.0;

  for (const opt of options) {
    const oi = opt.oi || 0;
    const iv = opt.iv || 0.3;
    const strike = opt.strike || 0;

    if (oi <= 0 || strike <= 0) continue;

    const gamma = calculateBlackScholesGamma(spot, strike, T, r, iv);
    let gex = gamma * oi * 100 * spot * spot * 0.01;

    // Call GEX is positive, Put GEX is negative
    if (opt.side === 'PUT') {
      gex = -gex;
    }

    totalGex += gex;
  }

  return totalGex / 1e9; // Convert to billions
}

/**
 * Calculate Gamma Flip level
 */
function calculateGammaFlip(options: OptionData[], spot: number, T: number, r: number = 0.05): number {
  // Group options by strike
  const strikesData: Map<number, { callOi: number; putOi: number; callIv: number; putIv: number }> = new Map();

  for (const opt of options) {
    const strike = opt.strike;
    if (strike <= 0) continue;

    if (!strikesData.has(strike)) {
      strikesData.set(strike, { callOi: 0, putOi: 0, callIv: 0.3, putIv: 0.3 });
    }

    const data = strikesData.get(strike)!;
    if (opt.side === 'CALL') {
      data.callOi = opt.oi || 0;
      data.callIv = opt.iv || 0.3;
    } else {
      data.putOi = opt.oi || 0;
      data.putIv = opt.iv || 0.3;
    }
  }

  if (strikesData.size === 0) return spot;

  // Calculate cumulative GEX by strike
  let cumulativeGex = 0.0;
  const gexByStrike: [number, number][] = [];

  const sortedStrikes = Array.from(strikesData.keys()).sort((a, b) => a - b);

  for (const strike of sortedStrikes) {
    const data = strikesData.get(strike)!;

    const callGamma = calculateBlackScholesGamma(spot, strike, T, r, data.callIv);
    const putGamma = calculateBlackScholesGamma(spot, strike, T, r, data.putIv);

    const callGex = callGamma * data.callOi * 100 * spot * spot * 0.01;
    const putGex = -putGamma * data.putOi * 100 * spot * spot * 0.01;

    const gex = (callGex + putGex) / 1e9;
    cumulativeGex += gex;
    gexByStrike.push([strike, cumulativeGex]);
  }

  // Find flip point
  let gammaFlip = spot;
  for (let i = 1; i < gexByStrike.length; i++) {
    const prevGex = gexByStrike[i - 1][1];
    const currGex = gexByStrike[i][1];

    // If sign changes, we have a flip
    if (prevGex * currGex < 0) {
      const prevStrike = gexByStrike[i - 1][0];
      const currStrike = gexByStrike[i][0];
      gammaFlip = (prevStrike + currStrike) / 2;
      break;
    }
  }

  return gammaFlip;
}

/**
 * Calculate Max Pain level
 */
function calculateMaxPain(options: OptionData[], spot: number): number {
  if (options.length === 0) return spot;

  // Group by strike
  const strikesData: Map<number, { callOi: number; putOi: number }> = new Map();

  for (const opt of options) {
    const strike = opt.strike;
    if (strike <= 0) continue;

    if (!strikesData.has(strike)) {
      strikesData.set(strike, { callOi: 0, putOi: 0 });
    }

    const data = strikesData.get(strike)!;
    if (opt.side === 'CALL') {
      data.callOi = opt.oi || 0;
    } else {
      data.putOi = opt.oi || 0;
    }
  }

  if (strikesData.size === 0) return spot;

  // Test each strike as possible expiration price
  const testStrikes = Array.from(strikesData.keys()).sort((a, b) => a - b);
  let minValue = Infinity;
  let maxPain = spot;

  for (const testStrike of testStrikes) {
    let totalValue = 0;

    for (const [strike, data] of strikesData) {
      // Call value at expiration = max(0, testStrike - strike) * callOi
      const callValue = Math.max(0, testStrike - strike) * data.callOi;
      // Put value at expiration = max(0, strike - testStrike) * putOi
      const putValue = Math.max(0, strike - testStrike) * data.putOi;
      totalValue += (callValue + putValue) * 100;
    }

    if (totalValue < minValue) {
      minValue = totalValue;
      maxPain = testStrike;
    }
  }

  return maxPain;
}

/**
 * Calculate Put/Call Ratios
 */
function calculatePutCallRatios(options: OptionData[]): PutCallRatios {
  let callOi = 0;
  let putOi = 0;
  let callVol = 0;
  let putVol = 0;
  let weightedCallOi = 0;
  let weightedPutOi = 0;
  let deltaAdjCall = 0;
  let deltaAdjPut = 0;

  for (const opt of options) {
    const oi = opt.oi || 0;
    const vol = opt.vol || 0;
    const iv = opt.iv || 0.3;
    const strike = opt.strike;

    if (opt.side === 'CALL') {
      callOi += oi;
      callVol += vol;
      weightedCallOi += oi * vol;
      // Approximate delta for OTM calls
      const deltaApprox = Math.exp(-0.5 * Math.pow(Math.log(1 + iv), 2));
      deltaAdjCall += oi * deltaApprox;
    } else {
      putOi += oi;
      putVol += vol;
      weightedPutOi += oi * vol;
      // Approximate delta for OTM puts
      const deltaApprox = Math.exp(-0.5 * Math.pow(Math.log(1 + iv), 2));
      deltaAdjPut += oi * deltaApprox;
    }
  }

  return {
    oi_based: callOi > 0 ? putOi / callOi : 0,
    volume_based: callVol > 0 ? putVol / callVol : 0,
    weighted: weightedCallOi > 0 ? weightedPutOi / weightedCallOi : 0,
    delta_adjusted: deltaAdjCall > 0 ? deltaAdjPut / deltaAdjCall : 0
  };
}

/**
 * Calculate Volatility Skew
 */
function calculateVolatilitySkew(options: OptionData[], spot: number): VolatilitySkew {
  const otmLower = spot * 0.95;
  const otmUpper = spot * 1.05;

  let putIvSum = 0;
  let putCount = 0;
  let callIvSum = 0;
  let callCount = 0;

  for (const opt of options) {
    const strike = opt.strike;
    const iv = opt.iv;

    if (opt.side === 'PUT' && strike < otmUpper) {
      // OTM puts (below spot)
      putIvSum += iv;
      putCount++;
    } else if (opt.side === 'CALL' && strike > otmLower) {
      // OTM calls (above spot)
      callIvSum += iv;
      callCount++;
    }
  }

  const putIvAvg = putCount > 0 ? putIvSum / putCount : 0;
  const callIvAvg = callCount > 0 ? callIvSum / callCount : 0;
  const skewRatio = callIvAvg > 0 ? putIvAvg / callIvAvg : 1;

  // Determine skew type
  let skewType: 'smirk' | 'reverse_smirk' | 'flat' = 'flat';
  let sentiment: 'bearish' | 'bullish' | 'neutral' = 'neutral';

  if (skewRatio > 1.15) {
    skewType = 'smirk';
    sentiment = 'bearish';
  } else if (skewRatio < 0.9) {
    skewType = 'reverse_smirk';
    sentiment = 'bullish';
  }

  return {
    put_iv_avg: putIvAvg,
    call_iv_avg: callIvAvg,
    skew_ratio: skewRatio,
    skew_type: skewType,
    sentiment
  };
}

/**
 * Calculate GEX by strike
 */
function calculateGexByStrike(options: OptionData[], spot: number, T: number, r: number = 0.05): GEXData[] {
  // Group options by strike
  const strikesData: Map<number, { callOi: number; putOi: number; callIv: number; putIv: number }> = new Map();

  for (const opt of options) {
    const strike = opt.strike;
    if (strike <= 0) continue;

    if (!strikesData.has(strike)) {
      strikesData.set(strike, { callOi: 0, putOi: 0, callIv: 0.3, putIv: 0.3 });
    }

    const data = strikesData.get(strike)!;
    if (opt.side === 'CALL') {
      data.callOi = opt.oi || 0;
      data.callIv = opt.iv || 0.3;
    } else {
      data.putOi = opt.oi || 0;
      data.putIv = opt.iv || 0.3;
    }
  }

  const sortedStrikes = Array.from(strikesData.keys()).sort((a, b) => a - b);
  let cumulativeGex = 0;
  const result: GEXData[] = [];

  for (const strike of sortedStrikes) {
    const data = strikesData.get(strike)!;

    const callGamma = calculateBlackScholesGamma(spot, strike, T, r, data.callIv);
    const putGamma = calculateBlackScholesGamma(spot, strike, T, r, data.putIv);

    const callGex = callGamma * data.callOi * 100 * spot * spot * 0.01;
    const putGex = -putGamma * data.putOi * 100 * spot * spot * 0.01;

    const gex = (callGex + putGex) / 1e9;
    cumulativeGex += gex;

    result.push({
      strike,
      gex,
      cumulative_gex: cumulativeGex
    });
  }

  return result;
}

/**
 * Calculate all quantitative metrics for an expiry
 */
function calculateAllQuantMetrics(options: OptionData[], spot: number, expiryDate: string): QuantMetrics {
  const T = calculateTimeToExpiry(expiryDate);
  const r = 0.05;

  return {
    gamma_flip: calculateGammaFlip(options, spot, T, r),
    total_gex: calculateTotalGEX(options, spot, T, r),
    max_pain: calculateMaxPain(options, spot),
    put_call_ratios: calculatePutCallRatios(options),
    volatility_skew: calculateVolatilitySkew(options, spot),
    gex_by_strike: calculateGexByStrike(options, spot, T, r)
  };
}

/**
 * Calculate aggregated metrics across all expiries
 */
function calculateAggregatedMetrics(expiries: ExpiryData[], spot: number): QuantMetrics | null {
  if (expiries.length === 0) return null;

  // Combine all options
  const allOptions: OptionData[] = [];
  for (const expiry of expiries) {
    allOptions.push(...expiry.options);
  }

  // Use first expiry date for T calculation
  const firstExpiryDate = expiries[0]?.date || new Date().toISOString().split('T')[0];

  return calculateAllQuantMetrics(allOptions, spot, firstExpiryDate);
}

/**
 * Calculate sentiment based on metrics
 */
function calculateSentiment(metrics: QuantMetrics): 'bullish' | 'bearish' | 'neutral' {
  let score = 0;

  // GEX contribution
  if (metrics.total_gex > 0) score += 1;
  else if (metrics.total_gex < 0) score -= 1;

  // PCR contribution
  if (metrics.put_call_ratios.oi_based < 0.7) score += 1;
  else if (metrics.put_call_ratios.oi_based > 1.2) score -= 1;

  // Skew contribution
  if (metrics.volatility_skew.sentiment === 'bullish') score += 1;
  else if (metrics.volatility_skew.sentiment === 'bearish') score -= 1;

  if (score >= 2) return 'bullish';
  if (score <= -2) return 'bearish';
  return 'neutral';
}

// ============================================================================
// IMPROVED FALLBACK LEVEL GENERATION SYSTEM
// ============================================================================

/**
 * Wall type classification based on OI + Volume analysis
 */
type WallType = 'DOMINANT' | 'MODERATE' | 'WEAK' | 'ANOMALY';

interface ScoredLevel {
  strike: number;
  score: number;
  wallType: WallType;
  oi: number;
  volume: number;
  iv: number;
  distancePct: number;
  side: 'CALL' | 'PUT';
}

interface ConfluenceLevel {
  strike: number;
  expiries: string[];
  score: number;
  avgOi: number;
  avgVolume: number;
}

/**
 * Calculate multi-factor score for a level
 * Scoring weights: OI 35% + Volume 30% + IV 15% + Proximity 20%
 */
function calculateLevelScore(
  oi: number,
  volume: number,
  iv: number,
  distanceFromSpot: number,
  maxOi: number,
  maxVolume: number
): number {
  // Normalize each factor to 0-100 scale
  const oiScore = maxOi > 0 ? (oi / maxOi) * 100 : 0;
  const volScore = maxVolume > 0 ? (volume / maxVolume) * 100 : 0;
  const ivScore = Math.min(iv * 100, 100); // IV is typically 0-1, cap at 100%
  
  // Proximity score: closer to spot = higher score (max at 0% distance, min at5%+ distance)
  const proximityScore = Math.max(0, 100 - Math.abs(distanceFromSpot) * 20);
  
  // Weighted combination: OI35% + Volume30% + IV15% + Proximity20%
  return oiScore * 0.35 + volScore * 0.30 + ivScore * 0.15 + proximityScore * 0.20;
}

/**
 * Classify wall type based on OI and Volume relative to peers
 */
function classifyWallType(oi: number, volume: number, avgOi: number, avgVolume: number): WallType {
  const oiRatio = avgOi > 0 ? oi / avgOi : 0;
  const volRatio = avgVolume > 0 ? volume / avgVolume : 0;
  const combinedRatio = (oiRatio + volRatio) / 2;
  
  // Check for anomaly: high IV but low OI/Volume (potential manipulation or data error)
  if (combinedRatio < 0.5) {
    return 'ANOMALY';
  }
  
  if (combinedRatio >= 2.0) {
    return 'DOMINANT';
  } else if (combinedRatio >= 1.0) {
    return 'MODERATE';
  } else {
    return 'WEAK';
  }
}

/**
 * Improved Call/Put Wall identification with multi-factor scoring
 * Returns walls classified by strength
 */
function calculateWallsEnhanced(
  options: OptionData[],
  spot: number,
  topN: number = 3
): {
  callWalls: ScoredLevel[];
  putWalls: ScoredLevel[];
} {
  // Filter valid options
  const callOptions = options.filter(opt => opt.side === 'CALL' && opt.strike > spot && opt.oi > 0);
  const putOptions = options.filter(opt => opt.side === 'PUT' && opt.strike < spot && opt.oi > 0);
  
  // Calculate max values for normalization
  const maxCallOi = Math.max(...callOptions.map(o => o.oi), 1);
  const maxCallVol = Math.max(...callOptions.map(o => o.vol), 1);
  const maxPutOi = Math.max(...putOptions.map(o => o.oi), 1);
  const maxPutVol = Math.max(...putOptions.map(o => o.vol), 1);
  
  // Calculate averages for classification
  const avgCallOi = callOptions.length > 0 ? callOptions.reduce((s, o) => s + o.oi, 0) / callOptions.length : 1;
  const avgCallVol = callOptions.length > 0 ? callOptions.reduce((s, o) => s + o.vol, 0) / callOptions.length : 1;
  const avgPutOi = putOptions.length > 0 ? putOptions.reduce((s, o) => s + o.oi, 0) / putOptions.length : 1;
  const avgPutVol = putOptions.length > 0 ? putOptions.reduce((s, o) => s + o.vol, 0) / putOptions.length : 1;
  
  // Score and sort call walls
  const scoredCalls: ScoredLevel[] = callOptions.map(opt => {
    const distancePct = spot > 0 ? ((opt.strike - spot) / spot) * 100 : 0;
    const score = calculateLevelScore(opt.oi, opt.vol, opt.iv, distancePct, maxCallOi, maxCallVol);
    const wallType = classifyWallType(opt.oi, opt.vol, avgCallOi, avgCallVol);
    return {
      strike: opt.strike,
      score,
      wallType,
      oi: opt.oi,
      volume: opt.vol,
      iv: opt.iv,
      distancePct,
      side: 'CALL' as const
    };
  }).sort((a, b) => b.score - a.score)
    .slice(0, topN);
  
  // Score and sort put walls
  const scoredPuts: ScoredLevel[] = putOptions.map(opt => {
    const distancePct = spot > 0 ? ((opt.strike - spot) / spot) * 100 : 0;
    const score = calculateLevelScore(opt.oi, opt.vol, opt.iv, distancePct, maxPutOi, maxPutVol);
    const wallType = classifyWallType(opt.oi, opt.vol, avgPutOi, avgPutVol);
    return {
      strike: opt.strike,
      score,
      wallType,
      oi: opt.oi,
      volume: opt.vol,
      iv: opt.iv,
      distancePct,
      side: 'PUT' as const
    };
  }).sort((a, b) => b.score - a.score)
    .slice(0, topN);
  
  return { callWalls: scoredCalls, putWalls: scoredPuts };
}

/**
 * Legacy compatibility wrapper for calculateWallsEnhanced
 */
function calculateWalls(options: OptionData[], spot: number, topN: number = 3): { callWalls: number[]; putWalls: number[] } {
  const enhanced = calculateWallsEnhanced(options, spot, topN);
  return {
    callWalls: enhanced.callWalls.map(w => w.strike),
    putWalls: enhanced.putWalls.map(w => w.strike)
  };
}

/**
 * Tolerance constants for level clustering
 */
const RESONANCE_TOLERANCE_PCT = 0.3; // ±0.3% for RESONANCE
const CONFLUENCE_TOLERANCE_PCT = 0.5; // ±0.5% for CONFLUENCE
const MAX_RESONANCE_LEVELS = 2;
const MAX_CONFLUENCE_LEVELS = 5;

/**
 * Cluster strikes within tolerance and return representative strike
 */
function clusterStrikes(strikes: number[], tolerancePct: number, spot: number): number[][] {
  if (strikes.length === 0) return [];
  
  const sorted = [...strikes].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let currentCluster = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const prevStrike = currentCluster[0];
    const currStrike = sorted[i];
    const tolerance = prevStrike * (tolerancePct / 100);
    
    if (Math.abs(currStrike - prevStrike) <= tolerance) {
      currentCluster.push(currStrike);
    } else {
      clusters.push(currentCluster);
      currentCluster = [currStrike];
    }
  }
  clusters.push(currentCluster);
  
  return clusters;
}

/**
 * Get representative strike from a cluster (weighted by OI)
 */
function getClusterRepresentative(
  cluster: number[],
  options: OptionData[]
): number {
  if (cluster.length === 1) return cluster[0];
  
  // Weight by OI
  let totalOi = 0;
  let weightedSum = 0;
  
  for (const strike of cluster) {
    const opt = options.find(o => o.strike === strike);
    const oi = opt?.oi || 0;
    weightedSum += strike * oi;
    totalOi += oi;
  }
  
  return totalOi > 0 ? weightedSum / totalOi : cluster[Math.floor(cluster.length / 2)];
}

/**
 * Find confluence levels with strict tolerance and limits
 * Uses ±0.5% tolerance and limits to max 5 levels
 */
function findConfluenceLevelsEnhanced(
  expiries: ExpiryData[],
  spot: number
): ConfluenceLevel[] {
  if (expiries.length < 2) return [];
  
  // Collect all options with expiry info
  const strikeData: Map<number, { expiries: string[]; oi: number[]; vol: number[] }> = new Map();
  
  for (const expiry of expiries) {
    const seenStrikes = new Set<number>();
    
    for (const opt of expiry.options) {
      if (seenStrikes.has(opt.strike)) continue;
      seenStrikes.add(opt.strike);
      
      if (!strikeData.has(opt.strike)) {
        strikeData.set(opt.strike, { expiries: [], oi: [], vol: [] });
      }
      const data = strikeData.get(opt.strike)!;
      data.expiries.push(expiry.label);
      data.oi.push(opt.oi);
      data.vol.push(opt.vol);
    }
  }
  
  // Filter to strikes appearing in exactly 2 expiries (not all - those are resonance)
  const totalExpiries = expiries.length;
  const confluenceStrikes: number[] = [];
  const strikeScores: Map<number, number> = new Map();
  
  const allOptions = expiries.flatMap(e => e.options);
  const maxOi = Math.max(...allOptions.map(o => o.oi), 1);
  const maxVol = Math.max(...allOptions.map(o => o.vol), 1);
  
  for (const [strike, data] of strikeData) {
    // Confluence: appears in 2+ expiries but NOT all (resonance is for all)
    if (data.expiries.length >= 2 && data.expiries.length < totalExpiries) {
      confluenceStrikes.push(strike);
      const avgOi = data.oi.reduce((a, b) => a + b, 0) / data.oi.length;
      const avgVol = data.vol.reduce((a, b) => a + b, 0) / data.vol.length;
      const distancePct = spot > 0 ? Math.abs((strike - spot) / spot) * 100 : 0;
      const score = calculateLevelScore(avgOi, avgVol, 0.3, distancePct, maxOi, maxVol);
      strikeScores.set(strike, score);
    }
  }
  
  // Cluster strikes within tolerance
  const clusters = clusterStrikes(confluenceStrikes, CONFLUENCE_TOLERANCE_PCT, spot);
  
  // Get representatives and score them
  const candidates: ConfluenceLevel[] = clusters.map(cluster => {
    const representative = getClusterRepresentative(cluster, allOptions);
    const originalData = strikeData.get(cluster[0])!;
    const avgScore = cluster.reduce((sum, s) => sum + (strikeScores.get(s) || 0), 0) / cluster.length;
    
    return {
      strike: representative,
      expiries: originalData.expiries,
      score: avgScore,
      avgOi: originalData.oi.reduce((a, b) => a + b, 0) / originalData.oi.length,
      avgVolume: originalData.vol.reduce((a, b) => a + b, 0) / originalData.vol.length
    };
  });
  
  // Sort by score and limit to MAX_CONFLUENCE_LEVELS
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONFLUENCE_LEVELS);
}

/**
 * Legacy compatibility wrapper for findConfluenceLevels
 */
function findConfluenceLevels(expiries: ExpiryData[], spot: number): Map<number, string[]> {
  const enhanced = findConfluenceLevelsEnhanced(expiries, spot);
  const result = new Map<number, string[]>();
  for (const level of enhanced) {
    result.set(level.strike, level.expiries);
  }
  return result;
}

/**
 * Find resonance levels with strict tolerance and limits
 * Uses ±0.3% tolerance and limits to max 2 levels
 */
function findResonanceLevelsEnhanced(
  expiries: ExpiryData[],
  spot: number
): ConfluenceLevel[] {
  if (expiries.length < 2) return [];
  
  // Collect strikes appearing in ALL expiries
  const strikeCounts: Map<number, { count: number; oi: number[]; vol: number[] }> = new Map();
  
  for (const expiry of expiries) {
    const seenStrikes = new Set<number>();
    
    for (const opt of expiry.options) {
      if (seenStrikes.has(opt.strike)) continue;
      seenStrikes.add(opt.strike);
      
      if (!strikeCounts.has(opt.strike)) {
        strikeCounts.set(opt.strike, { count: 0, oi: [], vol: [] });
      }
      const data = strikeCounts.get(opt.strike)!;
      data.count++;
      data.oi.push(opt.oi);
      data.vol.push(opt.vol);
    }
  }
  
  // Filter to strikes appearing in ALL expiries
  const totalExpiries = expiries.length;
  const resonanceStrikes: number[] = [];
  const strikeScores: Map<number, number> = new Map();
  
  const allOptions = expiries.flatMap(e => e.options);
  const maxOi = Math.max(...allOptions.map(o => o.oi), 1);
  const maxVol = Math.max(...allOptions.map(o => o.vol), 1);
  
  for (const [strike, data] of strikeCounts) {
    if (data.count === totalExpiries) {
      resonanceStrikes.push(strike);
      const avgOi = data.oi.reduce((a, b) => a + b, 0) / data.oi.length;
      const avgVol = data.vol.reduce((a, b) => a + b, 0) / data.vol.length;
      const distancePct = spot > 0 ? Math.abs((strike - spot) / spot) * 100 : 0;
      const score = calculateLevelScore(avgOi, avgVol, 0.3, distancePct, maxOi, maxVol);
      strikeScores.set(strike, score);
    }
  }
  
  // Cluster strikes within tolerance
  const clusters = clusterStrikes(resonanceStrikes, RESONANCE_TOLERANCE_PCT, spot);
  
  // Get representatives and score them
  const candidates: ConfluenceLevel[] = clusters.map(cluster => {
    const representative = getClusterRepresentative(cluster, allOptions);
    const originalData = strikeCounts.get(cluster[0])!;
    const avgScore = cluster.reduce((sum, s) => sum + (strikeScores.get(s) || 0), 0) / cluster.length;
    const expiryLabels = expiries.map(e => e.label);
    
    return {
      strike: representative,
      expiries: expiryLabels,
      score: avgScore,
      avgOi: originalData.oi.reduce((a, b) => a + b, 0) / originalData.oi.length,
      avgVolume: originalData.vol.reduce((a, b) => a + b, 0) / originalData.vol.length
    };
  });
  
  // Sort by score and limit to MAX_RESONANCE_LEVELS
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESONANCE_LEVELS);
}

/**
 * Legacy compatibility wrapper for findResonanceLevels
 */
function findResonanceLevels(expiries: ExpiryData[], spot: number): number[] {
  const enhanced = findResonanceLevelsEnhanced(expiries, spot);
  return enhanced.map(l => l.strike).sort((a, b) => a - b);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats a number as currency
 */
function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a number with appropriate precision
 */
function formatNumber(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined) return 'N/A';
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Formats GEX value in billions
 */
function formatGEX(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  const sign = value >= 0 ? '' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}B`;
}

/**
 * Gets top N options by open interest
 */
function getTopOptionsByOI(options: OptionData[], side: 'CALL' | 'PUT', limit: number = 5): OptionData[] {
  return options
    .filter(opt => opt.side === side)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, limit);
}

/**
 * Gets the display label for an expiry
 */
function getExpiryDisplayLabel(expiry: ExpiryData): string {
  const label = EXPIRY_LABELS[expiry.label] || expiry.label;
  return `${label} (${expiry.date})`;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

/**
 * Loading spinner component
 */
function LoadingSpinner(): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      <p className="mt-4 text-gray-400">Loading options data...</p>
    </div>
  );
}

/**
 * Error display component
 */
function ErrorDisplay({ message }: { message: string }): ReactElement {
  return (
    <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-6 text-center">
      <svg
        className="mx-auto h-12 w-12 text-red-500 mb-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <h3 className="text-lg font-semibold text-red-400 mb-2">Error Loading Data</h3>
      <p className="text-gray-400">{message}</p>
    </div>
  );
}

/**
 * Data age badge component
 */
function DataAgeBadge({ ageMinutes }: { ageMinutes: number }): ReactElement {
  let bgColor = 'bg-green-500/20 text-green-400';
  let text = 'Just updated';

  if (ageMinutes < 0) {
    bgColor = 'bg-gray-500/20 text-gray-400';
    text = 'Unknown';
  } else if (ageMinutes < 5) {
    bgColor = 'bg-green-500/20 text-green-400';
    text = `${ageMinutes} min ago`;
  } else if (ageMinutes < 30) {
    bgColor = 'bg-yellow-500/20 text-yellow-400';
    text = `${ageMinutes} min ago`;
  } else {
    bgColor = 'bg-red-500/20 text-red-400';
    text = `${ageMinutes} min ago`;
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${bgColor}`}>
      {text}
    </span>
  );
}

/**
 * Tab button component
 */
const TabButton: React.FC<{
  symbol: Symbol;
  isActive: boolean;
  onClick: () => void;
}> = ({ symbol, isActive, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200
        ${isActive
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
        }
      `}
    >
      {symbol}
    </button>
  );
};

/**
 * Metric Label component with tooltip
 */
const MetricLabel: React.FC<{
  label: string;
  tooltip: string;
  className?: string;
}> = ({ label, tooltip, className = '' }) => (
  <span
    title={tooltip}
    className={`cursor-help inline-flex items-center gap-1 ${className}`}
  >
    {label}
    <span
      className="text-[10px] text-gray-500 border border-gray-500 rounded-full w-3.5 h-3.5 inline-flex items-center justify-center font-bold hover:text-gray-300 hover:border-gray-300 transition-colors"
      style={{ fontSize: '9px', flexShrink: 0 }}
    >
      ?
    </span>
  </span>
);

/**
 * Quantitative Metrics Display Component (matching QuantPanel)
 */
const QuantMetricsDisplay: React.FC<{ metrics: QuantMetrics }> = ({ metrics }) => {
  const getGexColor = (gex: number) =>
    gex >= 0 ? 'text-green-400' : 'text-red-400';

  const getPcrColor = (pcr: number) =>
    pcr < 0.7 ? 'text-green-400' : pcr > 1.0 ? 'text-red-400' : 'text-yellow-400';

  const getSentimentColor = (sentiment: string) =>
    sentiment === 'bullish' ? 'text-green-400' :
    sentiment === 'bearish' ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="bg-gray-900/60 p-4 rounded-xl border border-gray-700/50 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xl">📊</span>
        <h3 className="text-base font-black text-white uppercase tracking-wider">Quantitative Metrics</h3>
      </div>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {/* Gamma Flip */}
        <div className="bg-black/40 p-3 rounded-lg border border-gray-800/50">
          <MetricLabel
            label="Gamma Flip"
            tooltip={TOOLTIPS.gammaFlip}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-indigo-400 font-mono block mt-1">
            ${metrics.gamma_flip?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
        </div>

        {/* Total GEX */}
        <div className="bg-black/40 p-3 rounded-lg border border-gray-800/50">
          <MetricLabel
            label="Total GEX"
            tooltip={TOOLTIPS.totalGex}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className={`text-xl font-black font-mono block mt-1 ${getGexColor(metrics.total_gex)}`}>
            {formatGEX(metrics.total_gex)}
          </span>
          {metrics.total_gex < 0 && (
            <span className="text-[10px] text-red-400/70 block">(negative)</span>
          )}
        </div>

        {/* Max Pain */}
        <div className="bg-black/40 p-3 rounded-lg border border-gray-800/50">
          <MetricLabel
            label="Max Pain"
            tooltip={TOOLTIPS.maxPain}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-amber-400 font-mono block mt-1">
            ${metrics.max_pain?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
        </div>
      </div>

      {/* Put/Call Ratios */}
      <div className="bg-black/30 p-3 rounded-lg border border-gray-800/40 mb-3">
        <span className="text-xs font-bold text-gray-400 uppercase block mb-3 tracking-widest">Put/Call Ratios</span>
        <div className="grid grid-cols-4 gap-3">
          <div className="text-center">
            <MetricLabel
              label="OI-Based"
              tooltip={TOOLTIPS.pcrOiBased}
              className="text-[11px] text-gray-400 block"
            />
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios.oi_based)}`}>
              {metrics.put_call_ratios.oi_based.toFixed(2)}
            </span>
          </div>
          <div className="text-center">
            <MetricLabel
              label="Volume"
              tooltip={TOOLTIPS.pcrVolume}
              className="text-[11px] text-gray-400 block"
            />
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios.volume_based)}`}>
              {metrics.put_call_ratios.volume_based.toFixed(2)}
            </span>
          </div>
          <div className="text-center">
            <MetricLabel
              label="Weighted"
              tooltip={TOOLTIPS.pcrWeighted}
              className="text-[11px] text-gray-400 block"
            />
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios.weighted)}`}>
              {metrics.put_call_ratios.weighted.toFixed(2)}
            </span>
          </div>
          <div className="text-center">
            <MetricLabel
              label="Delta-Adj"
              tooltip={TOOLTIPS.pcrDeltaAdj}
              className="text-[11px] text-gray-400 block"
            />
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios.delta_adjusted)}`}>
              {metrics.put_call_ratios.delta_adjusted.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Volatility Skew */}
      <div className="bg-black/30 p-3 rounded-lg border border-gray-800/40">
        <span className="text-xs font-bold text-gray-400 uppercase block mb-3 tracking-widest">Volatility Skew</span>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div>
              <MetricLabel
                label="Type"
                tooltip={TOOLTIPS.skewType}
                className="text-[11px] text-gray-400 block"
              />
              <span className="text-base font-bold text-white capitalize block mt-1">{metrics.volatility_skew.skew_type.replace('_', ' ')}</span>
            </div>
            <div>
              <MetricLabel
                label="Put IV"
                tooltip="Average OTM put implied volatility"
                className="text-[11px] text-gray-400 block"
              />
              <span className="text-base font-bold text-red-400 font-mono block mt-1">{(metrics.volatility_skew.put_iv_avg * 100).toFixed(0)}%</span>
            </div>
            <div>
              <MetricLabel
                label="Call IV"
                tooltip="Average OTM call implied volatility"
                className="text-[11px] text-gray-400 block"
              />
              <span className="text-base font-bold text-green-400 font-mono block mt-1">{(metrics.volatility_skew.call_iv_avg * 100).toFixed(0)}%</span>
            </div>
            <div>
              <MetricLabel
                label="Ratio"
                tooltip={TOOLTIPS.skewRatio}
                className="text-[11px] text-gray-400 block"
              />
              <span className="text-base font-bold text-gray-300 font-mono block mt-1">{metrics.volatility_skew.skew_ratio.toFixed(2)}</span>
            </div>
          </div>
          <div className="text-right">
            <span className={`text-sm font-black uppercase ${getSentimentColor(metrics.volatility_skew.sentiment)}`}>
              {metrics.volatility_skew.sentiment}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Level Row Component (matching QuantPanel LevelRow)
 */
const LevelRow: React.FC<{
  level: number;
  type: 'CALL_WALL' | 'PUT_WALL' | 'GAMMA_FLIP' | 'MAX_PAIN' | 'CONFLUENCE' | 'RESONANCE';
  spot: number;
  expiries?: string[];
  oi?: number;
  isMatch?: boolean;
  wallType?: WallType;
}> = ({ level, type, spot, expiries = [], oi, isMatch = false, wallType }) => {
  const distancePct = spot > 0 ? ((level - spot) / spot) * 100 : 0;
  const isVeryClose = Math.abs(distancePct) <= 0.6;

  const getTheme = () => {
    if (type === 'RESONANCE') return {
      border: 'border-amber-500/60',
      bg: 'bg-amber-500/10',
      label: 'bg-amber-500 text-black font-black',
      price: 'text-amber-400',
      icon: '💎',
      bar: 'from-amber-600 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.5)]',
      pulse: 'animate-pulse'
    };
    if (type === 'CONFLUENCE') return {
      border: 'border-violet-500/50',
      bg: 'bg-violet-500/10',
      label: 'bg-violet-500 text-white font-black',
      price: 'text-violet-300',
      icon: '✨',
      bar: 'from-violet-600 to-purple-400 shadow-[0_0_8px_rgba(139,92,246,0.4)]',
      pulse: ''
    };
    if (type === 'GAMMA_FLIP') return {
      border: 'border-indigo-500/40',
      bg: 'bg-indigo-950/20',
      label: 'bg-indigo-600 text-white',
      price: 'text-indigo-300',
      icon: '⚖️',
      bar: 'from-indigo-600 to-blue-400',
      pulse: ''
    };
    if (type === 'MAX_PAIN') return {
      border: 'border-amber-500/40',
      bg: 'bg-amber-950/20',
      label: 'bg-amber-600 text-white',
      price: 'text-amber-300',
      icon: '🎯',
      bar: 'from-amber-600 to-orange-400',
      pulse: ''
    };
    if (type === 'CALL_WALL') return {
      border: 'border-red-900/30',
      bg: 'bg-red-900/5',
      label: 'bg-red-500/10 text-red-400 border border-red-500/20',
      price: 'text-red-400',
      icon: '🛡️',
      bar: 'from-red-600 to-orange-500',
      pulse: ''
    };
    if (type === 'PUT_WALL') return {
      border: 'border-green-900/30',
      bg: 'bg-green-900/5',
      label: 'bg-green-500/10 text-green-400 border border-green-500/20',
      price: 'text-green-400',
      icon: '🛡️',
      bar: 'from-green-600 to-emerald-400',
      pulse: ''
    };
    return {
      border: 'border-gray-800',
      bg: 'bg-gray-800/10',
      label: 'bg-gray-700 text-gray-300',
      price: 'text-gray-300',
      icon: '📍',
      bar: 'from-gray-600 to-gray-400',
      pulse: ''
    };
  };

  const t = getTheme();

  const getLabel = () => {
    switch (type) {
      case 'RESONANCE': return 'RESONANCE';
      case 'CONFLUENCE': return 'CONFLUENCE';
      case 'GAMMA_FLIP': return 'GAMMA FLIP';
      case 'MAX_PAIN': return 'MAX PAIN';
      case 'CALL_WALL': return 'CALL WALL';
      case 'PUT_WALL': return 'PUT WALL';
      default: return type;
    }
  };

  const getDescription = () => {
    switch (type) {
      case 'RESONANCE': return 'Multi-expiry resonance level';
      case 'CONFLUENCE': return `Confluence: ${expiries.join(' + ')}`;
      case 'GAMMA_FLIP': return 'Gamma inversion point';
      case 'MAX_PAIN': return 'MM magnetic target';
      case 'CALL_WALL': return 'Main resistance';
      case 'PUT_WALL': return 'Main support';
      default: return '';
    }
  };

  const getImportance = () => {
    if (type === 'RESONANCE') return 95;
    if (type === 'CONFLUENCE') return 85;
    if (type === 'GAMMA_FLIP') return 80;
    if (type === 'MAX_PAIN') return 75;
    if (type === 'CALL_WALL' || type === 'PUT_WALL') return 70;
    return 50;
  };

  // Wall type badge color
  const getWallTypeBadge = () => {
    if (!wallType) return null;
    const colors: Record<WallType, string> = {
      'DOMINANT': 'bg-red-500 text-white',
      'MODERATE': 'bg-yellow-500 text-black',
      'WEAK': 'bg-gray-500 text-white',
      'ANOMALY': 'bg-purple-500 text-white'
    };
    return (
      <span className={`text-[8px] font-black px-1.5 py-0.5 rounded ${colors[wallType]}`}>
        {wallType}
      </span>
    );
  };

  return (
    <div
      className={`group relative p-4 rounded-xl border transition-all flex items-center justify-between gap-6
        ${t.bg} ${t.border} hover:scale-[1.01] hover:border-white/20
        ${isMatch ? 'ring-2 ring-cyan-500/50 bg-cyan-500/5' : ''}`}
    >
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-3 mb-2">
          <span className={`text-[10px] font-black uppercase tracking-tight px-2.5 py-0.5 rounded shadow-sm ${t.label} ${t.pulse}`}>
            {t.icon} {getLabel()}
          </span>
          {wallType && getWallTypeBadge()}
          {isMatch && (
            <span className="text-[8px] font-black text-cyan-400 bg-cyan-500/20 px-2 py-0.5 rounded border border-cyan-500/30">
              ✓ MATCH
            </span>
          )}
          {expiries.length > 0 && (
            <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">
              {expiries.join(' • ')}
            </span>
          )}
          {isVeryClose && (
            <span className="text-[8px] font-black text-white bg-indigo-600 px-2 py-0.5 rounded animate-pulse border border-indigo-400">PROXIMATE</span>
          )}
        </div>

        <div className="flex items-start gap-2 mb-1.5">
          <div className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isVeryClose ? 'bg-indigo-400 animate-ping' : 'bg-gray-600'}`} />
          <h4 className="text-[14px] font-black text-white uppercase tracking-tight leading-tight">
            {type === 'CALL_WALL' ? 'RESISTANCE' : type === 'PUT_WALL' ? 'SUPPORT' : getDescription()}
          </h4>
        </div>

        {oi !== undefined && oi > 0 && (
          <p className="text-[12px] font-medium text-gray-500 italic">
            OI: {oi.toLocaleString()}
          </p>
        )}

        <div className="flex items-center gap-3 mt-2">
          <div className="flex-grow h-2 bg-black/60 rounded-full border border-white/5 overflow-hidden">
            <div
              className={`h-full bg-gradient-to-r transition-all duration-1000 ease-out ${t.bar}`}
              style={{ width: `${getImportance()}%` }}
            ></div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest">Power</span>
            <span className={`text-[11px] font-black font-mono ${type === 'RESONANCE' ? 'text-amber-400' : type === 'CONFLUENCE' ? 'text-violet-300' : 'text-white'}`}>
              {getImportance()}%
            </span>
          </div>
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="flex flex-col items-end">
          <span className={`text-2xl font-black font-mono tracking-tighter ${t.price}`}>
            {level.toFixed(2)}
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-black font-mono ${distancePct > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {distancePct > 0 ? '+' : ''}{distancePct.toFixed(2)}%
            </span>
            <span className="text-[8px] font-bold text-gray-600 uppercase tracking-widest">DIST</span>
          </div>
          <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mt-1">Strike Price</span>
        </div>
      </div>
    </div>
  );
};

/**
 * Find matching strikes between AI and algorithmic levels
 * Returns a Set of rounded strike prices that match within 0.3% tolerance
 */
function findMatchingStrikes(
  aiLevels: AILevel[],
  algoLevels: Array<{ level: number }>,
  spot: number
): Set<number> {
  const matches = new Set<number>();
  const tolerance = spot * 0.003; // 0.3% tolerance

  for (const ai of aiLevels) {
    for (const algo of algoLevels) {
      if (Math.abs(ai.prezzo - algo.level) <= tolerance) {
        matches.add(Math.round(ai.prezzo));
        matches.add(Math.round(algo.level));
      }
    }
  }

  return matches;
}

/**
 * AI Level Row Component - Displays AI-generated levels with enhanced styling
 */
const AILevelRow: React.FC<{
  level: AILevel;
  spot: number;
  isMatch?: boolean;
}> = ({ level, spot, isMatch = false }) => {
  const distancePct = spot > 0 ? ((level.prezzo - spot) / spot) * 100 : 0;
  const isVeryClose = Math.abs(distancePct) <= 0.6;

  const getTheme = () => {
    if (level.ruolo === 'RESONANCE') return {
      border: 'border-amber-500/60',
      bg: 'bg-amber-500/10',
      label: 'bg-amber-500 text-black font-black',
      price: 'text-amber-400',
      icon: '💎',
      bar: 'from-amber-600 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.5)]',
      pulse: 'animate-pulse'
    };
    if (level.ruolo === 'CONFLUENCE') return {
      border: 'border-violet-500/50',
      bg: 'bg-violet-500/10',
      label: 'bg-violet-500 text-white font-black',
      price: 'text-violet-300',
      icon: '✨',
      bar: 'from-violet-600 to-purple-400 shadow-[0_0_8px_rgba(139,92,246,0.4)]',
      pulse: ''
    };
    if (level.ruolo === 'PIVOT') return {
      border: 'border-indigo-500/40',
      bg: 'bg-indigo-950/20',
      label: 'bg-indigo-600 text-white',
      price: 'text-indigo-300',
      icon: '⚖️',
      bar: 'from-indigo-600 to-blue-400',
      pulse: ''
    };
    if (level.ruolo === 'MAGNET') return {
      border: 'border-cyan-500/40',
      bg: 'bg-cyan-950/20',
      label: 'bg-cyan-600 text-white',
      price: 'text-cyan-300',
      icon: '🧲',
      bar: 'from-cyan-600 to-teal-400',
      pulse: ''
    };
    if (level.ruolo === 'WALL') return {
      border: level.lato === 'CALL' ? 'border-red-900/30' : 'border-green-900/30',
      bg: level.lato === 'CALL' ? 'bg-red-900/5' : 'bg-green-900/5',
      label: level.lato === 'CALL'
        ? 'bg-red-500/10 text-red-400 border border-red-500/20'
        : 'bg-green-500/10 text-green-400 border border-green-500/20',
      price: level.lato === 'CALL' ? 'text-red-400' : 'text-green-400',
      icon: '🛡️',
      bar: level.lato === 'CALL' ? 'from-red-600 to-orange-500' : 'from-green-600 to-emerald-400',
      pulse: ''
    };
    if (level.ruolo === 'FRICTION') return {
      border: 'border-orange-500/40',
      bg: 'bg-orange-950/20',
      label: 'bg-orange-600 text-white',
      price: 'text-orange-300',
      icon: '⚡',
      bar: 'from-orange-600 to-yellow-400',
      pulse: ''
    };
    return {
      border: 'border-gray-800',
      bg: 'bg-gray-800/10',
      label: 'bg-gray-700 text-gray-300',
      price: 'text-gray-300',
      icon: '📍',
      bar: 'from-gray-600 to-gray-400',
      pulse: ''
    };
  };

  const t = getTheme();

  return (
    <div
      className={`group relative p-4 rounded-xl border transition-all flex items-center justify-between gap-6
        ${t.bg} ${t.border} hover:scale-[1.01] hover:border-white/20
        ${isMatch ? 'ring-2 ring-cyan-500/50 bg-cyan-500/5' : ''}`}
    >
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-3 mb-2">
          <span className={`text-[10px] font-black uppercase tracking-tight px-2.5 py-0.5 rounded shadow-sm ${t.label} ${t.pulse}`}>
            {t.icon} {level.livello}
          </span>
          {isMatch && (
            <span className="text-[8px] font-black text-cyan-400 bg-cyan-500/20 px-2 py-0.5 rounded border border-cyan-500/30">
              ✓ MATCH
            </span>
          )}
          {level.scadenzaTipo && (
            <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">
              {level.scadenzaTipo}
            </span>
          )}
          {isVeryClose && (
            <span className="text-[8px] font-black text-white bg-indigo-600 px-2 py-0.5 rounded animate-pulse border border-indigo-400">PROXIMATE</span>
          )}
        </div>

        <div className="flex items-start gap-2 mb-1.5">
          <div className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isVeryClose ? 'bg-indigo-400 animate-ping' : 'bg-gray-600'}`} />
          <h4 className="text-[14px] font-black text-white uppercase tracking-tight leading-tight">
            {level.sintesiOperativa}
          </h4>
        </div>

        {/* Detailed AI reason/motivazione */}
        {level.motivazione && (
          <p className="text-[11px] text-gray-400 leading-relaxed mt-2 pl-3.5 border-l-2 border-gray-700/50">
            {level.motivazione}
          </p>
        )}

        <div className="flex items-center gap-3 mt-2">
          <div className="flex-grow h-2 bg-black/60 rounded-full border border-white/5 overflow-hidden">
            <div
              className={`h-full bg-gradient-to-r transition-all duration-1000 ease-out ${t.bar}`}
              style={{ width: `${level.importanza}%` }}
            ></div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest">Power</span>
            <span className={`text-[11px] font-black font-mono ${level.ruolo === 'RESONANCE' ? 'text-amber-400' : level.ruolo === 'CONFLUENCE' ? 'text-violet-300' : 'text-white'}`}>
              {level.importanza}%
            </span>
          </div>
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="flex flex-col items-end">
          <span className={`text-2xl font-black font-mono tracking-tighter ${t.price}`}>
            {level.prezzo.toFixed(2)}
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-black font-mono ${distancePct > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {distancePct > 0 ? '+' : ''}{distancePct.toFixed(2)}%
            </span>
            <span className="text-[8px] font-bold text-gray-600 uppercase tracking-widest">DIST</span>
          </div>
          <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mt-1">Strike Price</span>
        </div>
      </div>
    </div>
  );
};

/**
 * AI Outlook Display Component
 */
const AIOutlookDisplay: React.FC<{
  outlook: AIOutlook;
}> = ({ outlook }) => {
  const sentimentColor = outlook.sentiment === 'bullish' ? 'text-green-400' :
    outlook.sentiment === 'bearish' ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="space-y-4 mb-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
          <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">AI SENTIMENT</span>
          <span className={`text-lg font-black uppercase ${sentimentColor}`}>{outlook.sentiment}</span>
        </div>
        <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
          <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">GAMMA FLIP CLUSTER</span>
          <span className="text-lg font-black text-indigo-400">${outlook.gammaFlipZone.toFixed(2)}</span>
        </div>
      </div>
      <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30">
        <span className="text-[9px] font-bold text-gray-500 uppercase block mb-2 tracking-widest">VOLATILITY EXPECTATION</span>
        <span className="text-sm font-medium text-amber-400">{outlook.volatilityExpectation}</span>
      </div>
      <div className="bg-indigo-950/30 p-4 rounded-xl border border-indigo-500/30">
        <span className="text-[9px] font-bold text-indigo-400 uppercase block mb-2 tracking-widest">AI SUMMARY</span>
        <p className="text-sm text-gray-300 leading-relaxed">{outlook.summary}</p>
      </div>
    </div>
  );
};

/**
 * Sentiment Display Component
 */
const SentimentDisplay: React.FC<{
  sentiment: 'bullish' | 'bearish' | 'neutral';
  gammaFlipCluster: number;
}> = ({ sentiment, gammaFlipCluster }) => {
  const sentimentColor = sentiment === 'bullish' ? 'text-green-400' :
    sentiment === 'bearish' ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="grid grid-cols-2 gap-4 mb-4">
      <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
        <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">SENTIMENT</span>
        <span className={`text-lg font-black uppercase ${sentimentColor}`}>{sentiment}</span>
      </div>
      <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
        <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">GAMMA FLIP CLUSTER</span>
        <span className="text-lg font-black text-indigo-400">{gammaFlipCluster.toFixed(2)}</span>
      </div>
    </div>
  );
};

/**
 * Options Chart Component - Visual horizontal bar chart for OI and Volume
 */
function OptionsChart({
  callOptions,
  putOptions,
  spot
}: {
  callOptions: OptionData[];
  putOptions: OptionData[];
  spot: number;
}): ReactElement {
  const [hoveredBar, setHoveredBar] = useState<{type: 'CALL' | 'PUT'; option: OptionData; x: number; y: number} | null>(null);

  // If no options, show empty state
  if (callOptions.length === 0 && putOptions.length === 0) {
    return (
      <div className="bg-gray-800/30 rounded-lg p-8 text-center text-gray-500">
        No options data available
      </div>
    );
  }

  // Combine and sort all strikes for consistent Y-axis
  const allStrikes = new Set<number>();
  callOptions.forEach(opt => allStrikes.add(opt.strike));
  putOptions.forEach(opt => allStrikes.add(opt.strike));
  const sortedStrikes = Array.from(allStrikes).sort((a, b) => b - a); // Descending for Y-axis top-to-bottom

  // Find max values for scaling
  const maxOi = Math.max(
    ...callOptions.map(o => o.oi || 0),
    ...putOptions.map(o => o.oi || 0),
    1
  );
  const maxVol = Math.max(
    ...callOptions.map(o => o.vol || 0),
    ...putOptions.map(o => o.vol || 0),
    1
  );

  // Create lookup maps
  const callMap = new Map(callOptions.map(o => [o.strike, o]));
  const putMap = new Map(putOptions.map(o => [o.strike, o]));

  // Chart dimensions
  const barHeight = 24;
  const barGap = 4;
  const labelWidth = 80;
  const chartWidth = 200; // Width for each side (call/put)
  const chartHeight = sortedStrikes.length * (barHeight + barGap);

  // Handle mouse events for tooltips
  const handleMouseEnter = (type: 'CALL' | 'PUT', option: OptionData, event: React.MouseEvent) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setHoveredBar({
      type,
      option,
      x: event.clientX,
      y: event.clientY
    });
  };

  const handleMouseLeave = () => {
    setHoveredBar(null);
  };

  return (
    <div className="relative" onMouseLeave={handleMouseLeave}>
      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-gradient-to-r from-green-500 to-green-400"></div>
          <span className="text-xs text-gray-400">CALL (OI/Volume)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-gradient-to-r from-red-400 to-red-500"></div>
          <span className="text-xs text-gray-400">PUT (OI/Volume)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-yellow-400/30 border border-yellow-400"></div>
          <span className="text-xs text-gray-400">Spot: {formatCurrency(spot)}</span>
        </div>
      </div>

      {/* Chart Container */}
      <div className="overflow-x-auto">
        <div
          className="relative mx-auto"
          style={{
            width: `${labelWidth + chartWidth * 2 + 40}px`,
            minWidth: '100%'
          }}
        >
          {/* Center strike labels */}
          <div
            className="absolute left-0 top-0 flex flex-col justify-center"
            style={{
              width: `${labelWidth}px`,
              height: `${chartHeight}px`
            }}
          >
            {sortedStrikes.map((strike) => {
              const isSpot = Math.abs(strike - spot) < spot * 0.001;
              const isITM = strike < spot;
              return (
                <div
                  key={strike}
                  className={`flex items-center justify-end pr-2 text-xs font-mono ${
                    isSpot ? 'text-yellow-400 font-bold' : isITM ? 'text-gray-300' : 'text-gray-500'
                  }`}
                  style={{ height: `${barHeight + barGap}px` }}
                >
                  {formatCurrency(strike)}
                  {isSpot && <span className="ml-1 text-yellow-400">●</span>}
                </div>
              );
            })}
          </div>

          {/* CALL bars (left side) */}
          <div
            className="absolute flex flex-col justify-center"
            style={{
              left: `${labelWidth}px`,
              width: `${chartWidth}px`,
              height: `${chartHeight}px`
            }}
          >
            {sortedStrikes.map((strike) => {
              const opt = callMap.get(strike);
              if (!opt) {
                return <div key={strike} style={{ height: `${barHeight + barGap}px` }} />;
              }
              const oiWidth = (opt.oi / maxOi) * (chartWidth - 20);
              const volWidth = (opt.vol / maxVol) * (chartWidth - 20);
              
              return (
                <div
                  key={strike}
                  className="relative flex items-center justify-end"
                  style={{ height: `${barHeight + barGap}px`, width: '100%' }}
                >
                  {/* OI Bar */}
                  <div
                    className="absolute h-3 rounded-l-sm bg-gradient-to-l from-green-500 to-green-400 cursor-pointer transition-all hover:from-green-400 hover:to-green-300"
                    style={{
                      right: '0',
                      width: `${oiWidth}px`,
                      top: '2px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('CALL', opt, e)}
                  />
                  {/* Volume Bar (overlaid, semi-transparent) */}
                  <div
                    className="absolute h-2 rounded-l-sm bg-green-300/40 cursor-pointer transition-all hover:bg-green-300/60"
                    style={{
                      right: '0',
                      width: `${volWidth}px`,
                      top: '12px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('CALL', opt, e)}
                  />
                </div>
              );
            })}
          </div>

          {/* Center divider */}
          <div
            className="absolute bg-gray-600"
            style={{
              left: `${labelWidth + chartWidth}px`,
              width: '1px',
              height: `${chartHeight}px`
            }}
          />

          {/* PUT bars (right side) */}
          <div
            className="absolute flex flex-col justify-center"
            style={{
              left: `${labelWidth + chartWidth + 1}px`,
              width: `${chartWidth}px`,
              height: `${chartHeight}px`
            }}
          >
            {sortedStrikes.map((strike) => {
              const opt = putMap.get(strike);
              if (!opt) {
                return <div key={strike} style={{ height: `${barHeight + barGap}px` }} />;
              }
              const oiWidth = (opt.oi / maxOi) * (chartWidth - 20);
              const volWidth = (opt.vol / maxVol) * (chartWidth - 20);
              
              return (
                <div
                  key={strike}
                  className="relative flex items-center"
                  style={{ height: `${barHeight + barGap}px`, width: '100%' }}
                >
                  {/* OI Bar */}
                  <div
                    className="absolute h-3 rounded-r-sm bg-gradient-to-r from-red-400 to-red-500 cursor-pointer transition-all hover:from-red-300 hover:to-red-400"
                    style={{
                      left: '0',
                      width: `${oiWidth}px`,
                      top: '2px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('PUT', opt, e)}
                  />
                  {/* Volume Bar (overlaid, semi-transparent) */}
                  <div
                    className="absolute h-2 rounded-r-sm bg-red-300/40 cursor-pointer transition-all hover:bg-red-300/60"
                    style={{
                      left: '0',
                      width: `${volWidth}px`,
                      top: '12px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('PUT', opt, e)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {hoveredBar && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 text-sm pointer-events-none"
          style={{
            left: `${hoveredBar.x + 10}px`,
            top: `${hoveredBar.y + 10}px`,
            transform: 'translate(0, 0)'
          }}
        >
          <div className={`font-bold mb-1 ${hoveredBar.type === 'CALL' ? 'text-green-400' : 'text-red-400'}`}>
            {hoveredBar.type} @ {formatCurrency(hoveredBar.option.strike)}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
            <span className="text-gray-500">OI:</span>
            <span className="font-mono text-right">{formatNumber(hoveredBar.option.oi, 0)}</span>
            <span className="text-gray-500">Volume:</span>
            <span className="font-mono text-right">{formatNumber(hoveredBar.option.vol, 0)}</span>
            <span className="text-gray-500">IV:</span>
            <span className="font-mono text-right">{formatNumber(hoveredBar.option.iv * 100, 1)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Empty state when no symbol data is available
 */
const EmptySymbolState: React.FC<{ symbol: Symbol }> = ({ symbol }) => {
  return (
    <div className="bg-gray-800/30 rounded-lg p-8 text-center">
      <svg
        className="mx-auto h-12 w-12 text-gray-500 mb-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
      <h3 className="text-lg font-semibold text-gray-400 mb-2">No Data for {symbol}</h3>
      <p className="text-gray-500">
        Options data for {symbol} is not available at this time.
      </p>
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * VercelView - Public options data viewer with tabbed interface
 *
 * Features:
 * - 4-symbol tab system (SPY, QQQ, SPX, NDX)
 * - Complete quantitative analysis matching QuantPanel
 * - Sentiment, Gamma Flip, Walls, Confluence, Resonance
 * - Put/Call Ratios and Volatility Skew
 *
 * @returns JSX element
 */
export function VercelView(): ReactElement {
  // State management
  const [activeTab, setActiveTab] = useState<Symbol>('SPY');
  const [data, setData] = useState<VercelOptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // Timer tick to force age recalculation

  // Fetch data on mount
  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const result = await fetchVercelOptionsData();

        if (!isMounted) return;

        if (result) {
          setData(result);
        } else {
          setError('Unable to load options data. Please try again later.');
        }
      } catch (err) {
        if (!isMounted) return;

        setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  // Timer to update age display every minute
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  // Memoized values
  const activeSymbolData = useMemo(() => {
    if (!data) return null;
    return getSymbolData(data, activeTab);
  }, [data, activeTab]);

  const lastUpdateTime = useMemo(() => {
    if (!data) return 'Unknown';
    return getLastUpdateTime(data);
  }, [data]);

  const dataAgeMinutes = useMemo(() => {
    if (!data) return -1;
    return getDataAgeMinutes(data);
  }, [data, tick]); // Include tick to recalculate when time passes

  // Calculate quantitative analysis
  const quantAnalysis = useMemo(() => {
    if (!activeSymbolData || !activeSymbolData.expiries || activeSymbolData.expiries.length === 0) {
      return null;
    }

    const spot = activeSymbolData.spot;
    const expiries = activeSymbolData.expiries;
    const selectedLevels = activeSymbolData.selected_levels;
    const aiAnalysis = activeSymbolData.ai_analysis;

    // Combine all options for aggregated metrics
    const allOptions: OptionData[] = [];
    for (const expiry of expiries) {
      allOptions.push(...expiry.options);
    }

    // Calculate aggregated metrics (always needed for PCR, skew, etc.)
    const aggregatedMetrics = calculateAggregatedMetrics(expiries, spot);

    // Use selected_levels if available, otherwise calculate locally (fallback)
    let walls: { callWalls: number[]; putWalls: number[] };
    let confluenceLevels: Map<number, string[]>;
    let resonanceLevels: number[];

    if (selectedLevels) {
      // Use pre-selected levels from Python
      walls = {
        callWalls: selectedLevels.call_walls.map(w => w.strike),
        putWalls: selectedLevels.put_walls.map(w => w.strike)
      };
      
      // Convert confluence array to Map for compatibility
      confluenceLevels = new Map();
      for (const c of selectedLevels.confluence) {
        confluenceLevels.set(c.strike, ['MULTI']); // Generic label for pre-selected
      }
      
      resonanceLevels = selectedLevels.resonance.map(r => r.strike);
      
      // Override gamma_flip and max_pain in aggregatedMetrics if available
      if (aggregatedMetrics && selectedLevels.gamma_flip) {
        aggregatedMetrics.gamma_flip = selectedLevels.gamma_flip;
      }
      if (aggregatedMetrics && selectedLevels.max_pain) {
        aggregatedMetrics.max_pain = selectedLevels.max_pain;
      }
    } else {
      // Fallback: calculate locally
      walls = calculateWalls(allOptions, spot);
      confluenceLevels = findConfluenceLevels(expiries, spot);
      resonanceLevels = findResonanceLevels(expiries, spot);
    }

    // Calculate sentiment - prefer AI sentiment if available
    let sentiment: 'bullish' | 'bearish' | 'neutral';
    if (aiAnalysis?.outlook?.sentiment) {
      sentiment = aiAnalysis.outlook.sentiment;
    } else {
      sentiment = aggregatedMetrics ? calculateSentiment(aggregatedMetrics) : 'neutral';
    }

    // Override gamma_flip with AI value if available
    if (aiAnalysis?.outlook?.gammaFlipZone && aggregatedMetrics) {
      aggregatedMetrics.gamma_flip = aiAnalysis.outlook.gammaFlipZone;
    }

    // Get individual expiry metrics
    const expiryMetrics = expiries.map(expiry => {
      // Use pre-calculated metrics if available, otherwise calculate
      if (expiry.quantMetrics) {
        return { ...expiry, calculatedMetrics: expiry.quantMetrics };
      }
      const calculated = calculateAllQuantMetrics(expiry.options, spot, expiry.date);
      return { ...expiry, calculatedMetrics: calculated };
    });

    return {
      spot,
      aggregatedMetrics,
      walls,
      confluenceLevels,
      resonanceLevels,
      sentiment,
      expiryMetrics,
      allOptions,
      selectedLevels, // Pass through for displayLevels
      aiAnalysis // Pass through AI analysis
    };
  }, [activeSymbolData]);

  // Build AI levels array for display (when ai_analysis is available)
  const aiDisplayLevels = useMemo(() => {
    if (!quantAnalysis?.aiAnalysis?.levels) return null;

    const spot = quantAnalysis.spot;
    const aiLevels = quantAnalysis.aiAnalysis.levels;

    // Sort and split by spot
    const sorted = [...aiLevels].sort((a, b) => b.prezzo - a.prezzo);
    return {
      aboveSpot: sorted.filter(l => l.prezzo > spot),
      belowSpot: sorted.filter(l => l.prezzo <= spot)
    };
  }, [quantAnalysis]);

  // Build levels array for display (algorithmic fallback - always computed for comparison)
  const displayLevels = useMemo(() => {
    // Always compute algorithmic levels for side-by-side comparison
    if (!quantAnalysis) return { aboveSpot: [], belowSpot: [] };

    const levels: Array<{
      level: number;
      type: 'CALL_WALL' | 'PUT_WALL' | 'GAMMA_FLIP' | 'MAX_PAIN' | 'CONFLUENCE' | 'RESONANCE';
      expiries: string[];
      oi?: number;
    }> = [];

    const spot = quantAnalysis.spot;
    
    // Track used strikes to avoid duplicates (with ±0.5% tolerance for confluence matching)
    const usedStrikes = new Set<number>();
    const TOLERANCE_PCT = 0.5; // ±0.5% tolerance for strike matching
    
    // Helper function to check if a strike is already used (within tolerance)
    const isStrikeUsed = (strike: number): boolean => {
      for (const usedStrike of usedStrikes) {
        const tolerance = usedStrike * (TOLERANCE_PCT / 100);
        if (Math.abs(strike - usedStrike) <= tolerance) {
          return true;
        }
      }
      return false;
    };
    
    // Helper function to add strike to used set (rounded for consistency)
    const markStrikeUsed = (strike: number): void => {
      usedStrikes.add(Math.round(strike));
    };

    // Add Gamma Flip
    if (quantAnalysis.aggregatedMetrics) {
      levels.push({
        level: quantAnalysis.aggregatedMetrics.gamma_flip,
        type: 'GAMMA_FLIP',
        expiries: ['ALL']
      });

      // Add Max Pain
      levels.push({
        level: quantAnalysis.aggregatedMetrics.max_pain,
        type: 'MAX_PAIN',
        expiries: ['ALL']
      });
    }

    // 1. Add Resonance levels first (highest priority)
    for (const strike of quantAnalysis.resonanceLevels) {
      levels.push({
        level: strike,
        type: 'RESONANCE',
        expiries: ['0DTE', 'WEEKLY', 'MONTHLY']
      });
      markStrikeUsed(strike);
    }

    // 2. Add Confluence levels (skip if already added as resonance)
    for (const [strike, expiryList] of quantAnalysis.confluenceLevels) {
      // Skip if already added as resonance (check with tolerance)
      if (!isStrikeUsed(strike)) {
        levels.push({
          level: strike,
          type: 'CONFLUENCE',
          expiries: expiryList
        });
        markStrikeUsed(strike);
      }
    }

    // 3. Add Call Walls - use selectedLevels OI if available, otherwise lookup
    // Skip if strike is already used in RESONANCE or CONFLUENCE
    if (quantAnalysis.selectedLevels) {
      for (const wall of quantAnalysis.selectedLevels.call_walls) {
        if (!isStrikeUsed(wall.strike)) {
          levels.push({
            level: wall.strike,
            type: 'CALL_WALL',
            expiries: [wall.expiry],
            oi: wall.oi
          });
          markStrikeUsed(wall.strike);
        }
      }
    } else {
      for (const strike of quantAnalysis.walls.callWalls) {
        if (!isStrikeUsed(strike)) {
          const opt = quantAnalysis.allOptions.find(o => o.strike === strike && o.side === 'CALL');
          levels.push({
            level: strike,
            type: 'CALL_WALL',
            expiries: ['0DTE'],
            oi: opt?.oi
          });
          markStrikeUsed(strike);
        }
      }
    }

    // 4. Add Put Walls - use selectedLevels OI if available, otherwise lookup
    // Skip if strike is already used in RESONANCE or CONFLUENCE
    if (quantAnalysis.selectedLevels) {
      for (const wall of quantAnalysis.selectedLevels.put_walls) {
        if (!isStrikeUsed(wall.strike)) {
          levels.push({
            level: wall.strike,
            type: 'PUT_WALL',
            expiries: [wall.expiry],
            oi: wall.oi
          });
          markStrikeUsed(wall.strike);
        }
      }
    } else {
      for (const strike of quantAnalysis.walls.putWalls) {
        if (!isStrikeUsed(strike)) {
          const opt = quantAnalysis.allOptions.find(o => o.strike === strike && o.side === 'PUT');
          levels.push({
            level: strike,
            type: 'PUT_WALL',
            expiries: ['0DTE'],
            oi: opt?.oi
          });
          markStrikeUsed(strike);
        }
      }
    }

    // Sort and split by spot
    const sorted = [...levels].sort((a, b) => b.level - a.level);
    return {
      aboveSpot: sorted.filter(l => l.level > spot),
      belowSpot: sorted.filter(l => l.level <= spot)
    };
  }, [quantAnalysis]);

  // Render loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
        <div className="max-w-6xl mx-auto">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
        <div className="max-w-6xl mx-auto">
          <ErrorDisplay message={error} />
        </div>
      </div>
    );
  }

  // Main render
  return (
    <div className="min-h-screen bg-[#08080a] text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white">
                Quant Options Analysis
              </h1>
              <p className="text-gray-400 mt-1">
                Real-time options flow and gamma exposure analysis
              </p>
            </div>
            <div className="flex flex-col items-start md:items-end gap-2">
              <DataAgeBadge ageMinutes={dataAgeMinutes} />
              <span className="text-xs text-gray-500">
                Last Update: {lastUpdateTime}
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6">
          <div className="flex flex-wrap gap-2">
            {SYMBOLS.map((symbol) => (
              <TabButton
                key={symbol}
                symbol={symbol}
                isActive={activeTab === symbol}
                onClick={() => setActiveTab(symbol)}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        {activeSymbolData ? (
          <div className="space-y-6">
            {/* Spot Price Header */}
            <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 rounded-xl p-6 border border-blue-500/30">
              <div className="text-sm text-gray-400 uppercase tracking-wider mb-1">
                {activeTab} Spot Price
              </div>
              <div className="text-4xl md:text-5xl font-bold text-white">
                {formatCurrency(activeSymbolData.spot)}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                Generated: {activeSymbolData.generated || 'Unknown'}
              </div>
            </div>

            {/* Quantitative Analysis Section */}
            {quantAnalysis && quantAnalysis.aggregatedMetrics && (
              <div className="bg-[#0c0c0e] p-6 rounded-3xl shadow-2xl border border-gray-800/40 backdrop-blur-3xl">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-xl font-black text-white uppercase tracking-tighter">RESONANCE ENGINE</h2>
                    <p className={`text-[10px] font-bold uppercase tracking-widest opacity-80 ${quantAnalysis.aiAnalysis ? 'text-purple-500' : 'text-green-500'}`}>
                      {quantAnalysis.aiAnalysis ? '🤖 AI Analysis Active' : 'Quant Analysis Active'}
                    </p>
                  </div>
                </div>

                {/* AI Outlook Display (when AI analysis is available) */}
                {quantAnalysis.aiAnalysis?.outlook ? (
                  <AIOutlookDisplay outlook={quantAnalysis.aiAnalysis.outlook} />
                ) : (
                  /* Fallback Sentiment Display */
                  <SentimentDisplay
                    sentiment={quantAnalysis.sentiment}
                    gammaFlipCluster={quantAnalysis.aggregatedMetrics.gamma_flip}
                  />
                )}

                {/* Two-Column Levels Display - AI vs Algorithmic */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* AI Column (Left) */}
                  <div className="border border-purple-500/30 rounded-xl p-4 bg-purple-500/5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xl">🤖</span>
                      <h3 className="text-lg font-bold text-purple-400">AI Analysis</h3>
                      {aiDisplayLevels && (
                        <span className="text-[10px] font-bold text-green-400 bg-green-500/20 px-2 py-0.5 rounded-full">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    
                    {aiDisplayLevels ? (
                      <div className="flex flex-col gap-2">
                        {/* AI Levels Above Spot */}
                        {aiDisplayLevels.aboveSpot.map((level, i) => {
                          const isMatch = displayLevels.aboveSpot.some(l =>
                            Math.abs(l.level - level.prezzo) < quantAnalysis.spot * 0.003
                          );
                          return (
                            <AILevelRow
                              key={`ai-above-${i}`}
                              level={level}
                              spot={quantAnalysis.spot}
                              isMatch={isMatch}
                            />
                          );
                        })}

                        {/* Spot Price Divider */}
                        <div className="py-3 flex items-center gap-3">
                          <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-purple-500/40 to-purple-500/40"></div>
                          <div className="shrink-0 bg-purple-600 px-3 py-1 rounded-full border border-purple-400 shadow-[0_0_10px_rgba(147,51,234,0.3)]">
                            <span className="text-[10px] font-black text-white uppercase tracking-wider">SPOT: {quantAnalysis.spot.toFixed(2)}</span>
                          </div>
                          <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-purple-500/40 to-purple-500/40"></div>
                        </div>

                        {/* AI Levels Below Spot */}
                        {aiDisplayLevels.belowSpot.map((level, i) => {
                          const isMatch = displayLevels.belowSpot.some(l =>
                            Math.abs(l.level - level.prezzo) < quantAnalysis.spot * 0.003
                          );
                          return (
                            <AILevelRow
                              key={`ai-below-${i}`}
                              level={level}
                              spot={quantAnalysis.spot}
                              isMatch={isMatch}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        <span className="text-4xl mb-2 block">🚫</span>
                        <p className="text-sm font-medium">AI Analysis Not Available</p>
                        <p className="text-xs text-gray-600 mt-1">Using algorithmic fallback only</p>
                      </div>
                    )}
                  </div>

                  {/* Algorithmic Column (Right) */}
                  <div className="border border-blue-500/30 rounded-xl p-4 bg-blue-500/5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xl">⚙️</span>
                      <h3 className="text-lg font-bold text-blue-400">Algorithmic Fallback</h3>
                      <span className="text-[10px] font-bold text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded-full">
                        {displayLevels.aboveSpot.length + displayLevels.belowSpot.length} LEVELS
                      </span>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                      {/* Algorithmic Levels Above Spot */}
                      {displayLevels.aboveSpot.map((l, i) => {
                        const isMatch = aiDisplayLevels?.aboveSpot.some(ai =>
                          Math.abs(ai.prezzo - l.level) < quantAnalysis.spot * 0.003
                        ) || false;
                        return (
                          <LevelRow
                            key={`algo-above-${i}`}
                            level={l.level}
                            type={l.type}
                            spot={quantAnalysis.spot}
                            expiries={l.expiries}
                            oi={l.oi}
                            isMatch={isMatch}
                          />
                        );
                      })}

                      {/* Spot Price Divider */}
                      <div className="py-3 flex items-center gap-3">
                        <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-blue-500/40 to-blue-500/40"></div>
                        <div className="shrink-0 bg-blue-600 px-3 py-1 rounded-full border border-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.3)]">
                          <span className="text-[10px] font-black text-white uppercase tracking-wider">SPOT: {quantAnalysis.spot.toFixed(2)}</span>
                        </div>
                        <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-blue-500/40 to-blue-500/40"></div>
                      </div>

                      {/* Algorithmic Levels Below Spot */}
                      {displayLevels.belowSpot.map((l, i) => {
                        const isMatch = aiDisplayLevels?.belowSpot.some(ai =>
                          Math.abs(ai.prezzo - l.level) < quantAnalysis.spot * 0.003
                        ) || false;
                        return (
                          <LevelRow
                            key={`algo-below-${i}`}
                            level={l.level}
                            type={l.type}
                            spot={quantAnalysis.spot}
                            expiries={l.expiries}
                            oi={l.oi}
                            isMatch={isMatch}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Match Legend */}
                {aiDisplayLevels && (
                  <div className="mt-4 flex items-center justify-center gap-4 text-xs text-gray-500">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded border-2 border-cyan-500/50 bg-cyan-500/10"></div>
                      <span>Matching level (AI & Algo agree)</span>
                    </div>
                  </div>
                )}

                {/* Quantitative Metrics Display */}
                <QuantMetricsDisplay metrics={quantAnalysis.aggregatedMetrics} />
              </div>
            )}

            {/* Expiry Details */}
            {activeSymbolData.expiries && activeSymbolData.expiries.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-bold text-white uppercase tracking-wider">Expiry Details</h3>
                {activeSymbolData.expiries.map((expiry, idx) => {
                  const topCalls = getTopOptionsByOI(expiry.options, 'CALL', 5);
                  const topPuts = getTopOptionsByOI(expiry.options, 'PUT', 5);

                  return (
                    <div key={`${expiry.label}-${expiry.date}-${idx}`} className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
                      <div className="px-4 py-3 bg-gray-800/70 border-b border-gray-700/50">
                        <h4 className="font-semibold text-white">
                          {getExpiryDisplayLabel(expiry)}
                        </h4>
                      </div>
                      <div className="p-4">
                        <OptionsChart
                          callOptions={topCalls}
                          putOptions={topPuts}
                          spot={activeSymbolData.spot}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <EmptySymbolState symbol={activeTab} />
        )}

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-gray-800">
          <p className="text-xs text-gray-500 text-center">
            Data is fetched from GitHub Actions and cached for 30 minutes.
            <br />
            For educational purposes only. Not financial advice.
          </p>
        </div>
      </div>
    </div>
  );
}

export default VercelView;
