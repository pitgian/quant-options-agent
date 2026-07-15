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
import { EXPIRY_OPTIONS } from '../lib/expiry';
import { KRONOS_TIMEFRAMES, getActiveKronosForecast as computeKronosForecast, type KronosTimeframe } from '../lib/kronos';
import { DayTradingHeader } from './DayTradingHeader';
import { IconRefresh } from './Icons';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// EXPIRY_OPTIONS and KRONOS_TIMEFRAMES now live in lib/expiry.ts and lib/kronos.ts.

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Kronos forecast extraction/scaling now lives in lib/kronos.ts
// (getActiveKronosForecast). Previously this file carried a local copy of
// the same ~90-line timeframe→resolution + candle-scaling logic. The thin
// wrapper below preserves the original (biasItem, etfData, timeframe)
// call signature used by the JSX in this component.
// ---------------------------------------------------------------------------
function getActiveKronosForecast(
  biasItem: KronosForecast['SP500_bias'] | null | undefined,
  etfData: DayTradingData | null,
  timeframe: KronosTimeframe
) {
  if (!etfData) return null;
  return computeKronosForecast(biasItem, etfData.spot, timeframe);
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
  activeSymbol?: string;
  isKrHigh?: boolean;
  isKrLow?: boolean;
  /** Futures-scale equivalent of the cross-symbol paired strike (NQ/ES), if any. */
  pairedFuturesEquivalent?: number;
}

const LevelRow: React.FC<LevelRowProps> = ({
  level,
  isHovered,
  onHover,
  maxOI,
  maxVol,
  futuresEquivalent,
  futuresSymbol,
  activeSymbol,
  isKrHigh,
  isKrLow,
  pairedFuturesEquivalent,
}) => {
  const isResistance = level.type === 'resistance';
  // isCrossSymbol = a cross-ONLY level (no regular wall): full amber treatment
  // and hidden by the "Confluenze" toggle. hasCrossConfluence = any level that
  // coincides with a cross match (including walls a cross reinforces): shows the
  // ★ badge + paired sub-row, but keeps the wall's own color and stays visible.
  const isCross = !!level.isCrossSymbol;
  const showConfluence = !!level.hasCrossConfluence;

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
      <div className="grid grid-cols-[85px_1fr_45px] sm:grid-cols-[105px_160px_54px_1fr] gap-2 sm:gap-2.5 items-center">
        {/* Price block — futures is the HEADLINE (what the trader operates on),
            ETF/Index strike is the secondary context line below it. */}
        <div className="flex flex-col">
          {futuresEquivalent != null && futuresSymbol ? (
            <span className="font-mono text-xs sm:text-sm font-extrabold text-blue-300 whitespace-nowrap">
              {futuresSymbol} ${futuresEquivalent.toFixed(0)}
            </span>
          ) : (
            <span className="font-mono text-xs sm:text-sm font-bold" style={{ color }}>
              ${level.strike.toFixed(0)}
            </span>
          )}
          {futuresEquivalent != null && futuresSymbol && activeSymbol && (
            <span className="text-[9px] sm:text-[10px] font-mono text-gray-500 whitespace-nowrap">
              {activeSymbol} {level.strike.toFixed(level.strike >= 1000 ? 0 : 1)}
            </span>
          )}
        </div>

        {/* Label badges */}
        <div className="flex items-center gap-1 flex-wrap">
          {/* Cross-ONLY levels (no wall underneath) get the full amber badge
              as their identity. Walls that a cross reinforces keep their own
              label (Put Wall / Call Wall) and get a small ★ chip beside it. */}
          {!isCross && (
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
          {showConfluence && (
            <span
              className="text-[8px] sm:text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 border border-amber-500/10"
              title="Confluenza Cross-Symbol tra ETF e Indice"
            >
              {isCross ? '★ Confl.' : '★'}
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

      {/* Cross-symbol paired info sub-row.
          Headline = futures-scale equivalent (NQ/ES) of the paired strike,
          so the whole row reads in the same scale as the level above it;
          the cash index/etf strike is the secondary context line. */}
      {showConfluence && level.pairedSymbol && level.pairedStrike != null && (
        <div className="flex items-center gap-1.5 mt-1.5 pl-3 sm:pl-[80px]">
          <span className="text-[10px] text-amber-400/50 font-bold">↳</span>
          <span className="text-[9px] sm:text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap">
            {pairedFuturesEquivalent != null && futuresSymbol ? (
              <span className="font-mono text-amber-300/90 font-bold">
                {futuresSymbol} ${pairedFuturesEquivalent.toFixed(0)}
              </span>
            ) : null}
            <span className="text-gray-600">
              {level.pairedSymbol} ${level.pairedStrike.toFixed(0)}
            </span>
            {level.pairedWallType && (
              <span className="px-1 py-0.2 text-[8px] font-bold rounded bg-amber-400/10 text-amber-400/70 border border-amber-400/10 uppercase font-mono">
                {level.pairedWallType === 'put' ? 'Put' : level.pairedWallType === 'call' ? 'Call' : level.pairedWallType}
              </span>
            )}
            {level.pairedOI != null && (
              <span className="font-mono">OI: <span className="text-gray-400">{formatCompact(level.pairedOI)}</span></span>
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
  defaultSymbol: 'SPY' | 'SPX' | 'QQQ' | 'NDX';
  etfSymbol: 'SPY' | 'QQQ';
  indexSymbol: 'SPX' | 'NDX';
  futuresSymbol: 'ES' | 'NQ';
  etfData: DayTradingData | null;
  indexData: DayTradingData | null;
  liveSpot: any;
  kronosForecast: KronosForecast | null;
  kronosTimeframe: KronosTimeframe;
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

  // Futures-scale equivalent of a CROSS-SYMBOL paired strike. The paired strike
  // lives in the PAIRED symbol's scale (the opposite of the primary): when the
  // page shows the ETF (QQQ), the paired is the index (NDX) and its strike is
  // already index-scale, so only the basis is added; when the page shows the
  // index, the paired is the ETF and needs the ratio too. activeSymbol is
  // always the ETF on this page, but handle both for correctness.
  const calculatePairedFuturesEquivalent = (pairedStrike: number, pairedSymbol?: string) => {
    const pairedIsEtf = pairedSymbol?.toUpperCase() === etfSymbol.toUpperCase();
    let eq = pairedIsEtf ? pairedStrike * indexToEtfRatio : pairedStrike;
    return eq + futuresBasis;
  };

  // Re-classify levels in FUTURES scale against the LIVE futures spot.
  //
  // The original support/resistance type is assigned at generation time in
  // keyLevelService.ts against the FROZEN ETF spot (QQQ). When the market
  // rallies after generation, a put wall that was below the frozen QQQ spot
  // stays labeled "support" even after the live price crosses it; converting
  // it to the futures scale (× ratio + basis) then pushes it ABOVE the live
  // NQ spot — so the page showed "supports" above the current price.
  //
  // Fix: take every level (support + resistance), project it into the futures
  // scale we actually display, and re-derive its type from the live futures
  // spot. This enforces "support below price, resistance above" in the exact
  // scale the user reads. Falls back to the original classification when no
  // live futures spot is available (pre-market / data glitch). Labels that
  // describe the wall's nature ("Put Wall", "Major Gamma Wall") are kept as-is
  // — they identify the OI concentration, not the side of the price.
  const { sortedResistance, sortedSupport } = useMemo(() => {
    if (!data) return { sortedResistance: [], sortedSupport: [] };
    const all = [...data.resistance, ...data.support];
    const futSpot = liveSpot[futuresSymbol];
    if (!futSpot) {
      // No live futures anchor: keep the generation-time classification.
      return {
        sortedResistance: [...data.resistance].sort((a, b) => b.strike - a.strike),
        sortedSupport: [...data.support].sort((a, b) => b.strike - a.strike),
      };
    }
    // Inline the futures conversion so this memo only depends on its own
    // inputs (calculateFuturesEquivalent is recreated every render and would
    // otherwise be a stale-closure footgun in the dependency array).
    const toFut = (strike: number) =>
      (activeSymbol === etfSymbol ? strike * indexToEtfRatio : strike) + futuresBasis;
    const reclassified = all.map((lvl) => {
      const futStrike = toFut(lvl.strike);
      const type: 'support' | 'resistance' = futStrike < futSpot ? 'support' : 'resistance';
      const distance = (Math.abs(futStrike - futSpot) / futSpot) * 100;
      return { ...lvl, type, distance };
    });
    return {
      sortedResistance: reclassified
        .filter((l) => l.type === 'resistance')
        .sort((a, b) => b.strike - a.strike),
      sortedSupport: reclassified
        .filter((l) => l.type === 'support')
        .sort((a, b) => b.strike - a.strike),
    };
  }, [data, liveSpot, futuresSymbol, activeSymbol, etfSymbol, indexToEtfRatio, futuresBasis]);

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

        {/* Local Toggle — removed: index (SPX/NDX) view is not used.
            activeSymbol stays locked on the ETF (SPY/QQQ) default; the
            futures headline + ETF secondary is the only view shipped. */}
      </div>

      {/* ⚡ FUTURES HERO BAR — the price the trader actually operates on (ES/NQ) */}
      {futuresSpot > 0 && (
        <div className="bg-gradient-to-r from-blue-500/15 to-indigo-500/10 border border-blue-500/30 rounded-xl p-3.5 flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-[9px] text-blue-300 uppercase font-extrabold tracking-widest flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {futuresSymbol} FUTURES · LIVE
            </span>
            <span className="text-2xl sm:text-3xl font-mono font-extrabold text-white mt-0.5 leading-none">
              ${futuresSpot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
          </div>
          <div className="flex flex-col items-end text-right">
            <span className="text-[9px] text-gray-400 uppercase font-bold tracking-wider">Basis vs {indexSymbol}</span>
            <span
              className="text-sm font-mono font-bold mt-0.5"
              style={{ color: futuresBasis >= 0 ? '#4ade80' : '#f87171' }}
              title={`${futuresSymbol} − ${indexSymbol} (premium/discount sul fair value)`}
            >
              {futuresBasis >= 0 ? '+' : ''}{futuresBasis.toFixed(1)} pts
              <span className="text-[10px] text-gray-500 ml-1">
                ({futuresBasis >= 0 ? '+' : ''}{(futuresBasis / indexSpot * 100).toFixed(2)}%)
              </span>
            </span>
            <span className="text-[8px] text-gray-500 mt-0.5 font-mono">
              1 {indexSymbol} = {(indexToEtfRatio).toFixed(2)} {etfSymbol}
            </span>
          </div>
        </div>
      )}

      {/* Spot context & GEX Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-[#0d1117]/40 border border-slate-850 rounded-xl p-4">
        {/* Spot info cell — secondary context (ETF + Index cash) */}
        <div className="flex flex-col justify-center">
          <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Cash Reference ({activeSymbol})</span>
          <span className="text-lg font-mono font-bold text-slate-200 mt-0.5">
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
                    activeSymbol={activeSymbol}
                    isKrHigh={closestToKrHigh?.strike === level.strike}
                    isKrLow={closestToKrLow?.strike === level.strike}
                    pairedFuturesEquivalent={
                      level.isCrossSymbol && level.pairedStrike != null
                        ? calculatePairedFuturesEquivalent(level.pairedStrike, level.pairedSymbol)
                        : undefined
                    }
                  />
                ))}
            </div>
          </div>
        )}

        {/* SPOT BASELINE — shows both the active cash symbol AND the live futures price the trader uses */}
        <div className="flex items-center gap-3 my-1.5 px-2">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, rgba(59,130,246,0.3), transparent)' }} />
          <div className="flex items-center gap-3 flex-wrap justify-center">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Spot {activeSymbol}</span>
              <span className="text-xs font-mono font-bold text-blue-300">${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            {futuresSpot > 0 && (
              <div className="flex items-center gap-1.5 pl-2 border-l border-slate-700/50">
                <span className="text-[10px] font-extrabold text-blue-300 uppercase tracking-wider">⚡ {futuresSymbol}</span>
                <span className="text-xs font-mono font-extrabold text-white">${futuresSpot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
              </div>
            )}
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
                    activeSymbol={activeSymbol}
                    isKrHigh={closestToKrHigh?.strike === level.strike}
                    isKrLow={closestToKrLow?.strike === level.strike}
                    pairedFuturesEquivalent={
                      level.isCrossSymbol && level.pairedStrike != null
                        ? calculatePairedFuturesEquivalent(level.pairedStrike, level.pairedSymbol)
                        : undefined
                    }
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
  sharedState: ReturnType<typeof useOptionsData>;
}

export function DayTradingView({ sharedState }: DayTradingViewProps) {
  const state = sharedState;

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

  const [kronosTimeframe, setKronosTimeframe] = useState<KronosTimeframe>('1d');
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
      <DayTradingHeader
        kronosTimeframe={kronosTimeframe}
        setKronosTimeframe={setKronosTimeframe}
        expiryFilter={expiryFilter}
        setExpiryFilter={setExpiryFilter}
        showCrossSymbol={showCrossSymbol}
        setShowCrossSymbol={setShowCrossSymbol}
        refreshing={refreshing}
        handleRefresh={handleRefresh}
        lastUpdatedText={lastUpdatedText}
        isBackgroundRefreshing={isBackgroundRefreshing}
        flashVisible={flashVisible}
      />
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
        <span>QuantFlow AI — Dual Intraday View</span>
        {lastRefreshed && (
          <span>Fetched: {lastRefreshed.toLocaleTimeString()}</span>
        )}
      </footer>
    </div>
  );
}
