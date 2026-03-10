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
import {
  SymbolData, ExpiryData, OptionData, QuantMetrics, PutCallRatios,
  VolatilitySkew, GEXData, SelectedLevels, AIAnalysis, AILevel, AIOutlook,
  ConfluenceLevel, ResonanceLevel, ConfluenceExpiryDetail, LegacyConfluenceLevel, LegacyResonanceLevel,
  TotalGexData
} from '../types';

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
 * Supports 3 expiries: 0DTE, WEEKLY, MONTHLY
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

// Detailed tooltips for metrics with trading implications
const DETAILED_TOOLTIPS = {
  gex0dte: `GEX (Gamma Exposure) 0DTE measures the total gamma exposure for options expiring TODAY.

How to use:
• Positive GEX = Dealers are LONG gamma = market stability, price suppression
• Negative GEX = Dealers are SHORT gamma = volatility amplification, trend acceleration
• 0DTE GEX is critical for intraday trading as it affects same-day price action

Trading implications:
• Negative 0DTE GEX near spot = expect accelerated moves if support/resistance breaks
• Positive 0DTE GEX = expect mean reversion, scalping opportunities`,

  gammaFlip0dte: `Gamma Flip 0DTE is the price level where cumulative gamma exposure changes sign for TODAY's expiry.

How to use:
• Above flip = positive gamma regime (stability)
• Below flip = negative gamma regime (volatility)
• Spot near flip = HIGH inflection risk - directional breakout imminent

Trading implications:
• Long entries above flip have lower volatility risk
• Short entries below flip benefit from volatility amplification
• Flip acts as dynamic support/resistance`,

  totalGex: `Total Market GEX aggregates gamma exposure across ALL available expiries.

How to use:
• Provides the complete picture of dealer positioning
• More stable than single-expiry GEX
• Negative total = bearish volatility regime
• Positive total = bullish stability regime

Trading implications:
• Use for overall market bias, not intraday timing
• Compare with 0DTE GEX to see near-term vs structural positioning`,

  gammaFlipTotal: `Total Gamma Flip is calculated across all expiries.

How to use:
• More significant than single-expiry flip
• Acts as major structural support/resistance
• Price tends to be attracted to this level

Trading implications:
• Major level for swing trading decisions
• Break above = bullish structural shift
• Break below = bearish structural shift`,

  maxPain: `Max Pain is the price where total option value is minimized = maximum loss for option buyers.

How to use:
• Acts as magnetic attractor for price
• Dealers target this level to minimize payouts
• Strongest effect in last week of expiry

Trading implications:
• Price tends to move toward max pain into expiry
• Use as target for mean reversion trades
• Combine with GEX for confluence`,

  putCallRatio: `Put/Call Ratio measures sentiment via options positioning.

How to use:
• PCR > 1.0 = bearish sentiment (excessive pessimism)
• PCR < 0.7 = bullish sentiment (excessive optimism)
• Contrarian indicator at extremes

Trading implications:
• Very high PCR = potential bounce (too much bearishness)
• Very low PCR = correction risk (complacency)
• Use with price action for confirmation`,

  volatilitySkew: `Volatility Skew shows the relative pricing of puts vs calls.

Types:
• SMIRK (ratio > 1.2): Expensive puts = fear, strong support
• REVERSE SMIRK (ratio < 0.9): Expensive calls = euphoria, weak resistance
• FLAT (ratio 0.9-1.2): Balanced market

Trading implications:
• Strong smirk = institutional hedging, expect support at put walls
• Reverse smirk = call buying spree, resistance may fail
• Use to validate wall levels`
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

// Local interface for internal confluence calculation (different from types.ts ConfluenceLevel)
interface LocalConfluenceScore {
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
const MAX_RESONANCE_LEVELS = 1; // Reduced: only the strongest resonance
const MAX_CONFLUENCE_LEVELS = 2; // Reduced: more selective filtering

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
): LocalConfluenceScore[] {
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
  const candidates: LocalConfluenceScore[] = clusters.map(cluster => {
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
): LocalConfluenceScore[] {
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
  const candidates: LocalConfluenceScore[] = clusters.map(cluster => {
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
 * 0DTE Metrics Display Component
 * Shows metrics specifically for the first expiry (0DTE - Today)
 */
const ZeroDTEMetricsDisplay: React.FC<{
  metrics: QuantMetrics;
  spot: number;
}> = ({ metrics, spot }) => {
  const getGexColor = (gex: number) =>
    gex >= 0 ? 'text-green-400' : 'text-red-400';

  const getPcrColor = (pcr: number) =>
    pcr < 0.7 ? 'text-green-400' : pcr > 1.0 ? 'text-red-400' : 'text-yellow-400';

  const getSentimentColor = (sentiment: string) =>
    sentiment === 'bullish' ? 'text-green-400' :
    sentiment === 'bearish' ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="bg-gradient-to-r from-blue-900/40 to-indigo-900/40 p-4 rounded-xl border border-blue-600/50 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xl">📅</span>
        <h3 className="text-base font-black text-white uppercase tracking-wider">0DTE Metrics (Today)</h3>
        <span className="text-xs text-blue-300 ml-2">First Expiry Only</span>
      </div>

      {/* Key 0DTE Metrics Row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {/* GEX 0DTE */}
        <div className="bg-black/40 p-3 rounded-lg border border-blue-800/50">
          <MetricLabel
            label="GEX 0DTE"
            tooltip={DETAILED_TOOLTIPS.gex0dte}
            className="text-xs font-bold text-blue-300 uppercase block mb-1 tracking-widest"
          />
          <span className={`text-xl font-black font-mono block mt-1 ${getGexColor(metrics.total_gex)}`}>
            {formatGEX(metrics.total_gex)}
          </span>
          {metrics.total_gex < 0 && (
            <span className="text-[10px] text-red-400/70 block">(volatility regime)</span>
          )}
        </div>

        {/* Gamma Flip 0DTE */}
        <div className="bg-black/40 p-3 rounded-lg border border-blue-800/50">
          <MetricLabel
            label="Gamma Flip 0DTE"
            tooltip={DETAILED_TOOLTIPS.gammaFlip0dte}
            className="text-xs font-bold text-blue-300 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-indigo-400 font-mono block mt-1">
            ${metrics.gamma_flip?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
          {metrics.gamma_flip && spot > 0 && (
            <span className={`text-[10px] ${spot > metrics.gamma_flip ? 'text-green-400/70' : 'text-red-400/70'} block`}>
              {spot > metrics.gamma_flip ? 'Above flip (stable)' : 'Below flip (volatile)'}
            </span>
          )}
        </div>

        {/* Max Pain 0DTE */}
        <div className="bg-black/40 p-3 rounded-lg border border-blue-800/50">
          <MetricLabel
            label="Max Pain 0DTE"
            tooltip={DETAILED_TOOLTIPS.maxPain}
            className="text-xs font-bold text-blue-300 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-amber-400 font-mono block mt-1">
            ${metrics.max_pain?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
          {metrics.max_pain && spot > 0 && (
            <span className="text-[10px] text-amber-400/70 block">
              {metrics.max_pain != null && spot != null ? ((Math.abs(spot - metrics.max_pain) / spot) * 100).toFixed(2) : 'N/A'}% from spot
            </span>
          )}
        </div>
      </div>

      {/* Put/Call Ratios */}
      <div className="bg-black/30 p-3 rounded-lg border border-blue-800/40 mb-3">
        <MetricLabel
          label="Put/Call Ratios"
          tooltip={DETAILED_TOOLTIPS.putCallRatio}
          className="text-xs font-bold text-blue-300 uppercase block mb-3 tracking-widest"
        />
        <div className="grid grid-cols-4 gap-3">
          <div className="text-center">
            <span className="text-[11px] text-gray-400 block">OI-Based</span>
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios?.oi_based ?? 0)}`}>
              {metrics.put_call_ratios?.oi_based?.toFixed(2) ?? 'N/A'}
            </span>
          </div>
          <div className="text-center">
            <span className="text-[11px] text-gray-400 block">Volume</span>
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios?.volume_based ?? 0)}`}>
              {metrics.put_call_ratios?.volume_based?.toFixed(2) ?? 'N/A'}
            </span>
          </div>
          <div className="text-center">
            <span className="text-[11px] text-gray-400 block">Weighted</span>
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios?.weighted ?? 0)}`}>
              {metrics.put_call_ratios?.weighted?.toFixed(2) ?? 'N/A'}
            </span>
          </div>
          <div className="text-center">
            <span className="text-[11px] text-gray-400 block">Delta-Adj</span>
            <span className={`text-base font-bold font-mono block mt-1 ${getPcrColor(metrics.put_call_ratios?.delta_adjusted ?? 0)}`}>
              {metrics.put_call_ratios?.delta_adjusted?.toFixed(2) ?? 'N/A'}
            </span>
          </div>
        </div>
      </div>

      {/* Volatility Skew */}
      <div className="bg-black/30 p-3 rounded-lg border border-blue-800/40">
        <MetricLabel
          label="Volatility Skew"
          tooltip={DETAILED_TOOLTIPS.volatilitySkew}
          className="text-xs font-bold text-blue-300 uppercase block mb-3 tracking-widest"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div>
              <span className="text-[11px] text-gray-400 block">Type</span>
              <span className="text-base font-bold text-white capitalize block mt-1">{metrics.volatility_skew?.skew_type?.replace('_', ' ') ?? 'N/A'}</span>
            </div>
            <div>
              <span className="text-[11px] text-gray-400 block">Put IV</span>
              <span className="text-base font-bold text-red-400 font-mono block mt-1">{metrics.volatility_skew?.put_iv_avg != null ? `${(metrics.volatility_skew.put_iv_avg * 100).toFixed(0)}%` : 'N/A'}</span>
            </div>
            <div>
              <span className="text-[11px] text-gray-400 block">Call IV</span>
              <span className="text-base font-bold text-green-400 font-mono block mt-1">{metrics.volatility_skew?.call_iv_avg != null ? `${(metrics.volatility_skew.call_iv_avg * 100).toFixed(0)}%` : 'N/A'}</span>
            </div>
            <div>
              <span className="text-[11px] text-gray-400 block">Ratio</span>
              <span className="text-base font-bold text-gray-300 font-mono block mt-1">{metrics.volatility_skew?.skew_ratio?.toFixed(2) ?? 'N/A'}</span>
            </div>
          </div>
          <div className="text-right">
            <span className={`text-sm font-black uppercase ${getSentimentColor(metrics.volatility_skew?.sentiment ?? 'neutral')}`}>
              {metrics.volatility_skew?.sentiment ?? 'N/A'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Aggregate Metrics Display Component (All Expiries Combined)
 * Simplified version showing only aggregate metrics
 */
const AggregateMetricsDisplay: React.FC<{ metrics: QuantMetrics; spot: number }> = ({ metrics, spot }) => {
  const getGexColor = (gex: number) =>
    gex >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="bg-gray-900/60 p-4 rounded-xl border border-gray-700/50 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xl">📊</span>
        <h3 className="text-base font-black text-white uppercase tracking-wider">Aggregate Metrics (All Expiries)</h3>
      </div>

      {/* Key Aggregate Metrics Row */}
      <div className="grid grid-cols-2 gap-3">
        {/* Total GEX */}
        <div className="bg-black/40 p-3 rounded-lg border border-gray-800/50">
          <MetricLabel
            label="Aggregate GEX"
            tooltip={DETAILED_TOOLTIPS.totalGex}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className={`text-xl font-black font-mono block mt-1 ${getGexColor(metrics.total_gex)}`}>
            {formatGEX(metrics.total_gex)}
          </span>
          {metrics.total_gex < 0 && (
            <span className="text-[10px] text-red-400/70 block">(volatility regime)</span>
          )}
        </div>

        {/* Gamma Flip */}
        <div className="bg-black/40 p-3 rounded-lg border border-gray-800/50">
          <MetricLabel
            label="Gamma Flip (Total)"
            tooltip={DETAILED_TOOLTIPS.gammaFlipTotal}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-indigo-400 font-mono block mt-1">
            ${metrics.gamma_flip?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
          {metrics.gamma_flip && spot > 0 && (
            <span className={`text-[10px] ${spot > metrics.gamma_flip ? 'text-green-400/70' : 'text-red-400/70'} block`}>
              {spot > metrics.gamma_flip ? 'Above flip' : 'Below flip'}
            </span>
          )}
        </div>
      </div>

    </div>
  );
};

/**
 * Total GEX Display Component
 * Shows aggregate GEX data across all expiries
 */
const TotalGexDisplay: React.FC<{ totalGexData: TotalGexData; spot: number }> = ({ totalGexData, spot }) => {
  const getGexColor = (gex: number) =>
    gex >= 0 ? 'text-green-400' : 'text-red-400';

  const getGexEmoji = (gex: number) =>
    gex >= 0 ? '🟢' : '🔴';

  return (
    <div className="bg-gradient-to-r from-gray-900/80 to-gray-800/60 p-4 rounded-xl border border-gray-600/50 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xl">🌐</span>
        <h3 className="text-base font-black text-white uppercase tracking-wider">Total Market GEX (All Expiries)</h3>
      </div>

      {/* Main GEX Value */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <MetricLabel
            label="Aggregate GEX"
            tooltip={DETAILED_TOOLTIPS.totalGex}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <div className="flex items-center gap-2">
            <span className="text-2xl">{getGexEmoji(totalGexData.total_gex)}</span>
            <span className={`text-2xl font-black font-mono ${getGexColor(totalGexData?.total_gex ?? 0)}`}>
              {totalGexData?.total_gex != null ? `${totalGexData.total_gex > 0 ? '+' : ''}${totalGexData.total_gex.toFixed(2)}B` : 'N/A'}
            </span>
          </div>
        </div>
        <div className="text-right">
          <MetricLabel
            label="Gamma Flip Point"
            tooltip={DETAILED_TOOLTIPS.gammaFlipTotal}
            className="text-xs font-bold text-gray-400 uppercase block mb-1 tracking-widest"
          />
          <span className="text-xl font-black text-indigo-400 font-mono">
            ${totalGexData.flip_point?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'N/A'}
          </span>
          {totalGexData.flip_point && spot > 0 && (
            <span className={`text-[10px] ${spot > totalGexData.flip_point ? 'text-green-400/70' : 'text-red-400/70'} block`}>
              {spot > totalGexData.flip_point ? 'Above flip (stable)' : 'Below flip (volatile)'}
            </span>
          )}
        </div>
      </div>

      {/* Positive/Negative Breakdown */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-black/30 p-3 rounded-lg border border-green-900/30">
          <span className="text-xs font-bold text-green-400/70 uppercase block mb-1">Positive GEX</span>
          <span className="text-lg font-bold text-green-400 font-mono">
            {totalGexData?.positive_gex != null ? `+${totalGexData.positive_gex.toFixed(2)}B` : 'N/A'}
          </span>
        </div>
        <div className="bg-black/30 p-3 rounded-lg border border-red-900/30">
          <span className="text-xs font-bold text-red-400/70 uppercase block mb-1">Negative GEX</span>
          <span className="text-lg font-bold text-red-400 font-mono">
            {totalGexData?.negative_gex != null ? `${totalGexData.negative_gex.toFixed(2)}B` : 'N/A'}
          </span>
        </div>
      </div>

      {/* GEX by Expiry */}
      {totalGexData.gex_by_expiry && totalGexData.gex_by_expiry.length > 0 && (
        <div className="bg-black/20 p-3 rounded-lg border border-gray-800/40">
          <span className="text-xs font-bold text-gray-400 uppercase block mb-3 tracking-widest">GEX by Expiry</span>
          <div className="space-y-2">
            {totalGexData.gex_by_expiry.map((expiry, idx) => (
              <div key={idx} className="flex items-center justify-between">
                <span className="text-sm text-gray-300">{expiry.date}</span>
                <div className="flex items-center gap-3">
                  <div className="w-24 bg-gray-700/50 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full ${expiry.gex >= 0 ? 'bg-green-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.min(Math.abs(expiry.weight) * 100, 100)}%` }}
                    />
                  </div>
                  <span className={`text-sm font-mono font-bold w-20 text-right ${getGexColor(expiry.gex ?? 0)}`}>
                    {expiry.gex != null ? `${expiry.gex > 0 ? '+' : ''}${expiry.gex.toFixed(2)}B` : 'N/A'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Helper function to check if confluence data is enhanced format
 */
function isEnhancedConfluenceLevel(data: ConfluenceLevel | LegacyConfluenceLevel): data is ConfluenceLevel {
  return 'expiry_label' in data && data.expiry_label !== undefined;
}

/**
 * Helper function to check if resonance data is enhanced format
 */
function isEnhancedResonanceLevel(data: ResonanceLevel | LegacyResonanceLevel): data is ResonanceLevel {
  return 'expiry_label' in data && data.expiry_label !== undefined;
}

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
  enhancedData?: ConfluenceLevel | ResonanceLevel | LegacyConfluenceLevel | LegacyResonanceLevel;
}> = ({ level, type, spot, expiries = [], oi, isMatch = false, wallType, enhancedData }) => {
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

  // Check if we have enhanced data to display
  const hasEnhancedData = enhancedData && (isEnhancedConfluenceLevel(enhancedData) || isEnhancedResonanceLevel(enhancedData));
  const enhanced = hasEnhancedData ? (enhancedData as ConfluenceLevel | ResonanceLevel) : null;
  
  // Use expiry_label from enhanced data if available, otherwise fall back to expiries array
  const displayExpiries = enhanced?.expiry_label ? enhanced.expiry_label.split('+') : expiries;
  const expiryLabelDisplay = enhanced?.expiry_label || (expiries.length > 0 ? expiries.join('+') : '');

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
          {/* Display expiry label badge for confluence/resonance */}
          {(type === 'CONFLUENCE' || type === 'RESONANCE') && expiryLabelDisplay && (
            <span className={`text-[9px] font-black px-2 py-0.5 rounded ${
              type === 'RESONANCE'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
            }`}>
              {expiryLabelDisplay}
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

        {/* Enhanced metrics display for CONFLUENCE/RESONANCE */}
        {enhanced && (type === 'CONFLUENCE' || type === 'RESONANCE') && (
          <div className="mt-2 space-y-1.5">
            {/* OI Row */}
            <div className="flex items-center gap-4 text-[11px]">
              <span className="text-gray-500">📊</span>
              <span className="text-green-400 font-mono">
                Call OI: <span className="font-bold">{enhanced.total_call_oi?.toLocaleString() || 'N/A'}</span>
              </span>
              <span className="text-red-400 font-mono">
                Put OI: <span className="font-bold">{enhanced.total_put_oi?.toLocaleString() || 'N/A'}</span>
              </span>
            </div>
            {/* Volume Row */}
            <div className="flex items-center gap-4 text-[11px]">
              <span className="text-gray-500">📈</span>
              <span className="text-green-400 font-mono">
                Call Vol: <span className="font-bold">{enhanced.total_call_vol?.toLocaleString() || 'N/A'}</span>
              </span>
              <span className="text-red-400 font-mono">
                Put Vol: <span className="font-bold">{enhanced.total_put_vol?.toLocaleString() || 'N/A'}</span>
              </span>
            </div>
            {/* PCR Row */}
            {enhanced.put_call_ratio !== undefined && enhanced.put_call_ratio > 0 && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-gray-500">⚖️</span>
                <span className={`font-mono font-bold ${
                  enhanced.put_call_ratio > 1 ? 'text-red-400' :
                  enhanced.put_call_ratio < 0.7 ? 'text-green-400' : 'text-gray-300'
                }`}>
                  PCR: {enhanced.put_call_ratio?.toFixed(2) ?? 'N/A'}
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                  enhanced.put_call_ratio > 1 ? 'bg-red-500/20 text-red-300' :
                  enhanced.put_call_ratio < 0.7 ? 'bg-green-500/20 text-green-300' : 'bg-gray-500/20 text-gray-400'
                }`}>
                  {enhanced.put_call_ratio > 1 ? 'Bearish' : enhanced.put_call_ratio < 0.7 ? 'Bullish' : 'Neutral'}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Legacy OI display for walls */}
        {!enhanced && oi !== undefined && oi > 0 && (
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
            {level?.toFixed(2) ?? 'N/A'}
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-black font-mono ${distancePct != null && distancePct > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {distancePct != null ? `${distancePct > 0 ? '+' : ''}${distancePct.toFixed(2)}%` : 'N/A'}
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
            {level.prezzo?.toFixed(2) ?? 'N/A'}
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-black font-mono ${distancePct != null && distancePct > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {distancePct != null ? `${distancePct > 0 ? '+' : ''}${distancePct.toFixed(2)}%` : 'N/A'}
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
          <span className="text-lg font-black text-indigo-400">{outlook.gammaFlipZone != null ? `$${outlook.gammaFlipZone.toFixed(2)}` : 'N/A'}</span>
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
        <span className="text-lg font-black text-indigo-400">{gammaFlipCluster != null ? gammaFlipCluster.toFixed(2) : 'N/A'}</span>
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
      <div className="overflow-x-auto border-2 border-blue-500">
        <div
          className="relative mx-auto border-2 border-yellow-500"
          style={{
            width: `${labelWidth + chartWidth * 2 + 40}px`,
            minWidth: '100%',
            height: `${chartHeight}px`
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
                  className="relative flex items-center justify-end border border-dashed border-green-900"
                  style={{ height: `${barHeight + barGap}px`, width: '100%' }}
                >
                  {/* OI Bar */}
                  <div
                    className="absolute h-3 rounded-l-sm bg-gradient-to-l from-green-500 to-green-400 cursor-pointer transition-all hover:from-green-400 hover:to-green-300"
                    style={{
                      right: '0',
                      width: `${Math.max(oiWidth, 2)}px`,
                      top: '2px',
                      backgroundColor: oiWidth > 0 ? undefined : 'white'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('CALL', opt, e)}
                  />
                  {/* Volume Bar (overlaid, semi-transparent) */}
                  <div
                    className="absolute h-2 rounded-l-sm bg-green-300/40 cursor-pointer transition-all hover:bg-green-300/60"
                    style={{
                      right: '0',
                      width: `${Math.max(volWidth, 2)}px`,
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
 * Aggregated strike data across all expiries
 */
interface AggregatedStrike {
  strike: number;
  total_call_oi: number;
  total_put_oi: number;
  total_call_vol: number;
  total_put_vol: number;
  max_oi: number;
  max_vol: number;
}

/**
 * Aggregates options data from all expiries by strike price
 */
function aggregateOptionsByStrike(expiries: ExpiryData[]): AggregatedStrike[] {
  const strikeMap = new Map<number, AggregatedStrike>();
  
  for (const expiry of expiries) {
    for (const option of expiry.options) {
      const existing = strikeMap.get(option.strike) || {
        strike: option.strike,
        total_call_oi: 0,
        total_put_oi: 0,
        total_call_vol: 0,
        total_put_vol: 0,
        max_oi: 0,
        max_vol: 0
      };
      
      if (option.side === 'CALL') {
        existing.total_call_oi += option.oi || 0;
        existing.total_call_vol += option.vol || 0;
      } else {
        existing.total_put_oi += option.oi || 0;
        existing.total_put_vol += option.vol || 0;
      }
      
      strikeMap.set(option.strike, existing);
    }
  }
  
  // Calculate max values for scaling
  const strikes = Array.from(strikeMap.values());
  const maxOi = Math.max(
    ...strikes.map(s => s.total_call_oi),
    ...strikes.map(s => s.total_put_oi),
    1
  );
  const maxVol = Math.max(
    ...strikes.map(s => s.total_call_vol),
    ...strikes.map(s => s.total_put_vol),
    1
  );
  
  // Update max values in each strike
  strikes.forEach(s => {
    s.max_oi = maxOi;
    s.max_vol = maxVol;
  });
  
  return strikes.sort((a, b) => a.strike - b.strike);
}

/**
 * Filters strikes to show top N by total OI plus strikes near spot
 */
function filterRelevantStrikes(
  aggregatedStrikes: AggregatedStrike[],
  spot: number,
  topN: number = 12
): AggregatedStrike[] {
  // Sort by total OI (call + put)
  const sortedByOI = [...aggregatedStrikes].sort(
    (a, b) => (b.total_call_oi + b.total_put_oi) - (a.total_call_oi + a.total_put_oi)
  );
  
  // Take top N strikes
  const topStrikes = sortedByOI.slice(0, topN);
  
  // Ensure strikes around spot are included (within 1%)
  const spotRange = spot * 0.01;
  const nearSpot = aggregatedStrikes.filter(
    s => Math.abs(s.strike - spot) <= spotRange
  );
  
  // Merge and deduplicate by strike
  const allRelevant = [...new Map(
    [...topStrikes, ...nearSpot].map(s => [s.strike, s])
  ).values()];
  
  // Sort by strike descending for display (top to bottom)
  return allRelevant.sort((a, b) => b.strike - a.strike);
}

/**
 * Unified Options Chart Component - Aggregates all expiries with key level markers
 */
function UnifiedOptionsChart({
  expiries,
  spot,
  gammaFlip,
  maxPain,
  topStrikesCount = 12
}: {
  expiries: ExpiryData[];
  spot: number;
  gammaFlip?: number;
  maxPain?: number;
  topStrikesCount?: number;
}): ReactElement {
  const [hoveredBar, setHoveredBar] = useState<{
    type: 'CALL' | 'PUT';
    strike: number;
    callOi: number;
    putOi: number;
    callVol: number;
    putVol: number;
    x: number;
    y: number;
  } | null>(null);

  // Aggregate options data
  const aggregatedStrikes = useMemo(
    () => aggregateOptionsByStrike(expiries),
    [expiries]
  );

  // Filter to relevant strikes
  const relevantStrikes = useMemo(
    () => filterRelevantStrikes(aggregatedStrikes, spot, topStrikesCount),
    [aggregatedStrikes, spot, topStrikesCount]
  );

  // If no options, show empty state
  if (relevantStrikes.length === 0) {
    return (
      <div className="bg-gray-800/30 rounded-lg p-8 text-center text-gray-500">
        No options data available
      </div>
    );
  }

  // Chart dimensions
  const barHeight = 24;
  const barGap = 4;
  const labelWidth = 90; // Increased from 80 to prevent label cut-off
  const chartWidth = 200;
  const chartHeight = relevantStrikes.length * (barHeight + barGap);
  const chartTopOffset = 24; // Top padding for the chart

  // Calculate Y position for a price level (for horizontal markers)
  // Returns an object with Y position and edge indicator
  const getHorizontalMarkerY = (price: number): { y: number; isAtEdge: boolean; edgeType?: 'top' | 'bottom' } | null => {
    // Strikes are sorted descending (highest first at index 0)
    const sortedStrikes = relevantStrikes.map(s => s.strike);
    const rowHeight = barHeight + barGap;
    
    
    // Find the position by locating where this price falls between strikes
    // Since strikes are sorted descending, we iterate from highest to lowest
    let rowIndex = -1;
    let interpolation = 0;
    
    for (let i = 0; i < sortedStrikes.length; i++) {
      if (price >= sortedStrikes[i]) {
        // Price is at or above this strike
        rowIndex = i;
        // Check if we need to interpolate with the previous (higher) strike
        if (i > 0 && price < sortedStrikes[i - 1]) {
          // Interpolate between strike i-1 (higher) and strike i (lower)
          const higherStrike = sortedStrikes[i - 1];
          const lowerStrike = sortedStrikes[i];
          const range = higherStrike - lowerStrike;
          if (range > 0) {
            // interpolation = 0 means at higher strike, 1 means at lower strike
            interpolation = (higherStrike - price) / range;
            rowIndex = i - 1; // Start from the higher strike row
          }
        }
        break;
      }
    }
    
    // If price is below all strikes, place at bottom
    if (rowIndex === -1) {
      rowIndex = sortedStrikes.length - 1;
      interpolation = 1; // Below the last strike
    }
    
    // Calculate Y position based on row index and interpolation
    // Row 0 is at top, each row is rowHeight pixels tall
    // The center of row i is at: i * rowHeight + rowHeight / 2
    let y = rowIndex * rowHeight + rowHeight / 2 + interpolation * rowHeight;
    
    // Determine if marker is at edge
    const isAtTopEdge = rowIndex === 0 && interpolation <= 0;
    const isAtBottomEdge = rowIndex >= sortedStrikes.length - 1 && interpolation >= 0;
    
    // Clamp Y position to stay within visible bounds (with small margin)
    const minY = -rowHeight / 2;
    const maxY = chartHeight + rowHeight / 2;
    y = Math.max(minY, Math.min(maxY, y));
    
    return {
      y,
      isAtEdge: isAtTopEdge || isAtBottomEdge,
      edgeType: isAtTopEdge ? 'top' : isAtBottomEdge ? 'bottom' : undefined
    };
  };

  // Check if markers are within visible range
  const spotMarker = getHorizontalMarkerY(spot);
  const gammaFlipMarker = gammaFlip !== undefined ? getHorizontalMarkerY(gammaFlip) : null;
  const maxPainMarker = maxPain !== undefined ? getHorizontalMarkerY(maxPain) : null;

  // Handle mouse events for tooltips
  const handleMouseEnter = (
    type: 'CALL' | 'PUT',
    strike: AggregatedStrike,
    event: React.MouseEvent
  ) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setHoveredBar({
      type,
      strike: strike.strike,
      callOi: strike.total_call_oi,
      putOi: strike.total_put_oi,
      callVol: strike.total_call_vol,
      putVol: strike.total_put_vol,
      x: event.clientX,
      y: event.clientY
    });
  };

  const handleMouseLeave = () => {
    setHoveredBar(null);
  };

  // Calculate percentage distance from spot
  const getPercentDistance = (level: number): string => {
    const distance = ((level - spot) / spot) * 100;
    const sign = distance >= 0 ? '+' : '';
    return `${sign}${distance.toFixed(2)}%`;
  };

  return (
    <div className="relative" onMouseLeave={handleMouseLeave}>
      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-gradient-to-r from-green-500 to-green-400"></div>
          <span className="text-xs text-gray-400">CALL (OI/Volume)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-gradient-to-r from-red-400 to-red-500"></div>
          <span className="text-xs text-gray-400">PUT (OI/Volume)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-0.5 bg-yellow-400"></div>
          <span className="text-yellow-400 text-xs">●</span>
          <span className="text-xs text-gray-400">Spot: {formatCurrency(spot)}</span>
        </div>
        {gammaFlip !== undefined && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-0 border-t-2 border-dashed border-purple-500"></div>
            <span className="text-purple-400 text-xs">◆</span>
            <span className="text-xs text-gray-400">G.Flip: {formatCurrency(gammaFlip)}</span>
            <span className={`text-xs ${gammaFlip > spot ? 'text-green-400' : 'text-red-400'}`}>({getPercentDistance(gammaFlip)})</span>
          </div>
        )}
        {maxPain !== undefined && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-0.5 bg-orange-500"></div>
            <span className="text-orange-400 text-xs">■</span>
            <span className="text-xs text-gray-400">Max Pain: {formatCurrency(maxPain)}</span>
            <span className={`text-xs ${maxPain > spot ? 'text-green-400' : 'text-red-400'}`}>({getPercentDistance(maxPain)})</span>
          </div>
        )}
      </div>

      {/* Chart Container */}
      <div className="overflow-x-auto">
        <div
          className="relative mx-auto"
          style={{
            width: `${labelWidth + chartWidth * 2 + 100}px`, // Increased from 40 to 100 for marker label space
            minWidth: '100%',
            height: `${chartHeight + 30}px`, // Extra space for marker labels
            paddingLeft: '60px' // Add left padding to prevent marker labels from being cut off
          }}
        >
          {/* Horizontal Markers Layer */}
          <div
            className="absolute pointer-events-none z-10"
            style={{
              left: '60px', // Match the padding
              right: '0',
              top: `${chartTopOffset}px`,
              height: `${chartHeight}px`
            }}
          >
            {/* Spot Marker - Horizontal */}
            {spotMarker !== null && (
              <div
                className="absolute left-0 right-0"
                style={{ top: `${spotMarker.y - 1}px` }}
              >
                <div className="absolute left-0 -translate-y-1/2 whitespace-nowrap z-20" style={{ transform: 'translateX(-100%)' }}>
                  <span className={`px-1.5 py-0.5 rounded text-yellow-400 text-xs font-bold ${spotMarker.isAtEdge ? 'bg-yellow-900/90 border border-yellow-500' : 'bg-gray-900/90'}`}>
                    ● SPOT {formatCurrency(spot)}
                    {spotMarker.isAtEdge && <span className="ml-1 text-yellow-300">↦</span>}
                  </span>
                </div>
                <div className="absolute left-0 right-0 h-0.5 bg-yellow-400/80" />
                <div className="absolute left-0 right-0 h-3 -translate-y-1/2 bg-yellow-400/5" />
              </div>
            )}

            {/* Gamma Flip Marker - Horizontal Dashed */}
            {gammaFlipMarker !== null && gammaFlip !== undefined && (
              <div
                className="absolute left-0 right-0"
                style={{ top: `${gammaFlipMarker.y - 1}px` }}
              >
                <div className="absolute left-0 -translate-y-1/2 whitespace-nowrap z-20" style={{ transform: 'translateX(-100%)' }}>
                  <span className={`px-1.5 py-0.5 rounded text-purple-400 text-xs font-bold ${gammaFlipMarker.isAtEdge ? 'bg-purple-900/90 border border-purple-500' : 'bg-gray-900/90'}`}>
                    ◆ G.FLIP {formatCurrency(gammaFlip)}
                    {gammaFlipMarker.isAtEdge && <span className="ml-1 text-purple-300">↦</span>}
                  </span>
                </div>
                <div className="absolute left-0 right-0 h-0 border-t-2 border-dashed border-purple-500" />
                <div className="absolute left-0 right-0 h-3 -translate-y-1/2 bg-purple-500/5" />
              </div>
            )}

            {/* Max Pain Marker - Horizontal */}
            {maxPainMarker !== null && maxPain !== undefined && (
              <div
                className="absolute left-0 right-0"
                style={{ top: `${maxPainMarker.y - 1}px` }}
              >
                <div className="absolute left-0 -translate-y-1/2 whitespace-nowrap z-20" style={{ transform: 'translateX(-100%)' }}>
                  <span className={`px-1.5 py-0.5 rounded text-orange-400 text-xs font-bold ${maxPainMarker.isAtEdge ? 'bg-orange-900/90 border border-orange-500' : 'bg-gray-900/90'}`}>
                    ■ MAX PAIN {formatCurrency(maxPain)}
                    {maxPainMarker.isAtEdge && <span className="ml-1 text-orange-300">↦</span>}
                  </span>
                </div>
                <div className="absolute left-0 right-0 h-0.5 bg-orange-500" />
                <div className="absolute left-0 right-0 h-3 -translate-y-1/2 bg-orange-500/5" />
              </div>
            )}
          </div>

          {/* Center strike labels */}
          <div
            className="absolute top-6 flex flex-col justify-center"
            style={{
              left: '60px', // Match the padding
              width: `${labelWidth}px`,
              height: `${chartHeight}px`
            }}
          >
            {relevantStrikes.map((strikeData) => {
              const isSpot = Math.abs(strikeData.strike - spot) < spot * 0.002;
              const isGammaFlip = gammaFlip !== undefined && Math.abs(strikeData.strike - gammaFlip) < spot * 0.002;
              const isMaxPain = maxPain !== undefined && Math.abs(strikeData.strike - maxPain) < spot * 0.002;
              const isITM = strikeData.strike < spot;
              
              let textColorClass = 'text-gray-500';
              if (isSpot) textColorClass = 'text-yellow-400 font-bold';
              else if (isGammaFlip) textColorClass = 'text-purple-400 font-bold';
              else if (isMaxPain) textColorClass = 'text-orange-400 font-bold';
              else if (isITM) textColorClass = 'text-gray-300';
              
              return (
                <div
                  key={strikeData.strike}
                  className={`flex items-center justify-end pr-2 text-xs font-mono ${textColorClass}`}
                  style={{ height: `${barHeight + barGap}px` }}
                >
                  {formatCurrency(strikeData.strike)}
                  {isSpot && <span className="ml-1 text-yellow-400">●</span>}
                  {isGammaFlip && <span className="ml-1 text-purple-400">◆</span>}
                  {isMaxPain && <span className="ml-1 text-orange-400">■</span>}
                </div>
              );
            })}
          </div>

          {/* CALL bars (left side) */}
          <div
            className="absolute flex flex-col justify-center"
            style={{
              left: `${60 + labelWidth}px`, // Account for left padding
              width: `${chartWidth}px`,
              height: `${chartHeight}px`,
              top: '24px'
            }}
          >
            {relevantStrikes.map((strikeData) => {
              const oiWidth = (strikeData.total_call_oi / strikeData.max_oi) * (chartWidth - 20);
              const volWidth = (strikeData.total_call_vol / strikeData.max_vol) * (chartWidth - 20);

              return (
                <div
                  key={strikeData.strike}
                  className="relative flex items-center justify-end"
                  style={{ height: `${barHeight + barGap}px`, width: '100%' }}
                >
                  {/* OI Bar */}
                  <div
                    className="absolute h-3 rounded-l-sm bg-gradient-to-l from-green-500 to-green-400 cursor-pointer transition-all hover:from-green-400 hover:to-green-300"
                    style={{
                      right: '0',
                      width: `${Math.max(oiWidth, 2)}px`,
                      top: '2px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('CALL', strikeData, e)}
                  />
                  {/* Volume Bar (overlaid, semi-transparent) */}
                  <div
                    className="absolute h-2 rounded-l-sm bg-green-300/40 cursor-pointer transition-all hover:bg-green-300/60"
                    style={{
                      right: '0',
                      width: `${Math.max(volWidth, 2)}px`,
                      top: '12px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('CALL', strikeData, e)}
                  />
                </div>
              );
            })}
          </div>

          {/* Center divider */}
          <div
            className="absolute bg-gray-600"
            style={{
              left: `${60 + labelWidth + chartWidth}px`, // Account for left padding
              width: '1px',
              height: `${chartHeight}px`,
              top: '24px'
            }}
          />

          {/* PUT bars (right side) */}
          <div
            className="absolute flex flex-col justify-center"
            style={{
              left: `${60 + labelWidth + chartWidth + 1}px`, // Account for left padding
              width: `${chartWidth}px`,
              height: `${chartHeight}px`,
              top: '24px'
            }}
          >
            {relevantStrikes.map((strikeData) => {
              const oiWidth = (strikeData.total_put_oi / strikeData.max_oi) * (chartWidth - 20);
              const volWidth = (strikeData.total_put_vol / strikeData.max_vol) * (chartWidth - 20);
              
              return (
                <div
                  key={strikeData.strike}
                  className="relative flex items-center"
                  style={{ height: `${barHeight + barGap}px`, width: '100%' }}
                >
                  {/* OI Bar */}
                  <div
                    className="absolute h-3 rounded-r-sm bg-gradient-to-r from-red-400 to-red-500 cursor-pointer transition-all hover:from-red-300 hover:to-red-400"
                    style={{
                      left: '0',
                      width: `${Math.max(oiWidth, 2)}px`,
                      top: '2px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('PUT', strikeData, e)}
                  />
                  {/* Volume Bar (overlaid, semi-transparent) */}
                  <div
                    className="absolute h-2 rounded-r-sm bg-red-300/40 cursor-pointer transition-all hover:bg-red-300/60"
                    style={{
                      left: '0',
                      width: `${Math.max(volWidth, 2)}px`,
                      top: '12px'
                    }}
                    onMouseEnter={(e) => handleMouseEnter('PUT', strikeData, e)}
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
            {hoveredBar.type} @ {formatCurrency(hoveredBar.strike)}
          </div>
          <div className="text-xs text-gray-400 mb-2">Aggregated across all expiries</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
            <span className="text-gray-500">CALL OI:</span>
            <span className="font-mono text-right text-green-400">{formatNumber(hoveredBar.callOi, 0)}</span>
            <span className="text-gray-500">PUT OI:</span>
            <span className="font-mono text-right text-red-400">{formatNumber(hoveredBar.putOi, 0)}</span>
            <span className="text-gray-500">CALL Vol:</span>
            <span className="font-mono text-right text-green-300">{formatNumber(hoveredBar.callVol, 0)}</span>
            <span className="text-gray-500">PUT Vol:</span>
            <span className="font-mono text-right text-red-300">{formatNumber(hoveredBar.putVol, 0)}</span>
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

    // Calculate aggregated metrics - prefer pre-calculated from Python (totalGexData)
    // Fall back to local calculation if not available
    let aggregatedMetrics: QuantMetrics | null = null;
    
    if (activeSymbolData.totalGexData) {
      // Use pre-calculated values from Python for GEX and gamma flip
      const totalGexData = activeSymbolData.totalGexData;
      
      // We still need to calculate PCR, skew, etc. from options data
      const allOptionsForMetrics: OptionData[] = [];
      for (const expiry of expiries) {
        allOptionsForMetrics.push(...expiry.options);
      }
      
      // Calculate PCR and skew locally (these are not in totalGexData)
      const putCallRatios = calculatePutCallRatios(allOptionsForMetrics);
      const volatilitySkew = calculateVolatilitySkew(allOptionsForMetrics, spot);
      const maxPain = calculateMaxPain(allOptionsForMetrics, spot);
      
      // Use first expiry for T calculation
      const firstExpiryDate = expiries[0]?.date || new Date().toISOString().split('T')[0];
      const gexByStrike = calculateGexByStrike(allOptionsForMetrics, spot, calculateTimeToExpiry(firstExpiryDate));
      
      aggregatedMetrics = {
        total_gex: totalGexData.total_gex, // Value is already in billions
        gamma_flip: totalGexData.flip_point,
        max_pain: maxPain,
        put_call_ratios: putCallRatios,
        volatility_skew: volatilitySkew,
        gex_by_strike: gexByStrike,
      };
    } else {
      // Fallback: calculate locally
      aggregatedMetrics = calculateAggregatedMetrics(expiries, spot);
    }

    // Use selected_levels if available, otherwise calculate locally (fallback)
    let walls: { callWalls: number[]; putWalls: number[] };
    let confluenceLevels: Map<number, string[]>;
    let resonanceLevels: number[];
    
    // Store enhanced confluence data for detailed display
    let enhancedConfluenceData: Map<number, ConfluenceLevel | LegacyConfluenceLevel> = new Map();
    let enhancedResonanceData: Map<number, ResonanceLevel | LegacyResonanceLevel> = new Map();

    if (selectedLevels) {
      // Use pre-selected levels from Python
      walls = {
        callWalls: selectedLevels.call_walls.map(w => w.strike),
        putWalls: selectedLevels.put_walls.map(w => w.strike)
      };
      
      // Convert confluence array to Map for compatibility
      // Support both enhanced format (with expiry_label) and legacy format (just strike)
      confluenceLevels = new Map();
      for (const c of selectedLevels.confluence) {
        // Check if enhanced format with expiry_label
        if ('expiry_label' in c && c.expiry_label) {
          confluenceLevels.set(c.strike, c.expiries || c.expiry_label.split('+'));
          enhancedConfluenceData.set(c.strike, c as ConfluenceLevel);
        } else {
          // Legacy format fallback
          confluenceLevels.set(c.strike, ['MULTI']);
          enhancedConfluenceData.set(c.strike, c as LegacyConfluenceLevel);
        }
      }
      
      // Store enhanced resonance data
      for (const r of selectedLevels.resonance) {
        if ('expiry_label' in r && r.expiry_label) {
          enhancedResonanceData.set(r.strike, r as ResonanceLevel);
        } else {
          enhancedResonanceData.set(r.strike, r as LegacyResonanceLevel);
        }
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
      aiAnalysis, // Pass through AI analysis
      enhancedConfluenceData, // Enhanced confluence data with metrics
      enhancedResonanceData // Enhanced resonance data with metrics
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

  // Build levels array for display (algorithmic fallback - ONLY used when AI is unavailable)
  const displayLevels = useMemo(() => {
    // Only compute algorithmic levels as fallback when AI is not available
    if (!quantAnalysis || quantAnalysis.aiAnalysis?.levels?.length) return { aboveSpot: [], belowSpot: [] };

    const levels: Array<{
      level: number;
      type: 'CALL_WALL' | 'PUT_WALL' | 'GAMMA_FLIP' | 'MAX_PAIN' | 'CONFLUENCE' | 'RESONANCE';
      expiries: string[];
      oi?: number;
      wallType?: WallType;
      enhancedData?: ConfluenceLevel | ResonanceLevel | LegacyConfluenceLevel | LegacyResonanceLevel;
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
      // Get enhanced data if available
      const resonanceEnhanced = quantAnalysis.enhancedResonanceData?.get(strike);
      levels.push({
        level: strike,
        type: 'RESONANCE',
        expiries: resonanceEnhanced && isEnhancedResonanceLevel(resonanceEnhanced)
          ? resonanceEnhanced.expiries
          : ['0DTE', 'WEEKLY', 'MONTHLY'],
        enhancedData: resonanceEnhanced
      });
      markStrikeUsed(strike);
    }

    // 2. Add Confluence levels (skip if already added as resonance)
    for (const [strike, expiryList] of quantAnalysis.confluenceLevels) {
      // Skip if already added as resonance (check with tolerance)
      if (!isStrikeUsed(strike)) {
        // Get enhanced data if available
        const confluenceEnhanced = quantAnalysis.enhancedConfluenceData?.get(strike);
        levels.push({
          level: strike,
          type: 'CONFLUENCE',
          expiries: expiryList,
          enhancedData: confluenceEnhanced
        });
        markStrikeUsed(strike);
      }
    }

    // 3. Add Call Walls - ONLY DOMINANT walls (more selective fallback)
    // Use enhanced wall calculation to get wall types
    const enhancedWalls = calculateWallsEnhanced(quantAnalysis.allOptions, spot, 5);
    
    for (const wall of enhancedWalls.callWalls) {
      // Only include DOMINANT walls (score >= 70 effectively)
      if (wall.wallType === 'DOMINANT' && !isStrikeUsed(wall.strike)) {
        levels.push({
          level: wall.strike,
          type: 'CALL_WALL',
          expiries: ['0DTE'],
          oi: wall.oi,
          wallType: wall.wallType
        });
        markStrikeUsed(wall.strike);
      }
    }

    // 4. Add Put Walls - ONLY DOMINANT walls (more selective fallback)
    for (const wall of enhancedWalls.putWalls) {
      // Only include DOMINANT walls
      if (wall.wallType === 'DOMINANT' && !isStrikeUsed(wall.strike)) {
        levels.push({
          level: wall.strike,
          type: 'PUT_WALL',
          expiries: ['0DTE'],
          oi: wall.oi,
          wallType: wall.wallType
        });
        markStrikeUsed(wall.strike);
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

                {/* Single Column Levels Display - AI preferred, Algorithmic as fallback */}
                {aiDisplayLevels ? (
                  /* AI Analysis Section - Primary Display */
                  <div className="border border-purple-500/30 rounded-xl p-4 bg-purple-500/5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xl">🤖</span>
                      <h3 className="text-lg font-bold text-purple-400">AI Analysis</h3>
                      <span className="text-[10px] font-bold text-green-400 bg-green-500/20 px-2 py-0.5 rounded-full">
                        ACTIVE
                      </span>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                      {/* AI Levels Above Spot */}
                      {aiDisplayLevels.aboveSpot.map((level, i) => (
                        <AILevelRow
                          key={`ai-above-${i}`}
                          level={level}
                          spot={quantAnalysis.spot}
                        />
                      ))}

                      {/* Spot Price Divider */}
                      <div className="py-3 flex items-center gap-3">
                        <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-purple-500/40 to-purple-500/40"></div>
                        <div className="shrink-0 bg-purple-600 px-3 py-1 rounded-full border border-purple-400 shadow-[0_0_10px_rgba(147,51,234,0.3)]">
                          <span className="text-[10px] font-black text-white uppercase tracking-wider">SPOT: {quantAnalysis.spot?.toFixed(2) ?? 'N/A'}</span>
                        </div>
                        <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-purple-500/40 to-purple-500/40"></div>
                      </div>

                      {/* AI Levels Below Spot */}
                      {aiDisplayLevels.belowSpot.map((level, i) => (
                        <AILevelRow
                          key={`ai-below-${i}`}
                          level={level}
                          spot={quantAnalysis.spot}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  /* Algorithmic Fallback Section - Only shown when AI is unavailable */
                  <div className="border border-amber-500/30 rounded-xl p-4 bg-amber-500/5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xl">⚙️</span>
                      <h3 className="text-lg font-bold text-amber-400">Fallback Analysis</h3>
                      <span className="text-[10px] font-bold text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full">
                        {displayLevels.aboveSpot.length + displayLevels.belowSpot.length} LEVELS
                      </span>
                      <span className="text-[9px] text-gray-500 italic ml-2">AI unavailable - using algorithmic analysis</span>
                    </div>
                    
                    {(displayLevels.aboveSpot.length + displayLevels.belowSpot.length) > 0 ? (
                      <div className="flex flex-col gap-2">
                        {/* Algorithmic Levels Above Spot */}
                        {displayLevels.aboveSpot.map((l, i) => (
                          <LevelRow
                            key={`algo-above-${i}`}
                            level={l.level}
                            type={l.type}
                            spot={quantAnalysis.spot}
                            expiries={l.expiries}
                            oi={l.oi}
                            wallType={l.wallType}
                            enhancedData={l.enhancedData}
                          />
                        ))}

                        {/* Spot Price Divider */}
                        <div className="py-3 flex items-center gap-3">
                          <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-amber-500/40 to-amber-500/40"></div>
                          <div className="shrink-0 bg-amber-600 px-3 py-1 rounded-full border border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.3)]">
                            <span className="text-[10px] font-black text-white uppercase tracking-wider">SPOT: {quantAnalysis.spot?.toFixed(2) ?? 'N/A'}</span>
                          </div>
                          <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-amber-500/40 to-amber-500/40"></div>
                        </div>

                        {/* Algorithmic Levels Below Spot */}
                        {displayLevels.belowSpot.map((l, i) => (
                          <LevelRow
                            key={`algo-below-${i}`}
                            level={l.level}
                            type={l.type}
                            spot={quantAnalysis.spot}
                            expiries={l.expiries}
                            oi={l.oi}
                            wallType={l.wallType}
                            enhancedData={l.enhancedData}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        <span className="text-4xl mb-2 block">📊</span>
                        <p className="text-sm font-medium">No Significant Levels Detected</p>
                        <p className="text-xs text-gray-600 mt-1">Only DOMINANT walls are shown in fallback mode</p>
                      </div>
                    )}
                  </div>
                )}

                {/* 0DTE Metrics Display - First Expiry Only */}
                {quantAnalysis && quantAnalysis.expiryMetrics && quantAnalysis.expiryMetrics.length > 0 && quantAnalysis.expiryMetrics[0].calculatedMetrics && (
                  <ZeroDTEMetricsDisplay
                    metrics={quantAnalysis.expiryMetrics[0].calculatedMetrics}
                    spot={activeSymbolData.spot}
                  />
                )}

                {/* Total GEX Display (All Expiries) */}
                {activeSymbolData.totalGexData && (
                  <TotalGexDisplay totalGexData={activeSymbolData.totalGexData} spot={activeSymbolData.spot} />
                )}

                {/* Aggregate Metrics Display - REMOVED: Redundant with TotalGexDisplay above */}
                {/* <AggregateMetricsDisplay metrics={quantAnalysis.aggregatedMetrics} spot={activeSymbolData.spot} /> */}
              </div>
            )}

            {/* 0DTE Options Chart */}
            {activeSymbolData.expiries && activeSymbolData.expiries.length > 0 && (() => {
              const zeroDteExpiry = activeSymbolData.expiries.find(e => e.label === '0DTE');
              const zeroDteGammaFlip = zeroDteExpiry?.quantMetrics?.gamma_flip;
              const zeroDteMaxPain = zeroDteExpiry?.quantMetrics?.max_pain;
              
              return zeroDteExpiry && zeroDteExpiry.options && zeroDteExpiry.options.length > 0 && (
                <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
                  <div className="px-4 py-3 bg-gray-800/70 border-b border-gray-700/50">
                    <h3 className="text-lg font-bold text-white uppercase tracking-wider">
                      0DTE Options Chart
                      <span className="ml-2 text-sm font-normal text-gray-400">
                        (Today's Expiry Only)
                      </span>
                    </h3>
                  </div>
                  <div className="p-4">
                    <UnifiedOptionsChart
                      expiries={[zeroDteExpiry]}
                      spot={activeSymbolData.spot}
                      gammaFlip={zeroDteGammaFlip}
                      maxPain={zeroDteMaxPain}
                      topStrikesCount={12}
                    />
                  </div>
                </div>
              );
            })()}

            {/* All Expiries Options Chart */}
            {activeSymbolData.expiries && activeSymbolData.expiries.length > 0 && (
              <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
                <div className="px-4 py-3 bg-gray-800/70 border-b border-gray-700/50">
                  <h3 className="text-lg font-bold text-white uppercase tracking-wider">
                    All Expiries Options Chart
                    <span className="ml-2 text-sm font-normal text-gray-400">
                      (0DTE + Weekly + Monthly)
                    </span>
                  </h3>
                </div>
                <div className="p-4">
                  <UnifiedOptionsChart
                    expiries={activeSymbolData.expiries}
                    spot={activeSymbolData.spot}
                    gammaFlip={activeSymbolData.selected_levels?.gamma_flip || activeSymbolData.totalGexData?.flip_point}
                    maxPain={activeSymbolData.selected_levels?.max_pain}
                    topStrikesCount={12}
                  />
                </div>
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
