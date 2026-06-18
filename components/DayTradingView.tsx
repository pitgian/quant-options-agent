/**
 * DayTradingView — Redesigned Side-by-Side Day Trading Key Levels View
 *
 * Shows S&P 500 and Nasdaq 100 side-by-side, listing support/resistance key levels,
 * GEX regime, spot/futures prices, and Kronos AI expected ranges with confluence indicators.
 *
 * @module components/DayTradingView
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ExpiryFilter, DayTradingLevel, DayTradingData, KronosForecast } from '../types';
import { useOptionsData } from '../hooks/useOptionsData';
import { formatCompact, formatStrike, formatDistance, formatGEX, formatTimestamp } from '../utils/formatting';
import { IconRefresh } from './Icons';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPIRY_OPTIONS: { key: ExpiryFilter; label: string }[] = [
  { key: '0dte', label: '0 DTE' },
  { key: '1-7dte', label: '1-7 DTE' },
  { key: '8-30dte', label: '8-30 DTE' },
  { key: '30+dte', label: '30+ DTE' },
  { key: 'all', label: 'All' },
];

const KRONOS_TIMEFRAMES: { key: '15m' | '30m' | '1h' | '2h' | '4h' | 'EOD' | '2D' | '3D' | '1W'; label: string }[] = [
  { key: '15m', label: '15m' },
  { key: '30m', label: '30m' },
  { key: '1h', label: '1h' },
  { key: '2h', label: '2h' },
  { key: '4h', label: '4h' },
  { key: 'EOD', label: 'EOD (1 G)' },
  { key: '2D', label: '2 Giorni' },
  { key: '3D', label: '3 Giorni' },
  { key: '1W', label: '1 Settimana' },
];

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/** Extract and compute scaled forecast ranges based on selected timeframe */
function getActiveKronosForecast(
  biasItem: any,
  etfData: DayTradingData,
  timeframe: string
) {
  if (!biasItem || !etfData || !etfData.spot) return null;

  const is5m = timeframe === '15m' || timeframe === '30m';
  const is15m = timeframe === '1h' || timeframe === '2h';
  const is1h = timeframe === '4h' || timeframe === 'EOD';
  const is4h = timeframe === '2D' || timeframe === '3D';
  const isDaily = timeframe === '1W';
  const isStable = is4h || isDaily;
  
  const resolutionData = is5m 
    ? biasItem.forecast_5m 
    : is15m
      ? biasItem.forecast_15m
      : is1h 
        ? biasItem.forecast_1h 
        : is4h
          ? biasItem.forecast_4h
          : biasItem.forecast_1d;
  
  const activeData = resolutionData || {
    last_price: biasItem.last_price || 0,
    expected_high: biasItem.expected_high || 0,
    expected_low: biasItem.expected_low || 0,
    predicted_volatility_pct: biasItem.predicted_volatility_pct || 0,
    candles: biasItem.candles || []
  };

  if (!activeData || !activeData.candles || activeData.candles.length === 0) return null;

  const forecastLastPrice = activeData.last_price || etfData.spot;
  const liveEtfPrice = etfData.spot;
  const scaleRatio = isStable ? 1.0 : liveEtfPrice / forecastLastPrice;
  const lastPrice = isStable ? (activeData.last_price || liveEtfPrice) : liveEtfPrice;

  let candleCount = 4;
  if (timeframe === '15m') candleCount = 3;      // 3 * 5m = 15m
  else if (timeframe === '30m') candleCount = 6;  // 6 * 5m = 30m
  else if (timeframe === '1h') candleCount = 4;   // 4 * 15m = 1h
  else if (timeframe === '2h') candleCount = 8;   // 8 * 15m = 2h
  else if (timeframe === '4h') candleCount = 4;   // 4 * 1h = 4h
  else if (timeframe === 'EOD') candleCount = 7;  // 7 * 1h = 7h (EOD)
  else if (timeframe === '2D') candleCount = 4;   // 4 * 4h = 16h
  else if (timeframe === '3D') candleCount = 6;   // 6 * 4h = 24h
  else if (timeframe === '1W') candleCount = 5;   // 5 * 1d = 5 days (1 week)

  const sliced = activeData.candles.slice(0, candleCount);
  if (sliced.length === 0) return null;

  const scaledCandles = sliced.map((c: any) => ({
    ...c,
    open: c.open * scaleRatio,
    high: c.high * scaleRatio,
    low: c.low * scaleRatio,
    close: c.close * scaleRatio
  }));

  const targetPrice = scaledCandles[scaledCandles.length - 1].close;
  const expectedHigh = Math.max(lastPrice, ...scaledCandles.map((c: any) => c.high));
  const expectedLow = Math.min(lastPrice, ...scaledCandles.map((c: any) => c.low));
  const volatilityPct = ((expectedHigh - expectedLow) / lastPrice) * 100;
  const deltaPct = ((targetPrice - lastPrice) / lastPrice) * 100;

  let trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (deltaPct > 0.05) {
    trendBias = 'BULLISH';
  } else if (deltaPct < -0.05) {
    trendBias = 'BEARISH';
  }

  return {
    lastPrice,
    targetPrice,
    expectedHigh,
    expectedLow,
    volatilityPct,
    trendBias,
    strengthPct: deltaPct,
    candles: scaledCandles
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** OI/Vol bars — two small inline bars showing relative OI and Volume strength */
const OIVolBars: React.FC<{
  oi: number;
  vol: number;
  maxOI: number;
  maxVol: number;
}> = ({ oi, vol, maxOI, maxVol }) => {
  const oiPct = maxOI > 0 ? Math.min(100, (oi / maxOI) * 100) : 0;
  const volPct = maxVol > 0 ? Math.min(100, (vol / maxVol) * 100) : 0;

  return (
    <div className="flex flex-col gap-0.5">
      {/* OI bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-500 w-5 shrink-0 font-semibold font-mono">OI</span>
        <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${oiPct}%`, backgroundColor: 'rgba(99,102,241,0.65)' }}
          />
        </div>
        <span className="text-[10px] font-mono text-gray-400 w-10 text-right">
          {formatCompact(oi)}
        </span>
      </div>
      {/* Vol bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-500 w-5 shrink-0 font-semibold font-mono">VO</span>
        <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${volPct}%`, backgroundColor: 'rgba(34,197,94,0.65)' }}
          />
        </div>
        <span className="text-[10px] font-mono text-gray-400 w-10 text-right">
          {formatCompact(vol)}
        </span>
      </div>
    </div>
  );
};

/** Single level row — renders regular and cross-symbol levels */
interface LevelRowProps {
  level: DayTradingLevel;
  isHovered: boolean;
  onHover: (strike: number | null) => void;
  maxOI: number;
  maxVol: number;
  futuresEquivalent?: number;
  futuresSymbol?: string;
  isKrHigh?: boolean;
  isKrLow?: boolean;
}

const LevelRow: React.FC<LevelRowProps> = ({
  level,
  isHovered,
  onHover,
  maxOI,
  maxVol,
  futuresEquivalent,
  futuresSymbol,
  isKrHigh,
  isKrLow,
}) => {
  const isResistance = level.type === 'resistance';
  const isCross = !!level.isCrossSymbol;

  // Cross-symbol levels use amber/gold accent; regular levels use red/green
  const color = isCross ? '#f59e0b' : (isResistance ? '#f87171' : '#4ade80');

  return (
    <div
      onMouseEnter={() => onHover(level.strike)}
      onMouseLeave={() => onHover(null)}
      className="flex flex-col px-2 sm:px-3 py-2 rounded-lg transition-all duration-150 cursor-default"
      style={{
        backgroundColor: isHovered
          ? (isCross ? 'rgba(245,158,11,0.08)' : (isResistance ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)'))
          : (isCross ? 'rgba(245,158,11,0.03)' : 'transparent'),
        borderLeft: isCross ? '2px solid rgba(245,158,11,0.4)' : 'none',
      }}
    >
      <div className="grid grid-cols-[65px_1fr_45px] sm:grid-cols-[80px_160px_54px_1fr] gap-2 sm:gap-2.5 items-center">
        {/* Strike price */}
        <div className="flex flex-col">
          <span className="font-mono text-xs sm:text-sm font-bold" style={{ color }}>
            ${level.strike.toFixed(0)}
          </span>
          {futuresEquivalent != null && futuresSymbol && (
            <span className="text-[8px] sm:text-[9px] font-mono text-gray-500 font-semibold whitespace-nowrap">
              {futuresSymbol} ~{futuresEquivalent.toFixed(0)}
            </span>
          )}
        </div>

        {/* Label badges */}
        <div className="flex items-center gap-1 flex-wrap">
          {isCross ? (
            <span
              className="text-[8px] sm:text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 border border-amber-500/10"
              title="Confluenza Cross-Symbol tra ETF e Indice"
            >
              ★ Confl.
            </span>
          ) : (
            <span
              className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: isResistance ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
                color,
              }}
            >
              {level.label}
            </span>
          )}

          {isKrHigh && (
            <span
              className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20"
              title="Massimo previsto da Kronos AI"
            >
              🎯 Kr High
            </span>
          )}

          {isKrLow && (
            <span
              className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20"
              title="Minimo previsto da Kronos AI"
            >
              🎯 Kr Low
            </span>
          )}
        </div>

        {/* Distance */}
        <span
          className="text-[10px] sm:text-xs font-mono font-semibold text-right"
          style={{ color }}
        >
          {formatDistance(level.distance)}
        </span>

        {/* OI/Vol visual bars: visible on desktop, hidden on mobile */}
        <div className="hidden sm:flex justify-end pl-1 shrink-0">
          <OIVolBars oi={level.totalOI} vol={level.totalVolume} maxOI={maxOI} maxVol={maxVol} />
        </div>
      </div>

      {/* Mobile-only inline text metrics row */}
      <div className="sm:hidden mt-1.5 flex justify-between items-center text-[9px] text-gray-500 border-t border-slate-800/25 pt-1 font-semibold">
        <span>OI: <strong className="text-gray-400 font-mono">{formatCompact(level.totalOI)}</strong></span>
        <span>Vol: <strong className="text-gray-400 font-mono">{formatCompact(level.totalVolume)}</strong></span>
      </div>

      {/* Cross-symbol paired info sub-row */}
      {isCross && level.pairedSymbol && level.pairedStrike != null && (
        <div className="flex items-center gap-1.5 mt-1.5 pl-3 sm:pl-[80px]">
          <span className="text-[10px] text-amber-400/50 font-bold">↳</span>
          <span className="text-[9px] sm:text-[10px] text-gray-500">
            {level.pairedSymbol}: <strong className="text-gray-300 font-mono">${level.pairedStrike.toFixed(0)}</strong>
            {level.pairedWallType && (
              <span className="ml-1.5 px-1 py-0.2 text-[8px] font-bold rounded bg-amber-400/10 text-amber-400/70 border border-amber-400/10 uppercase font-mono">
                {level.pairedWallType === 'put' ? 'Put' : level.pairedWallType === 'call' ? 'Call' : level.pairedWallType}
              </span>
            )}
            {level.pairedOI != null && (
              <span className="ml-2 text-gray-650 font-mono">OI: <span className="text-gray-400">{formatCompact(level.pairedOI)}</span></span>
            )}
          </span>
        </div>
      )}
    </div>
  );
};

/** GEX Regime badge */
const RegimeBadge: React.FC<{
  regime: 'positive' | 'negative' | 'neutral';
  label: string;
  netGEX: number;
  flipPoint: number | null;
}> = ({ regime, label, netGEX, flipPoint }) => {
  const colors: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    positive: { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.2)', text: '#4ade80', icon: '▲' },
    negative: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.2)', text: '#f87171', icon: '▼' },
    neutral:  { bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.2)', text: '#94a3b8', icon: '◆' },
  };
  const c = colors[regime];

  return (
    <div className="flex flex-col gap-1">
      <div
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border"
        style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
      >
        <span>{c.icon}</span>
        <span>{label}</span>
        <span className="text-[10px] opacity-80 font-mono">({formatGEX(netGEX)})</span>
      </div>
      {flipPoint !== null && (
        <span className="text-[10px] text-gray-400 pl-1 font-semibold">
          GEX Flip: <strong className="text-gray-200 font-mono">${formatStrike(flipPoint)}</strong>
        </span>
      )}
    </div>
  );
};

/** Trading Guide Accordion component */
const TradingGuide: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-[#161b22]/40 overflow-hidden transition-all duration-300">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-sm">💡</span>
          <span className="text-xs font-semibold text-gray-300">Guida Operativa & Legenda Livelli Intraday</span>
        </div>
        <span className={`text-[10px] text-gray-500 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>
      
      {isOpen && (
        <div className="px-5 pb-5 pt-2 border-t border-slate-800/50 text-[11px] text-gray-400 space-y-4 animate-fadeIn">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h4 className="font-extrabold text-indigo-400 mb-1.5 uppercase tracking-wider text-[11px]">🎯 GEX Regime & Flip</h4>
              <p className="leading-relaxed text-gray-300 text-[11px]">
                Sopra il <strong>GEX Flip Point</strong> (Gamma Positivo) predomina il contenimento della volatilità (Mean Reversion).
                Sotto il Flip (Gamma Negativo) si scatenano trend direzionali rapidi e scatti improvvisi dovuti alle coperture dei Market Maker.
              </p>
            </div>
            <div>
              <h4 className="font-extrabold text-amber-500 mb-1.5 uppercase tracking-wider text-[11px]">★ Confluenza Cross-Symbol</h4>
              <p className="leading-relaxed text-gray-300 text-[11px]">
                Evidenziata con la dicitura <strong>★ Confl.</strong> dorata. Indica allineamento geometrico tra il prezzo dell'ETF (SPY/QQQ) e del rispettivo Indice Cash (SPX/NDX). I livelli in confluenza rappresentano barriere volumetriche molto resistenti.
              </p>
            </div>
            <div>
              <h4 className="font-extrabold text-blue-400 mb-1.5 uppercase tracking-wider text-[11px]">🤖 Proiezioni Kronos AI</h4>
              <p className="leading-relaxed text-gray-300 text-[11px]">
                Parentesi statistica generata dall'IA per il timeframe selezionato. I segnali <strong>🎯 Kr High</strong> e <strong>🎯 Kr Low</strong> apposti sui livelli evidenziano le barriere reali più prossime agli estremi previsionali calcolati.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Market Levels Column Component
// ---------------------------------------------------------------------------

interface MarketLevelsColumnProps {
  market: 'SP500' | 'NASDAQ100';
  defaultSymbol: 'SPY' | 'QQQ';
  etfSymbol: 'SPY' | 'QQQ';
  indexSymbol: 'SPX' | 'NDX';
  futuresSymbol: 'ES' | 'NQ';
  etfData: DayTradingData | null;
  indexData: DayTradingData | null;
  liveSpot: any;
  kronosForecast: KronosForecast | null;
  kronosTimeframe: string;
  showCrossSymbol: boolean;
}

const MarketLevelsColumn: React.FC<MarketLevelsColumnProps> = ({
  market,
  defaultSymbol,
  etfSymbol,
  indexSymbol,
  futuresSymbol,
  etfData,
  indexData,
  liveSpot,
  kronosForecast,
  kronosTimeframe,
  showCrossSymbol,
}) => {
  const [activeSymbol, setActiveSymbol] = useState<'SPY' | 'SPX' | 'QQQ' | 'NDX'>(defaultSymbol);
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(null);

  // Derive the active symbol's data
  const data = useMemo(() => {
    return activeSymbol === etfSymbol ? etfData : indexData;
  }, [activeSymbol, etfSymbol, etfData, indexData]);

  // Derive active symbol spot price
  const spot = useMemo(() => {
    if (activeSymbol === etfSymbol) {
      return liveSpot[etfSymbol] || etfData?.spot || 0;
    } else {
      return liveSpot[indexSymbol] || indexData?.spot || 0;
    }
  }, [activeSymbol, etfSymbol, indexSymbol, liveSpot, etfData, indexData]);

  // Futures basis and equivalent calculations
  const futuresBasis = useMemo(() => {
    if (!liveSpot) return 0;
    const es = liveSpot[futuresSymbol];
    const spx = liveSpot[indexSymbol];
    if (es && spx) return es - spx;
    return 0;
  }, [liveSpot, futuresSymbol, indexSymbol]);

  const indexToEtfRatio = useMemo(() => {
    if (!liveSpot) return 1;
    const idxSpot = liveSpot[indexSymbol];
    const etfSpot = liveSpot[etfSymbol];
    if (idxSpot && etfSpot) return idxSpot / etfSpot;
    return 1;
  }, [liveSpot, indexSymbol, etfSymbol]);

  const calculateFuturesEquivalent = (strike: number) => {
    let eq = strike;
    if (activeSymbol === etfSymbol) {
      eq = eq * indexToEtfRatio;
    }
    return eq + futuresBasis;
  };

  // Sorted levels
  const sortedResistance = useMemo(() => {
    if (!data) return [];
    return [...data.resistance].sort((a, b) => b.strike - a.strike);
  }, [data]);

  const sortedSupport = useMemo(() => {
    if (!data) return [];
    return [...data.support].sort((a, b) => b.strike - a.strike);
  }, [data]);

  // Max values for normalization
  const { maxOI, maxVol } = useMemo(() => {
    if (!data) return { maxOI: 0, maxVol: 0 };
    const allLevels = [...data.resistance, ...data.support];
    let maxOI = 0;
    let maxVol = 0;
    for (const l of allLevels) {
      if (l.totalOI > maxOI) maxOI = l.totalOI;
      if (l.totalVolume > maxVol) maxVol = l.totalVolume;
    }
    return { maxOI, maxVol };
  }, [data]);

  // Kronos expectations extraction
  const biasItem = useMemo(() => {
    if (!kronosForecast) return null;
    return market === 'SP500' ? kronosForecast.SP500_bias : kronosForecast.NASDAQ_bias;
  }, [kronosForecast, market]);

  const activeForecast = useMemo(() => {
    if (!biasItem || !etfData) return null;
    return getActiveKronosForecast(biasItem, etfData, kronosTimeframe);
  }, [biasItem, etfData, kronosTimeframe]);

  const indexToEtfMultiplier = activeSymbol === indexSymbol ? indexToEtfRatio : 1;

  // Closest key levels to Kronos High/Low boundaries
  const closestToKrHigh = useMemo(() => {
    if (!activeForecast || sortedResistance.length === 0) return null;
    const krHigh = activeForecast.expectedHigh * indexToEtfMultiplier;
    return sortedResistance.reduce((prev, curr) => 
      Math.abs(curr.strike - krHigh) < Math.abs(prev.strike - krHigh) ? curr : prev
    );
  }, [activeForecast, sortedResistance, indexToEtfMultiplier]);

  const closestToKrLow = useMemo(() => {
    if (!activeForecast || sortedSupport.length === 0) return null;
    const krLow = activeForecast.expectedLow * indexToEtfMultiplier;
    return sortedSupport.reduce((prev, curr) => 
      Math.abs(curr.strike - krLow) < Math.abs(prev.strike - krLow) ? curr : prev
    );
  }, [activeForecast, sortedSupport, indexToEtfMultiplier]);

  if (!data) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-center min-h-[400px]">
        <div className="animate-pulse flex space-x-2 items-center">
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce"></div>
        </div>
        <span className="text-gray-500 text-xs mt-3">Caricamento dati per {market}...</span>
      </div>
    );
  }

  const { spot: dataSpot, gexRegime } = data;
  const etfSpot = liveSpot[etfSymbol] || etfData?.spot || 0;
  const indexSpot = liveSpot[indexSymbol] || indexData?.spot || 0;
  const futuresSpot = liveSpot[futuresSymbol] || 0;

  return (
    <div className="bg-[#161b22] border border-slate-850 rounded-2xl p-3.5 sm:p-5 lg:p-6 flex flex-col gap-4 sm:gap-5 shadow-xl transition-all hover:border-slate-800">
      {/* Column Title & Selector */}
      <div className="flex justify-between items-center border-b border-slate-800/60 pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-extrabold text-slate-100">
            {market === 'SP500' ? '🇺🇸 S&P 500' : '💻 Nasdaq 100'}
          </span>
          <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider font-mono">
            {market === 'SP500' ? 'SPY/SPX/ES' : 'QQQ/NDX/NQ'}
          </span>
        </div>

        {/* Local Toggle */}
        <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-850">
          <button
            onClick={() => setActiveSymbol(etfSymbol)}
            className="px-2.5 py-1 rounded-md text-[10px] font-extrabold transition-all duration-150"
            style={{
              backgroundColor: activeSymbol === etfSymbol ? '#1e293b' : 'transparent',
              color: activeSymbol === etfSymbol ? '#e2e8f0' : '#64748b',
            }}
          >
            {etfSymbol}
          </button>
          <button
            onClick={() => setActiveSymbol(indexSymbol)}
            className="px-2.5 py-1 rounded-md text-[10px] font-extrabold transition-all duration-150"
            style={{
              backgroundColor: activeSymbol === indexSymbol ? '#1e293b' : 'transparent',
              color: activeSymbol === indexSymbol ? '#e2e8f0' : '#64748b',
            }}
          >
            {indexSymbol}
          </button>
        </div>
      </div>

      {/* Spot details and GEX Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-[#0d1117]/40 border border-slate-850 rounded-xl p-4">
        {/* Spot info cell */}
        <div className="flex flex-col justify-center">
          <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Spot Price ({activeSymbol})</span>
          <span className="text-xl font-mono font-bold text-white mt-0.5">
            ${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <div className="mt-2 text-[9px] text-gray-400 space-y-0.5 font-semibold border-t border-slate-850 pt-2">
            <div className="flex justify-between">
              <span>Cash ETF ({etfSymbol}):</span>
              <span className="font-mono text-gray-300">${etfSpot > 0 ? etfSpot.toFixed(2) : 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span>Cash Index ({indexSymbol}):</span>
              <span className="font-mono text-gray-300">${indexSpot > 0 ? indexSpot.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span>Futures Spot ({futuresSymbol}):</span>
              <span className="font-mono text-gray-300">${futuresSpot > 0 ? futuresSpot.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'N/A'}</span>
            </div>
          </div>
        </div>

        {/* GEX State Cell */}
        <div className="flex flex-col gap-2 justify-center border-t md:border-t-0 md:border-l border-slate-850 pt-3 md:pt-0 md:pl-4">
          <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Stato Mercato & GEX</span>
          <RegimeBadge
            regime={gexRegime.regime}
            label={gexRegime.label}
            netGEX={gexRegime.netGEX}
            flipPoint={gexRegime.flipPoint}
          />
          {(data.volatilitySkew25d !== undefined || data.putCallOiRatio !== undefined) && (
            <div className="grid grid-cols-2 gap-1 border-t border-slate-850 pt-1.5 text-[9px] font-semibold text-gray-500">
              {data.volatilitySkew25d !== undefined && (
                <div className="flex flex-col">
                  <span>Skew 25D</span>
                  <span className="text-[10px] font-mono font-bold text-amber-400 mt-0.5">
                    {data.volatilitySkew25d > 0 ? '+' : ''}{(data.volatilitySkew25d * 100).toFixed(1)}%
                  </span>
                </div>
              )}
              {data.putCallOiRatio !== undefined && (
                <div className="flex flex-col">
                  <span>P/C Ratio (OI)</span>
                  <span className="text-[10px] font-mono font-bold text-indigo-400 mt-0.5">
                    {data.putCallOiRatio.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Kronos AI expectations card */}
      {activeForecast ? (
        <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 flex flex-col gap-2">
          <div className="flex justify-between items-center border-b border-blue-500/10 pb-1.5">
            <span className="text-[9px] text-blue-400 font-bold uppercase tracking-wider">🤖 Previsioni Kronos AI</span>
            <span className="text-[9px] text-slate-500 font-semibold font-mono">Zoom: {kronosTimeframe}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center items-center">
            <div className="flex flex-col items-center">
              <span className="text-[9px] text-gray-500 uppercase font-bold">Trend Bias</span>
              <span className={`text-[11px] font-extrabold mt-1 uppercase px-1.5 py-0.5 rounded ${
                activeForecast.trendBias === 'BULLISH' ? 'text-green-400 bg-green-500/10' :
                activeForecast.trendBias === 'BEARISH' ? 'text-red-400 bg-red-500/10' : 'text-gray-400 bg-gray-500/10'
              }`}>
                {activeForecast.trendBias === 'BULLISH' ? 'Rialzista' :
                 activeForecast.trendBias === 'BEARISH' ? 'Ribassista' : 'Neutrale'}
              </span>
            </div>
            
            <div className="flex flex-col items-center col-span-2 border-l border-slate-850">
              <span className="text-[9px] text-gray-500 uppercase font-bold">Range Atteso</span>
              <span className="text-[11px] font-mono font-bold text-slate-200 mt-1">
                ${(activeForecast.expectedLow * indexToEtfMultiplier).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} - ${(activeForecast.expectedHigh * indexToEtfMultiplier).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </span>
            </div>
          </div>
          <div className="flex justify-between items-center mt-1 pt-1.5 border-t border-blue-500/10 text-[9px] text-gray-500 font-semibold">
            <span>Volatilità Prevista: <strong className="text-gray-300 font-mono">{(activeForecast.volatilityPct).toFixed(3)}%</strong></span>
            <span className={`px-1.5 py-0.2 rounded text-[8px] font-bold uppercase ${
              activeForecast.volatilityPct > 0.4 ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'
            }`}>
              {activeForecast.volatilityPct > 0.4 ? 'Elevata' : 'Bassa'}
            </span>
          </div>
        </div>
      ) : (
        <div className="bg-slate-900/30 border border-slate-850 rounded-xl p-3 text-center text-[10px] text-gray-500 italic">
          Previsioni Kronos AI non disponibili per questo timeframe.
        </div>
      )}

      {/* Levels list layout */}
      <div className="flex flex-col gap-1.5">
        
        {/* RESISTANCES */}
        {sortedResistance.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="text-[9px] font-bold tracking-widest text-red-400/80 uppercase">Resistenze</span>
              <div className="h-px flex-1 bg-red-900/20" />
            </div>
            <div className="flex flex-col gap-0.5 max-h-[350px] overflow-y-auto pr-1 select-none">
              {sortedResistance
                .filter(level => showCrossSymbol || !level.isCrossSymbol)
                .map((level) => (
                  <LevelRow
                    key={`res-${level.strike}`}
                    level={level}
                    isHovered={highlightedStrike === level.strike}
                    onHover={setHighlightedStrike}
                    maxOI={maxOI}
                    maxVol={maxVol}
                    futuresEquivalent={calculateFuturesEquivalent(level.strike)}
                    futuresSymbol={futuresSymbol}
                    isKrHigh={closestToKrHigh?.strike === level.strike}
                    isKrLow={closestToKrLow?.strike === level.strike}
                  />
                ))}
            </div>
          </div>
        )}

        {/* SPOT BASILINE */}
        <div className="flex items-center gap-3 my-1.5 px-2">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, rgba(59,130,246,0.3), transparent)' }} />
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Spot</span>
            <span className="text-xs font-mono font-bold text-blue-300">${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, rgba(59,130,246,0.3), transparent)' }} />
        </div>

        {/* SUPPORTS */}
        {sortedSupport.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="flex flex-col gap-0.5 max-h-[350px] overflow-y-auto pr-1 select-none">
              {sortedSupport
                .filter(level => showCrossSymbol || !level.isCrossSymbol)
                .map((level) => (
                  <LevelRow
                    key={`sup-${level.strike}`}
                    level={level}
                    isHovered={highlightedStrike === level.strike}
                    onHover={setHighlightedStrike}
                    maxOI={maxOI}
                    maxVol={maxVol}
                    futuresEquivalent={calculateFuturesEquivalent(level.strike)}
                    futuresSymbol={futuresSymbol}
                    isKrHigh={closestToKrHigh?.strike === level.strike}
                    isKrLow={closestToKrLow?.strike === level.strike}
                  />
                ))}
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 mt-1">
              <span className="text-[9px] font-bold tracking-widest text-green-400/80 uppercase">Supporti</span>
              <div className="h-px flex-1 bg-green-900/20" />
            </div>
          </div>
        )}

        {/* Empty state check */}
        {sortedResistance.filter(l => showCrossSymbol || !l.isCrossSymbol).length === 0 &&
         sortedSupport.filter(l => showCrossSymbol || !l.isCrossSymbol).length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <p className="text-xs">Nessun livello rilevante per questa scadenza.</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

interface DayTradingViewProps {
  sharedState?: any;
}

export function DayTradingView({ sharedState }: DayTradingViewProps) {
  const localState = useOptionsData();
  const state = sharedState || localState;

  const {
    loading,
    error,
    spyData,
    spxData,
    qqqData,
    ndxData,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    lastRefreshed,
    kronosForecast,
    liveSpot,
  } = state;

  const [kronosTimeframe, setKronosTimeframe] = useState<'15m' | '30m' | '1h' | '2h' | '4h' | 'EOD' | '2D' | '3D' | '1W'>('1h');
  const [showCrossSymbol, setShowCrossSymbol] = useState(true);
  const [flashVisible, setFlashVisible] = useState(false);

  useEffect(() => {
    if (showUpdatedFlash) {
      setFlashVisible(true);
      const timer = setTimeout(() => setFlashVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showUpdatedFlash]);

  const lastUpdatedText = useMemo(() => {
    const activeRef = spyData || qqqData || spxData || ndxData;
    if (!activeRef?.timestamp) return '';
    return formatTimestamp(activeRef.timestamp);
  }, [spyData, qqqData, spxData, ndxData]);

  // Loading & error states at application level
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={handleRefresh} />;
  if (!spyData && !qqqData) return <ErrorState message="No data available" onRetry={handleRefresh} />;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0d1117' }}>
      
      {/* GLOBAL CONTROL HEADER */}
      <header className="border-b border-gray-800 bg-[#161b22]/50 px-4 py-3 sm:px-6">
        <div className="max-w-[1850px] mx-auto flex items-center justify-between gap-3 flex-wrap">
          
          <div className="flex items-center gap-2.5 sm:gap-4 flex-wrap">
            <h1 className="text-xs sm:text-sm font-bold text-gray-200">🎯 Livelli Intraday <span className="hidden sm:inline">(Dual Market View)</span></h1>
            
            {/* Kronos global Timeframe */}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">Kronos:</span>
              <div className="flex items-center bg-[#0d1117] rounded-lg p-0.5 border border-slate-850 overflow-x-auto max-w-[180px] sm:max-w-none">
                {KRONOS_TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.key}
                    onClick={() => setKronosTimeframe(tf.key)}
                    className="px-1.5 py-0.5 sm:px-2 sm:py-1 rounded text-[8px] sm:text-[9px] font-extrabold transition-all duration-150 whitespace-nowrap"
                    style={{
                      backgroundColor: kronosTimeframe === tf.key ? '#1e293b' : 'transparent',
                      color: kronosTimeframe === tf.key ? '#e2e8f0' : '#64748b',
                    }}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Expiry filter */}
            <select
              value={expiryFilter}
              onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
              className="bg-[#161b22] border border-slate-800 text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 font-semibold"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>

            {/* Cross-symbol toggle */}
            <button
              onClick={() => setShowCrossSymbol(!showCrossSymbol)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-extrabold transition-all duration-150"
              style={{
                backgroundColor: showCrossSymbol ? 'rgba(245,158,11,0.15)' : 'transparent',
                borderColor: showCrossSymbol ? 'rgba(245,158,11,0.25)' : 'transparent',
                color: showCrossSymbol ? '#f59e0b' : '#64748b',
                borderWidth: '1px'
              }}
              title={showCrossSymbol ? 'Nascondi confluenze' : 'Mostra confluenze'}
            >
              <span>★ Confluenze</span>
            </button>

            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              title={lastUpdatedText ? `Aggiornato: ${lastUpdatedText}` : 'Aggiorna'}
            >
              <IconRefresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdatedText && (
                <span className="text-[10px] text-gray-500 font-semibold font-mono">{lastUpdatedText}</span>
              )}
            </button>

            {/* Background refresh indicator */}
            {isBackgroundRefreshing && (
              <span className="inline-flex items-center gap-1 text-[10px] text-blue-400/80 animate-pulse font-semibold">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
                Aggiornamento…
              </span>
            )}

            {/* Flash on new data */}
            {flashVisible && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 animate-pulse border border-green-500/20">
                ✓ Aggiornato
              </span>
            )}
          </div>
        </div>
      </header>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 px-6 py-6">
        <div className="max-w-[1850px] mx-auto flex flex-col gap-4">
          
          {/* Trading operational guide at the top */}
          <TradingGuide />

          {/* S&P 500 and Nasdaq 100 Column Grid */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 w-full pb-10">
            {/* LEFT COLUMN: S&P 500 */}
            <MarketLevelsColumn
              market="SP500"
              defaultSymbol="SPY"
              etfSymbol="SPY"
              indexSymbol="SPX"
              futuresSymbol="ES"
              etfData={spyData}
              indexData={spxData}
              liveSpot={liveSpot}
              kronosForecast={kronosForecast}
              kronosTimeframe={kronosTimeframe}
              showCrossSymbol={showCrossSymbol}
            />

            {/* RIGHT COLUMN: Nasdaq 100 */}
            <MarketLevelsColumn
              market="NASDAQ100"
              defaultSymbol="QQQ"
              etfSymbol="QQQ"
              indexSymbol="NDX"
              futuresSymbol="NQ"
              etfData={qqqData}
              indexData={ndxData}
              liveSpot={liveSpot}
              kronosForecast={kronosForecast}
              kronosTimeframe={kronosTimeframe}
              showCrossSymbol={showCrossSymbol}
            />
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-gray-800/40 px-6 py-2.5 text-[10px] text-gray-600 flex justify-between">
        <span>Gamma & Volatility Analytics Portal — Dual Intraday View</span>
        {lastRefreshed && (
          <span>Fetched: {lastRefreshed.toLocaleTimeString()}</span>
        )}
      </footer>
    </div>
  );
}
