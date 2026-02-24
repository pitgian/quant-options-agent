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
import { SymbolData, ExpiryData, OptionData, QuantMetrics, PutCallRatios, VolatilitySkew, GEXData, SelectedLevels } from '../types';

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
  gammaFlip: `Gamma Flip - Punto di inversione gamma

COS'È: Il prezzo dove l'esposizione gamma cumulativa passa da positiva a negativa.

COME USARLO:
• Se prezzo > Gamma Flip: dealer comprano su rally (supporto rialzista)
• Se prezzo < Gamma Flip: dealer vendono su drop (pressione ribassista)
• Più vicino al prezzo attuale = maggiore probabilità di movimento direzionale

STRATEGIA: Livello chiave per capire la direzione del mercato.`,

  totalGex: `Total GEX - Esposizione Gamma Totale

COS'È: Somma di tutta l'esposizione gamma dei dealer in miliardi di dollari.

COME USARLO:
• GEX > 0 (positivo): Mercato stabile, dealer assorbono volatilità
• GEX < 0 (negativo): Mercato volatile, dealer amplificano movimenti
• |GEX| > 5B = impatto significativo

STRATEGIA: GEX negativo = evita posizioni large, usa stop loss stretti.`,

  maxPain: `Max Pain - Dolore Massimo per i Trader

COS'È: Lo strike price dove il valore totale delle opzioni in scadenza è minimo.

COME USARLO:
• I market maker spingono il prezzo verso questo livello
• Distanza < 2% dal spot = forte attrazione magnetica

STRATEGIA: Se il prezzo è lontano dal Max Pain, aspettati una mossa verso di esso.`,

  pcrOiBased: `Put/Call Ratio basato su Open Interest

COS'È: Rapporto tra Put OI e Call OI.
• PCR > 1.0 = sentimento ribassista
• PCR < 0.7 = sentimento rialzista
• PCR estremi (>1.5 o <0.5) = possibile inversione contrarian`,

  pcrVolume: `Put/Call Ratio basato su Volume

COS'È: Rapporto tra volume put e call di oggi.
• Volume PCR > OI PCR = aumento attività put (nuova paura)
• Volume PCR < OI PCR = aumento attività call (nuovo ottimismo)`,

  pcrWeighted: `Put/Call Ratio Ponderato

COS'È: PCR pesato per volume. Dà più peso alle opzioni con alta attività.
• Più sensibile alle opzioni ATM e near-term`,

  pcrDeltaAdj: `Put/Call Ratio Aggiustato per Delta

COS'È: PCR pesato per il delta delle opzioni.
• Il più sofisticato per analisi professionale del rischio.`,

  skewType: `Tipo di Volatility Skew

COS'È: La forma della curva di volatilità implicita.
• SMIRK: Put costose = paura, mercato difensivo
• REVERSE SMIRK: Call costose = euforia, mercato aggressivo`,

  skewRatio: `Skew Ratio - Rapporto IV Put/Call

COS'È: Rapporto tra volatilità implicita media put e call OTM.
• Ratio > 1.2 = SKEW RIBASSISTA
• Ratio < 0.9 = SKEW RIALZISTA`
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

/**
 * Identify Call Walls (resistance) and Put Walls (support)
 */
function calculateWalls(options: OptionData[], spot: number, topN: number = 3): { callWalls: number[]; putWalls: number[] } {
  // Call walls: strike > spot, sorted by OI descending
  const calls = options
    .filter(opt => opt.side === 'CALL' && opt.strike > spot && opt.oi > 0)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, topN)
    .map(opt => opt.strike);

  // Put walls: strike < spot, sorted by OI descending
  const puts = options
    .filter(opt => opt.side === 'PUT' && opt.strike < spot && opt.oi > 0)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, topN)
    .map(opt => opt.strike);

  return { callWalls: calls, putWalls: puts };
}

/**
 * Find confluence levels (strike appears in multiple expiries)
 */
function findConfluenceLevels(expiries: ExpiryData[], spot: number): Map<number, string[]> {
  const strikeExpiries: Map<number, string[]> = new Map();

  for (const expiry of expiries) {
    const strikes = new Set(expiry.options.map(opt => opt.strike));
    for (const strike of strikes) {
      if (!strikeExpiries.has(strike)) {
        strikeExpiries.set(strike, []);
      }
      strikeExpiries.get(strike)!.push(expiry.label);
    }
  }

  // Filter to only strikes appearing in 2+ expiries
  const confluenceLevels: Map<number, string[]> = new Map();
  for (const [strike, expiryList] of strikeExpiries) {
    if (expiryList.length >= 2) {
      confluenceLevels.set(strike, expiryList);
    }
  }

  return confluenceLevels;
}

/**
 * Find resonance levels (strike appears in ALL expiries)
 */
function findResonanceLevels(expiries: ExpiryData[], spot: number): number[] {
  if (expiries.length < 2) return [];

  const strikeCounts: Map<number, number> = new Map();

  for (const expiry of expiries) {
    const strikes = new Set(expiry.options.map(opt => opt.strike));
    for (const strike of strikes) {
      strikeCounts.set(strike, (strikeCounts.get(strike) || 0) + 1);
    }
  }

  // Resonance = appears in all expiries
  const resonanceLevels: number[] = [];
  for (const [strike, count] of strikeCounts) {
    if (count === expiries.length) {
      resonanceLevels.push(strike);
    }
  }

  return resonanceLevels.sort((a, b) => a - b);
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
                tooltip="Volatilità implicita media put OTM"
                className="text-[11px] text-gray-400 block"
              />
              <span className="text-base font-bold text-red-400 font-mono block mt-1">{(metrics.volatility_skew.put_iv_avg * 100).toFixed(0)}%</span>
            </div>
            <div>
              <MetricLabel
                label="Call IV"
                tooltip="Volatilità implicita media call OTM"
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
}> = ({ level, type, spot, expiries = [], oi }) => {
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
      case 'RESONANCE': return 'Livello con risonanza multipla';
      case 'CONFLUENCE': return `Confluence: ${expiries.join(' + ')}`;
      case 'GAMMA_FLIP': return 'Punto di inversione gamma';
      case 'MAX_PAIN': return 'Target magnetico MM';
      case 'CALL_WALL': return 'Resistenza principale';
      case 'PUT_WALL': return 'Supporto principale';
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

  return (
    <div
      className={`group relative p-4 rounded-xl border transition-all flex items-center justify-between gap-6
        ${t.bg} ${t.border} hover:scale-[1.01] hover:border-white/20`}
    >
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-3 mb-2">
          <span className={`text-[10px] font-black uppercase tracking-tight px-2.5 py-0.5 rounded shadow-sm ${t.label} ${t.pulse}`}>
            {t.icon} {getLabel()}
          </span>
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
            {type === 'CALL_WALL' ? 'RESISTENZA' : type === 'PUT_WALL' ? 'SUPPORTO' : getDescription()}
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
 * Options table component
 */
function OptionsTable({
  title,
  options,
  side
}: {
  title: string;
  options: OptionData[];
  side: 'CALL' | 'PUT';
}): ReactElement {
  const sideColor = side === 'CALL' ? 'text-green-400' : 'text-red-400';
  const borderColor = side === 'CALL' ? 'border-green-500/30' : 'border-red-500/30';

  return (
    <div className={`bg-gray-800/30 rounded-lg border ${borderColor} overflow-hidden`}>
      <div className={`px-4 py-2 bg-gray-800/50 border-b ${borderColor}`}>
        <h5 className={`font-medium ${sideColor}`}>{title}</h5>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase tracking-wider">
              <th className="px-4 py-2 text-left">Strike</th>
              <th className="px-4 py-2 text-right">OI</th>
              <th className="px-4 py-2 text-right">Vol</th>
              <th className="px-4 py-2 text-right">IV</th>
            </tr>
          </thead>
          <tbody>
            {options.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-4 text-center text-gray-500">
                  No {side} options available
                </td>
              </tr>
            ) : (
              options.map((opt, idx) => (
                <tr
                  key={`${opt.strike}-${idx}`}
                  className="border-t border-gray-700/30 hover:bg-gray-700/20 transition-colors"
                >
                  <td className="px-4 py-2 font-mono">{formatCurrency(opt.strike)}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatNumber(opt.oi, 0)}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatNumber(opt.vol, 0)}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatNumber(opt.iv * 100, 1)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
  }, [data]);

  // Calculate quantitative analysis
  const quantAnalysis = useMemo(() => {
    if (!activeSymbolData || !activeSymbolData.expiries || activeSymbolData.expiries.length === 0) {
      return null;
    }

    const spot = activeSymbolData.spot;
    const expiries = activeSymbolData.expiries;
    const selectedLevels = activeSymbolData.selected_levels;

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

    // Calculate sentiment
    const sentiment = aggregatedMetrics ? calculateSentiment(aggregatedMetrics) : 'neutral';

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
      selectedLevels // Pass through for displayLevels
    };
  }, [activeSymbolData]);

  // Build levels array for display
  const displayLevels = useMemo(() => {
    if (!quantAnalysis) return { aboveSpot: [], belowSpot: [] };

    const levels: Array<{
      level: number;
      type: 'CALL_WALL' | 'PUT_WALL' | 'GAMMA_FLIP' | 'MAX_PAIN' | 'CONFLUENCE' | 'RESONANCE';
      expiries: string[];
      oi?: number;
    }> = [];

    const spot = quantAnalysis.spot;

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

    // Add Resonance levels
    for (const strike of quantAnalysis.resonanceLevels) {
      levels.push({
        level: strike,
        type: 'RESONANCE',
        expiries: ['0DTE', 'WEEKLY', 'MONTHLY']
      });
    }

    // Add Confluence levels
    for (const [strike, expiryList] of quantAnalysis.confluenceLevels) {
      // Skip if already added as resonance
      if (!quantAnalysis.resonanceLevels.includes(strike)) {
        levels.push({
          level: strike,
          type: 'CONFLUENCE',
          expiries: expiryList
        });
      }
    }

    // Add Call Walls - use selectedLevels OI if available, otherwise lookup
    if (quantAnalysis.selectedLevels) {
      for (const wall of quantAnalysis.selectedLevels.call_walls) {
        levels.push({
          level: wall.strike,
          type: 'CALL_WALL',
          expiries: [wall.expiry],
          oi: wall.oi
        });
      }
    } else {
      for (const strike of quantAnalysis.walls.callWalls) {
        const opt = quantAnalysis.allOptions.find(o => o.strike === strike && o.side === 'CALL');
        levels.push({
          level: strike,
          type: 'CALL_WALL',
          expiries: ['0DTE'],
          oi: opt?.oi
        });
      }
    }

    // Add Put Walls - use selectedLevels OI if available, otherwise lookup
    if (quantAnalysis.selectedLevels) {
      for (const wall of quantAnalysis.selectedLevels.put_walls) {
        levels.push({
          level: wall.strike,
          type: 'PUT_WALL',
          expiries: [wall.expiry],
          oi: wall.oi
        });
      }
    } else {
      for (const strike of quantAnalysis.walls.putWalls) {
        const opt = quantAnalysis.allOptions.find(o => o.strike === strike && o.side === 'PUT');
        levels.push({
          level: strike,
          type: 'PUT_WALL',
          expiries: ['0DTE'],
          oi: opt?.oi
        });
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
                    <p className="text-[10px] text-green-500 font-bold uppercase tracking-widest opacity-80">Quant Analysis Active</p>
                  </div>
                </div>

                {/* Sentiment Display */}
                <SentimentDisplay
                  sentiment={quantAnalysis.sentiment}
                  gammaFlipCluster={quantAnalysis.aggregatedMetrics.gamma_flip}
                />

                {/* Levels Display */}
                <div className="flex flex-col gap-2">
                  {displayLevels.aboveSpot.map((l, i) => (
                    <LevelRow
                      key={`above-${i}`}
                      level={l.level}
                      type={l.type}
                      spot={quantAnalysis.spot}
                      expiries={l.expiries}
                      oi={l.oi}
                    />
                  ))}

                  {/* Spot Price Divider */}
                  <div className="py-6 flex items-center gap-6">
                    <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-indigo-500/40 to-indigo-500/40"></div>
                    <div className="shrink-0 bg-indigo-600 px-6 py-2 rounded-full border border-indigo-400 shadow-[0_0_15px_rgba(79,70,229,0.3)]">
                      <span className="text-[12px] font-black text-white uppercase tracking-[0.2em]">LIVE SPOT: {quantAnalysis.spot.toFixed(2)}</span>
                    </div>
                    <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-indigo-500/40 to-indigo-500/40"></div>
                  </div>

                  {displayLevels.belowSpot.map((l, i) => (
                    <LevelRow
                      key={`below-${i}`}
                      level={l.level}
                      type={l.type}
                      spot={quantAnalysis.spot}
                      expiries={l.expiries}
                      oi={l.oi}
                    />
                  ))}
                </div>

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
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          <OptionsTable title="Top 5 CALL Levels (by OI)" options={topCalls} side="CALL" />
                          <OptionsTable title="Top 5 PUT Levels (by OI)" options={topPuts} side="PUT" />
                        </div>
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
