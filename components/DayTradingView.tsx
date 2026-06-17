/**
 * DayTradingView — Clean, simple day trading key levels view
 *
 * Shows only the most important intraday levels: support/resistance,
 * GEX regime badge, and spot price. No noise.
 *
 * @module components/DayTradingView
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ExpiryFilter, DayTradingLevel } from '../types';
import { useOptionsData } from '../hooks/useOptionsData';
import { formatCompact, formatStrike, formatDistance, formatGEX, formatTimestamp } from '../utils/formatting';
import { IconRefresh } from './Icons';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYMBOLS = ['SPY', 'QQQ', 'SPX', 'NDX'] as const;

const EXPIRY_OPTIONS: { key: ExpiryFilter; label: string }[] = [
  { key: '0dte', label: '0 DTE' },
  { key: '1-7dte', label: '1-7 DTE' },
  { key: '8-30dte', label: '8-30 DTE' },
  { key: '30+dte', label: '30+ DTE' },
  { key: 'all', label: 'All' },
];

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
        <span className="text-[11px] text-gray-500 w-6 shrink-0 font-medium">OI</span>
        <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.1)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${oiPct}%`, backgroundColor: 'rgba(99,102,241,0.6)' }}
          />
        </div>
        <span className="text-[11px] font-mono text-gray-400 w-12 text-right">
          {formatCompact(oi)}
        </span>
      </div>
      {/* Vol bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-500 w-6 shrink-0 font-medium">Vol</span>
        <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.1)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${volPct}%`, backgroundColor: 'rgba(34,197,94,0.6)' }}
          />
        </div>
        <span className="text-[11px] font-mono text-gray-400 w-12 text-right">
          {formatCompact(vol)}
        </span>
      </div>
    </div>
  );
};

/** Single level row — renders regular and cross-symbol levels */
const LevelRow: React.FC<{
  level: DayTradingLevel;
  isHovered: boolean;
  onHover: (strike: number | null) => void;
  maxOI: number;
  maxVol: number;
  futuresEquivalent?: number;
  futuresSymbol?: string;
}> = ({ level, isHovered, onHover, maxOI, maxVol, futuresEquivalent, futuresSymbol }) => {
  const isResistance = level.type === 'resistance';
  const isCross = !!level.isCrossSymbol;

  // Cross-symbol levels use amber/gold accent; regular levels use red/green
  const color = isCross ? '#f59e0b' : (isResistance ? '#f87171' : '#4ade80');

  // Always use primary symbol's OI/Vol (same scale as regular levels)

  return (
    <div
      onMouseEnter={() => onHover(level.strike)}
      onMouseLeave={() => onHover(null)}
      className="flex flex-col px-4 py-2.5 rounded-lg transition-all duration-150 cursor-default"
      style={{
        backgroundColor: isHovered
          ? (isCross ? 'rgba(245,158,11,0.08)' : (isResistance ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)'))
          : (isCross ? 'rgba(245,158,11,0.03)' : 'transparent'),
        borderLeft: isCross ? '2px solid rgba(245,158,11,0.3)' : 'none',
      }}
    >
      <div className="grid grid-cols-[80px_192px_64px_1fr] gap-4 items-center">
        {/* Strike price */}
        <div className="flex flex-col">
          <span className="font-mono text-base font-bold" style={{ color }}>
            ${level.strike.toFixed(0)}
          </span>
          {futuresEquivalent != null && futuresSymbol && (
            <span className="text-[10px] font-mono text-gray-500 font-medium whitespace-nowrap">
              {futuresSymbol} ~{futuresEquivalent.toFixed(0)}
            </span>
          )}
        </div>

        {/* Label badge — amber ★ Cross-Symbol or regular label */}
        <div className="flex items-center">
          {isCross ? (
            <span
              className="text-[12px] font-semibold px-2.5 py-0.5 rounded"
              style={{
                backgroundColor: 'rgba(245,158,11,0.15)',
                color: '#f59e0b',
              }}
            >
              ★ Cross-Symbol
            </span>
          ) : (
            <span
              className="text-[12px] font-semibold px-2.5 py-0.5 rounded"
              style={{
                backgroundColor: isResistance ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                color,
              }}
            >
              {level.label}
            </span>
          )}
        </div>

        {/* Distance */}
        <span
          className="text-sm font-mono font-semibold text-right"
          style={{ color }}
        >
          {formatDistance(level.distance)}
        </span>

        {/* OI/Vol visual bars */}
        <div className="flex justify-start pl-2">
          <OIVolBars oi={level.totalOI} vol={level.totalVolume} maxOI={maxOI} maxVol={maxVol} />
        </div>
      </div>

      {/* Cross-symbol sub-row: paired symbol info with OI/Vol */}
      {isCross && level.pairedSymbol && level.pairedStrike != null && (
        <div className="flex items-center gap-2 mt-1.5" style={{ marginLeft: '96px' }}>
          <span className="text-xs text-amber-400/60 font-bold">↳</span>
          <span className="text-xs text-gray-400">
            {level.pairedSymbol}: <strong className="text-gray-200 font-mono">${level.pairedStrike.toFixed(0)}</strong>
            {level.pairedWallType && (
              <span className="ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-400/10 text-amber-400/80">
                {level.pairedWallType === 'put' ? 'Put Wall' : level.pairedWallType === 'call' ? 'Call Wall' : level.pairedWallType}
              </span>
            )}
            {level.pairedOI != null && (
              <span className="ml-2.5 text-gray-500 font-mono">| OI: <span className="text-gray-300">{formatCompact(level.pairedOI)}</span></span>
            )}
            {level.pairedVol != null && (
              <span className="ml-2.5 text-gray-500 font-mono">| Vol: <span className="text-gray-300">{formatCompact(level.pairedVol)}</span></span>
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
  const colors: Record<string, { bg: string; text: string; icon: string }> = {
    positive: { bg: 'rgba(34,197,94,0.15)', text: '#4ade80', icon: '▲' },
    negative: { bg: 'rgba(239,68,68,0.15)', text: '#f87171', icon: '▼' },
    neutral:  { bg: 'rgba(148,163,184,0.15)', text: '#94a3b8', icon: '◆' },
  };
  const c = colors[regime];

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold"
        style={{ backgroundColor: c.bg, color: c.text }}
      >
        <span>{c.icon}</span>
        <span>{label}</span>
        <span className="text-xs opacity-75 font-mono">({formatGEX(netGEX)})</span>
      </div>
      {flipPoint !== null && (
        <span className="text-xs text-gray-400 pl-1 font-medium">
          Flip: <strong className="text-gray-300 font-mono">${formatStrike(flipPoint)}</strong>
        </span>
      )}
    </div>
  );
};

/** Trading Guide Accordion component */
const TradingGuide: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden transition-all duration-300">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-sm">💡</span>
          <span className="text-sm font-semibold text-gray-300">Guida Operativa: Come usare questi livelli</span>
        </div>
        <span className={`text-xs text-gray-500 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>
      
      {isOpen && (
        <div className="px-4 pb-4 pt-1.5 border-t border-slate-800/50 text-xs text-gray-400 space-y-3.5 animate-fadeIn">
          <div>
            <h4 className="font-bold text-gray-200 mb-1 flex items-center gap-1.5 text-[13px]">
              <span className="text-red-400 text-xs">🛑</span> Major Gamma Wall (Supporti e Resistenze dei Market Maker)
            </h4>
            <p className="pl-4 leading-relaxed text-gray-400">
              Rappresentano i livelli chiave con la massima concentrazione di contratti dei Market Maker:
              <br />
              • <strong className="text-red-400/90">Call Wall (Resistenza)</strong>: Funziona come un soffitto. Ottimo livello per chiudere i Long o valutare Short di rimbalzo (Mean Reversion).
              <br />
              • <strong className="text-green-400/90">Put Wall (Supporto)</strong>: Funziona come un pavimento. Ottimo livello per comprare (entrare Long) o chiudere gli Short.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-gray-200 mb-1 flex items-center gap-1.5 text-[13px]">
              <span className="text-blue-400 text-xs">⇄</span> Gamma Flip (Pivot di Volatilità)
            </h4>
            <p className="pl-4 leading-relaxed text-gray-400">
              La linea di confine che separa i due regimi di volatilità del mercato:
              <br />
              • <strong className="text-green-400/90">Sopra il Flip (Positive Gamma - Regime Calmo)</strong>: Le oscillazioni tendono a rimbalzare sui supporti/resistenze. Compra i supporti e vendi le resistenze.
              <br />
              • <strong className="text-red-400/90">Sotto il Flip (Negative Gamma - Regime Volatile)</strong>: I movimenti sono rapidi ed estesi. Favorisci le rotture dei livelli (breakout) e il trend-following.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-gray-200 mb-1 flex items-center gap-1.5 text-[13px]">
              <span className="text-purple-400 text-xs">📅</span> Scelta delle Scadenze (Filtro DTE)
            </h4>
            <p className="pl-4 leading-relaxed text-gray-400">
              • <strong className="text-gray-300">0 DTE (Intraday)</strong>: Livelli dinamici per la sessione odierna. Perfetti per scalping e trading veloce.
              <br />
              • <strong className="text-gray-300">1-7 DTE / All (Strutturali)</strong>: Livelli istituzionali più stabili, fungono da forti barriere di medio periodo.
            </p>
          </div>
        </div>
      )}
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
    data,
    loading,
    error,
    symbol,
    setSymbol,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    highlightedStrike,
    setHighlightedStrike,
    lastRefreshed,
    liveSpot,
  } = state;

  // ---- Last updated text ----
  const lastUpdatedText = useMemo(() => {
    if (!data?.timestamp) return '';
    return formatTimestamp(data.timestamp);
  }, [data?.timestamp]);

  // ---- Sorted levels ----
  // Resistance: descending by strike (highest first → closest to spot at bottom)
  const sortedResistance = useMemo(() => {
    if (!data) return [];
    return [...data.resistance].sort((a, b) => b.strike - a.strike);
  }, [data]);

  // Support: descending by strike (closest to spot first → furthest at bottom)
  const sortedSupport = useMemo(() => {
    if (!data) return [];
    return [...data.support].sort((a, b) => b.strike - a.strike);
  }, [data]);

  // ---- Cross-symbol detection ----
  const hasCrossSymbolLevels = useMemo(() => {
    if (!data) return false;
    return [...data.resistance, ...data.support].some(l => l.isCrossSymbol);
  }, [data]);

  // ---- Max OI / Vol for bar normalization ----
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

  // ---- Futures Basis & Equivalent Calculations ----
  const futuresSymbol = useMemo(() => {
    return (symbol === 'SPY' || symbol === 'SPX') ? 'ES' : 'NQ';
  }, [symbol]);

  const futuresBasis = useMemo(() => {
    if (!liveSpot) return 0;
    if (symbol === 'SPX' || symbol === 'SPY') {
      const es = liveSpot.ES;
      const spx = liveSpot.SPX;
      if (es && spx) return es - spx;
    } else if (symbol === 'NDX' || symbol === 'QQQ') {
      const nq = liveSpot.NQ;
      const ndx = liveSpot.NDX;
      if (nq && ndx) return nq - ndx;
    }
    return 0;
  }, [liveSpot, symbol]);

  const indexToEtfRatio = useMemo(() => {
    if (!liveSpot) return 1;
    if (symbol === 'SPY' && liveSpot.SPX && liveSpot.SPY) return liveSpot.SPX / liveSpot.SPY;
    if (symbol === 'QQQ' && liveSpot.NDX && liveSpot.QQQ) return liveSpot.NDX / liveSpot.QQQ;
    return 1;
  }, [liveSpot, symbol]);

  const calculateFuturesEquivalent = (strike: number) => {
    let eq = strike;
    if (symbol === 'SPY' || symbol === 'QQQ') {
      eq = eq * indexToEtfRatio;
    }
    return eq + futuresBasis;
  };

  // ---- Update flash animation state ----
  const [flashVisible, setFlashVisible] = useState(false);

  // ---- Cross-symbol visibility toggle ----
  const [showCrossSymbol, setShowCrossSymbol] = useState(true);

  useEffect(() => {
    if (showUpdatedFlash) {
      setFlashVisible(true);
      const timer = setTimeout(() => setFlashVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showUpdatedFlash]);

  // ---- Loading / Error states ----
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={handleRefresh} />;
  if (!data) return <ErrorState message="No data available" onRetry={handleRefresh} />;

  const { spot, gexRegime } = data;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0d1117' }}>
      {/* ================================================================== */}
      {/* HEADER BAR                                                         */}
      {/* ================================================================== */}
      <header className="border-b border-gray-800 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          {/* Symbol tabs */}
          <div className="flex items-center gap-1">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150"
                style={{
                  backgroundColor: symbol === s ? '#1e293b' : 'transparent',
                  color: symbol === s ? '#e2e8f0' : '#64748b',
                  border: symbol === s ? '1px solid #334155' : '1px solid transparent',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Right side: expiry + refresh */}
          <div className="flex items-center gap-3">
            {/* Expiry filter */}
            <select
              value={expiryFilter}
              onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
              className="bg-[#1e293b] border border-gray-700 text-gray-300 text-sm rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>

            {/* Cross-symbol toggle */}
            {hasCrossSymbolLevels && (
              <button
                onClick={() => setShowCrossSymbol(!showCrossSymbol)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-150"
                style={{
                  backgroundColor: showCrossSymbol ? 'rgba(245,158,11,0.15)' : 'transparent',
                  color: showCrossSymbol ? '#f59e0b' : '#64748b',
                  border: showCrossSymbol ? '1px solid rgba(245,158,11,0.3)' : '1px solid transparent',
                }}
                title={showCrossSymbol ? 'Hide cross-symbol levels' : 'Show cross-symbol levels'}
              >
                <span>★</span>
                <span>Cross</span>
              </button>
            )}

            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              title={lastUpdatedText ? `Last updated: ${lastUpdatedText}` : 'Refresh'}
            >
              <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdatedText && (
                <span className="text-[11px] text-gray-500">{lastUpdatedText}</span>
              )}
            </button>

            {/* Background refresh indicator */}
            {isBackgroundRefreshing && (
              <span className="inline-flex items-center gap-1 text-[11px] text-blue-400/80 animate-pulse">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
                Refreshing…
              </span>
            )}

            {/* Flash on new data — animated badge */}
            {flashVisible && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 animate-pulse">
                ✓ Updated
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ================================================================== */}
      {/* MAIN CONTENT                                                       */}
      {/* ================================================================== */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {/* ---- Symbol + Spot + Regime ---- */}
          <div className="mb-6">
            <div className="flex items-baseline gap-3 mb-2">
              <h1 className="text-2xl font-bold text-gray-100">{data.symbol}</h1>
              <span className="text-2xl font-mono font-bold text-white">
                ${spot.toFixed(2)}
              </span>
            </div>
            <RegimeBadge
              regime={gexRegime.regime}
              label={gexRegime.label}
              netGEX={gexRegime.netGEX}
              flipPoint={gexRegime.flipPoint}
            />
          </div>

          {/* Operational Guide */}
          <TradingGuide />

          {/* ---- RESISTANCE ---- */}
          {sortedResistance.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 px-4 mb-1.5">
                <div className="h-px flex-1 bg-red-900/40" />
                <span className="text-xs font-semibold tracking-widest text-red-400/70 uppercase">
                  Resistance
                </span>
                <div className="h-px flex-1 bg-red-900/40" />
              </div>
              <div className="flex flex-col gap-0.5">
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
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---- SPOT LINE ---- */}
          <div className="flex items-center gap-4 my-4 px-4">
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, #3b82f6, transparent)' }} />
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-bold text-blue-400 tracking-wider uppercase">Spot</span>
              <span className="text-base font-mono font-bold text-blue-300">${spot.toFixed(2)}</span>
            </div>
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, #3b82f6, transparent)' }} />
          </div>

          {/* ---- SUPPORT ---- */}
          {sortedSupport.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 px-4 mb-1.5">
                <div className="h-px flex-1 bg-green-900/40" />
                <span className="text-xs font-semibold tracking-widest text-green-400/70 uppercase">
                  Support
                </span>
                <div className="h-px flex-1 bg-green-900/40" />
              </div>
              <div className="flex flex-col gap-0.5">
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
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---- Empty state ---- */}
          {sortedResistance.filter(l => showCrossSymbol || !l.isCrossSymbol).length === 0 &&
           sortedSupport.filter(l => showCrossSymbol || !l.isCrossSymbol).length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <p className="text-sm">No key levels found for this expiry filter.</p>
              <p className="text-xs mt-1">Try changing the DTE filter or symbol.</p>
            </div>
          )}
        </div>
      </main>

      {/* ================================================================== */}
      {/* FOOTER                                                             */}
      {/* ================================================================== */}
      <footer className="border-t border-gray-800/50 px-4 py-2">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-[10px] text-gray-600">
          <span>Options Flow Analysis</span>
          {lastRefreshed && (
            <span>Fetched {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
