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

/** Strength bar — small inline bar showing 0-100 score */
const StrengthBar: React.FC<{ value: number; color: string }> = ({ value, color }) => (
  <div className="flex items-center gap-1.5">
    <div className="w-16 h-1.5 rounded-full bg-gray-700/50 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, value)}%`, backgroundColor: color }}
      />
    </div>
    <span className="text-[10px] text-gray-500 w-6 text-right">{value}</span>
  </div>
);

/** Single level row — renders regular and cross-symbol levels */
const LevelRow: React.FC<{
  level: DayTradingLevel;
  isHovered: boolean;
  onHover: (strike: number | null) => void;
}> = ({ level, isHovered, onHover }) => {
  const isResistance = level.type === 'resistance';
  const isCross = !!level.isCrossSymbol;

  // Cross-symbol levels use amber/gold accent; regular levels use red/green
  const color = isCross ? '#f59e0b' : (isResistance ? '#f87171' : '#4ade80');

  // For cross-symbol: prefer combined metrics, fall back to regular
  const displayOI = isCross && level.combinedOI != null ? level.combinedOI : level.totalOI;
  const displayVol = isCross && level.combinedVol != null ? level.combinedVol : level.totalVolume;
  const displayStrength = level.strength;

  return (
    <div
      onMouseEnter={() => onHover(level.strike)}
      onMouseLeave={() => onHover(null)}
      className="flex flex-col px-4 py-2 rounded-lg transition-all duration-150 cursor-default"
      style={{
        backgroundColor: isHovered
          ? (isCross ? 'rgba(245,158,11,0.08)' : (isResistance ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)'))
          : (isCross ? 'rgba(245,158,11,0.03)' : 'transparent'),
        borderLeft: isCross ? '2px solid rgba(245,158,11,0.3)' : 'none',
      }}
    >
      <div className="flex items-center gap-3">
        {/* Strike price */}
        <span className="font-mono text-sm font-semibold w-16" style={{ color }}>
          ${level.strike.toFixed(0)}
        </span>

        {/* Label badge — amber ★ Cross-Symbol or regular label */}
        {isCross ? (
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded"
            style={{
              backgroundColor: 'rgba(245,158,11,0.15)',
              color: '#f59e0b',
            }}
          >
            ★ Cross-Symbol
          </span>
        ) : (
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded"
            style={{
              backgroundColor: isResistance ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
              color,
            }}
          >
            {level.label}
          </span>
        )}

        {/* OI — combined for cross-symbol, regular otherwise */}
        <span className="text-xs text-gray-400 w-16">
          OI: {formatCompact(displayOI)}
        </span>

        {/* Volume */}
        <span className="text-xs text-gray-400 w-16">
          Vol: {formatCompact(displayVol)}
        </span>

        {/* Distance */}
        <span
          className="text-xs font-mono font-medium w-12 text-right"
          style={{ color }}
        >
          {formatDistance(level.distance)}
        </span>

        {/* Strength bar — uses crossScore for cross-symbol levels */}
        <StrengthBar value={displayStrength} color={color} />
      </div>

      {/* Cross-symbol sub-row: paired symbol info */}
      {isCross && level.pairedSymbol && level.pairedStrike != null && (
        <div className="flex items-center gap-1.5 mt-0.5" style={{ marginLeft: '76px' }}>
          <span className="text-[10px] text-amber-400/60">↳</span>
          <span className="text-[10px] text-gray-500">
            {level.pairedSymbol}: {level.pairedStrike.toLocaleString()}
            {level.pairedWallType && (
              <span className="ml-1 text-amber-400/50">
                {level.pairedWallType === 'put' ? 'Put Wall' : level.pairedWallType === 'call' ? 'Call Wall' : level.pairedWallType}
              </span>
            )}
          </span>
          {level.crossScore != null && (
            <span className="text-[10px] text-amber-400/50 ml-1">
              Cross: {level.crossScore}
            </span>
          )}
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
    <div className="flex flex-col gap-1">
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium"
        style={{ backgroundColor: c.bg, color: c.text }}
      >
        <span>{c.icon}</span>
        <span>{label}</span>
        <span className="text-[11px] opacity-70">({formatGEX(netGEX)})</span>
      </div>
      {flipPoint !== null && (
        <span className="text-[11px] text-gray-500 pl-1">
          Flip: ${formatStrike(flipPoint)}
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DayTradingView() {
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
  } = useOptionsData();

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

          {/* ---- RESISTANCE ---- */}
          {sortedResistance.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 px-4 mb-1">
                <div className="h-px flex-1 bg-red-900/40" />
                <span className="text-[11px] font-semibold tracking-widest text-red-400/70 uppercase">
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
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---- SPOT LINE ---- */}
          <div className="flex items-center gap-3 my-3 px-4">
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, transparent, #3b82f6, transparent)' }} />
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-blue-400 tracking-wider uppercase">Spot</span>
              <span className="text-sm font-mono font-bold text-blue-300">${spot.toFixed(2)}</span>
            </div>
            <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, #3b82f6, transparent)' }} />
          </div>

          {/* ---- SUPPORT ---- */}
          {sortedSupport.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 px-4 mb-1">
                <div className="h-px flex-1 bg-green-900/40" />
                <span className="text-[11px] font-semibold tracking-widest text-green-400/70 uppercase">
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
