/**
 * VercelView — Simplified Options Wall Analyzer
 *
 * Displays Put Walls (supports) and Call Walls (resistances) derived from
 * options data across all expirations. Clean tables, dark theme, responsive.
 *
 * @module components/VercelView
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { OptionsData, WallLevel, ExpirationDetail, ExpirationFilterPreset } from '../types';
import { fetchOptionsData, FetchResult, getTimeSinceUpdate } from '../services/dataService';
import { IconRefresh, IconSettings, IconLoader, IconChevronDown, IconChevronUp } from './Icons';
import { SettingsPanel } from './SettingsPanel';

// ============================================================================
// HELPERS
// ============================================================================

/** Format a number as compact (e.g. 1.2M, 345K) */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

/** Format a strike price */
function formatStrike(strike: number): string {
  return strike.toFixed(2);
}

/** Calculate % distance from spot */
function distancePct(strike: number, spot: number): number {
  return ((strike - spot) / spot) * 100;
}

/** Format a timestamp to a readable string */
function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

// ---------- Expandable Row ----------

const ExpirationRow: React.FC<{ detail: ExpirationDetail }> = ({ detail }) => {
  const weight = detail.weight ?? 1.0;
  return (
    <tr className="bg-gray-800/50 text-xs text-gray-400">
      <td className="px-4 py-1.5 pl-10">{detail.expirationDate}</td>
      <td className="px-4 py-1.5 text-right">{detail.daysToExpiry}d</td>
      <td className="px-4 py-1.5 text-right">{formatCompact(detail.oi)}</td>
      <td className="px-4 py-1.5 text-right">{formatCompact(detail.volume)}</td>
      <td className="px-4 py-1.5 text-right text-gray-500">{(weight * 100).toFixed(0)}%</td>
    </tr>
  );
};

const WallRow: React.FC<{
  wall: WallLevel;
  spotPrice: number;
  maxOI: number;
  maxVol: number;
  isPut: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ wall, spotPrice, maxOI, maxVol, isPut, isExpanded, onToggle }) => {
  const dist = distancePct(wall.strike, spotPrice);
  const oiPct = maxOI > 0 ? (wall.totalOI / maxOI) * 100 : 0;
  const volPct = maxVol > 0 ? (wall.totalVolume / maxVol) * 100 : 0;
  const textColor = isPut ? 'text-emerald-400' : 'text-red-400';

  return (
    <>
      <tr
        className="hover:bg-gray-750 cursor-pointer transition-colors border-b border-gray-700/50"
        onClick={onToggle}
      >
        <td className="px-4 py-2.5 font-mono font-semibold text-white">
          <span className="flex items-center gap-2">
            {isExpanded ? <IconChevronUp className="h-3 w-3 text-gray-500" /> : <IconChevronDown className="h-3 w-3 text-gray-500" />}
            {formatStrike(wall.strike)}
          </span>
        </td>
        <td className="px-4 py-2.5 text-right text-gray-300">{formatCompact(wall.totalOI)}</td>
        <td className="px-4 py-2.5 text-right text-gray-300">{formatCompact(wall.totalVolume)}</td>
        <td className="px-4 py-2.5 text-right">
          <div className="flex flex-col gap-1 w-20 ml-auto">
            {/* OI progress bar */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400 w-4">OI</span>
              <div className="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
                <div className="h-full rounded-full" style={{
                  width: `${oiPct}%`,
                  backgroundColor: wall.type === 'put' ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)'
                }} />
              </div>
            </div>
            {/* Volume progress bar */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400 w-4">Vol</span>
              <div className="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
                <div className="h-full rounded-full" style={{
                  width: `${volPct}%`,
                  backgroundColor: wall.type === 'put' ? 'rgba(52, 211, 153, 0.45)' : 'rgba(248, 113, 113, 0.45)'
                }} />
              </div>
            </div>
          </div>
        </td>
        <td className={`px-4 py-2.5 text-right text-xs ${textColor}`}>
          {wall.expirations.length} exp
          <span className="ml-2 text-gray-500">
            {dist > 0 ? '+' : ''}{dist.toFixed(1)}%
          </span>
        </td>
      </tr>
      {isExpanded && wall.expirations.map((exp, i) => (
        <ExpirationRow key={`${wall.strike}-${exp.expirationDate}-${i}`} detail={exp} />
      ))}
    </>
  );
};

// ---------- Wall Table ----------

const WallTable: React.FC<{
  title: string;
  walls: WallLevel[];
  spotPrice: number;
  isPut: boolean;
  accentColor: string;
}> = ({ title, walls, spotPrice, isPut, accentColor }) => {
  const [expandedStrike, setExpandedStrike] = useState<number | null>(null);
  const maxOI = walls.length > 0 ? Math.max(...walls.map(w => w.totalOI)) : 1;
  const maxVol = walls.length > 0 ? Math.max(...walls.map(w => w.totalVolume)) : 1;

  const toggle = (strike: number) => {
    setExpandedStrike(prev => prev === strike ? null : strike);
  };

  if (walls.length === 0) {
    return (
      <div className="bg-gray-800/50 rounded-xl border border-gray-700 p-6">
        <h3 className={`text-lg font-semibold mb-4 ${accentColor}`}>{title}</h3>
        <p className="text-gray-500 text-sm">No data available</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden">
      {/* Section header */}
      <div className={`px-4 py-3 border-b border-gray-700 ${isPut ? 'bg-emerald-900/20' : 'bg-red-900/20'}`}>
        <h3 className={`text-lg font-semibold ${accentColor}`}>
          {isPut ? '▼' : '▲'} {title}
        </h3>
        <p className="text-xs text-gray-400 mt-0.5">
          {walls.length} key level{walls.length !== 1 ? 's' : ''} • sorted by distance from spot
        </p>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700">
              <th className="px-4 py-2 text-left">Strike</th>
              <th className="px-4 py-2 text-right">Total OI</th>
              <th className="px-4 py-2 text-right">Total Vol</th>
              <th className="px-4 py-2 text-right">OI / Vol</th>
              <th className="px-4 py-2 text-right">Detail</th>
            </tr>
          </thead>
          <tbody>
            {walls.map((wall) => (
              <WallRow
                key={wall.strike}
                wall={wall}
                spotPrice={spotPrice}
                maxOI={maxOI}
                maxVol={maxVol}
                isPut={isPut}
                isExpanded={expandedStrike === wall.strike}
                onToggle={() => toggle(wall.strike)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------- Price Position Bar ----------

const PricePositionBar: React.FC<{ data: OptionsData }> = ({ data }) => {
  const { spotPrice, putWalls, callWalls } = data;

  // ── Zoom state ──
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragCurrent, setDragCurrent] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // ── Tooltip state ──
  const [hoveredWall, setHoveredWall] = useState<{ wall: WallLevel; isPut: boolean; leftPct: number } | null>(null);

  // ── Compute full (unzoomed) range ──
  const allStrikes = [...putWalls.map(w => w.strike), ...callWalls.map(w => w.strike), spotPrice];
  const fullMin = Math.min(...allStrikes);
  const fullMax = Math.max(...allStrikes);
  const fullPadding = (fullMax - fullMin) * 0.04 || 1;
  const fullRangeMin = fullMin - fullPadding;
  const fullRangeMax = fullMax + fullPadding;

  // Active range respects zoom
  const rangeMin = zoomRange ? zoomRange[0] : fullRangeMin;
  const rangeMax = zoomRange ? zoomRange[1] : fullRangeMax;
  const range = rangeMax - rangeMin || 1;

  /** Convert a price value to a percentage position within the chart */
  const pct = (val: number) => ((val - rangeMin) / range) * 100;

  // ── Histogram bar heights (separate OI and Volume) ──
  const allWalls = [...putWalls, ...callWalls];
  const maxOI = allWalls.length > 0 ? Math.max(...allWalls.map(w => w.totalOI)) : 1;
  const maxVol = allWalls.length > 0 ? Math.max(...allWalls.map(w => w.totalVolume)) : 1;
  /** Returns height % for an OI bar (min 8 %, max 100 %) */
  const oiHeightPct = (oi: number) => Math.max(8, (oi / maxOI) * 100);
  /** Returns height % for a Volume bar (min 8 %, max 100 %) */
  const volHeightPct = (vol: number) => Math.max(8, (vol / maxVol) * 100);

  // ── Build price scale ticks ──
  const tickCount = 9;
  const rawStep = range / (tickCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let niceStep: number;
  if (residual <= 1.5) niceStep = 1 * magnitude;
  else if (residual <= 3.5) niceStep = 2 * magnitude;
  else if (residual <= 7.5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const tickStart = Math.ceil(rangeMin / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let t = tickStart; t <= rangeMax; t += niceStep) {
    ticks.push(Math.round(t * 100) / 100);
  }
  // Ensure spot price is always present in the scale
  const spotInTicks = ticks.some(t => Math.abs(t - spotPrice) < niceStep * 0.01);
  if (!spotInTicks) {
    ticks.push(Math.round(spotPrice * 100) / 100);
    ticks.sort((a, b) => a - b);
  }

  // ── Drag-to-zoom mouse handlers ──
  const priceFromEvent = (e: React.MouseEvent): number => {
    if (!chartRef.current) return rangeMin;
    const rect = chartRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return rangeMin + (x / rect.width) * range;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragStart(priceFromEvent(e));
    setDragCurrent(priceFromEvent(e));
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragStart === null) return;
    setDragCurrent(priceFromEvent(e));
  };

  const handleMouseUp = () => {
    if (dragStart !== null && dragCurrent !== null) {
      const lo = Math.min(dragStart, dragCurrent);
      const hi = Math.max(dragStart, dragCurrent);
      // Only zoom if selection covers > 5 % of current range
      if ((hi - lo) / range > 0.05) {
        setZoomRange([lo, hi]);
      }
    }
    setDragStart(null);
    setDragCurrent(null);
  };

  const resetZoom = () => setZoomRange(null);

  // Selection rectangle geometry
  const dragLeftPct = dragStart !== null && dragCurrent !== null
    ? pct(Math.min(dragStart, dragCurrent)) : 0;
  const dragWidthPct = dragStart !== null && dragCurrent !== null
    ? Math.abs(pct(dragCurrent) - pct(dragStart)) : 0;
  const isDragging = dragStart !== null && dragCurrent !== null && dragWidthPct > 0.5;

  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden">
      {/* ── Title bar ── */}
      <div className="px-5 py-3 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-gray-300">Price Position</h3>
          {zoomRange && (
            <button
              onClick={resetZoom}
              className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-white hover:bg-gray-600 transition-colors"
            >
              ✕ Reset Zoom
            </button>
          )}
          <span className="text-[10px] text-gray-600 hidden sm:inline">
            Drag to zoom
          </span>
        </div>
        <span className="text-sm font-mono font-bold text-yellow-400">
          {data.symbol} Spot: ${formatStrike(spotPrice)}
        </span>
      </div>

      {/* ── Main chart area ── */}
      <div
        ref={chartRef}
        className="relative bg-gray-800 overflow-hidden select-none"
        style={{ height: '250px', cursor: 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Background tint zones: green left of spot, red right of spot */}
        <div className="absolute inset-0 flex pointer-events-none">
          <div className="h-full bg-emerald-900/10" style={{ width: `${pct(spotPrice)}%` }} />
          <div className="h-full bg-red-900/10 flex-1" />
        </div>

        {/* Zone labels */}
        <div className="absolute top-2 left-3 text-[10px] font-semibold text-emerald-500/60 tracking-wider uppercase pointer-events-none">
          ◀ Puts
        </div>
        <div className="absolute top-2 right-3 text-[10px] font-semibold text-red-500/60 tracking-wider uppercase pointer-events-none">
          Calls ▶
        </div>

        {/* Put wall dual bars — OI (solid) + Volume (lighter) */}
        {putWalls.map((w, i) => {
          const oiH = oiHeightPct(w.totalOI);
          const volH = volHeightPct(w.totalVolume);
          return (
            <div
              key={`put-${i}`}
              className="absolute bottom-0"
              style={{
                left: `${pct(w.strike)}%`,
                width: '28px',
                height: '100%',
                transform: 'translateX(-50%)',
                display: 'flex',
                justifyContent: 'center',
                gap: '2px',
                alignItems: 'flex-end',
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHoveredWall({ wall: w, isPut: true, leftPct: pct(w.strike) })}
              onMouseLeave={() => setHoveredWall(null)}
            >
              {/* OI Bar */}
              <div style={{
                width: '6px',
                height: `${oiH}%`,
                backgroundColor: 'rgba(16, 185, 129, 0.8)',
                borderRadius: '2px 2px 0 0',
              }} />
              {/* Volume Bar */}
              <div style={{
                width: '6px',
                height: `${volH}%`,
                backgroundColor: 'rgba(52, 211, 153, 0.45)',
                borderRadius: '2px 2px 0 0',
              }} />
            </div>
          );
        })}

        {/* Call wall dual bars — OI (solid) + Volume (lighter) */}
        {callWalls.map((w, i) => {
          const oiH = oiHeightPct(w.totalOI);
          const volH = volHeightPct(w.totalVolume);
          return (
            <div
              key={`call-${i}`}
              className="absolute bottom-0"
              style={{
                left: `${pct(w.strike)}%`,
                width: '28px',
                height: '100%',
                transform: 'translateX(-50%)',
                display: 'flex',
                justifyContent: 'center',
                gap: '2px',
                alignItems: 'flex-end',
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHoveredWall({ wall: w, isPut: false, leftPct: pct(w.strike) })}
              onMouseLeave={() => setHoveredWall(null)}
            >
              {/* OI Bar */}
              <div style={{
                width: '6px',
                height: `${oiH}%`,
                backgroundColor: 'rgba(239, 68, 68, 0.8)',
                borderRadius: '2px 2px 0 0',
              }} />
              {/* Volume Bar */}
              <div style={{
                width: '6px',
                height: `${volH}%`,
                backgroundColor: 'rgba(248, 113, 113, 0.45)',
                borderRadius: '2px 2px 0 0',
              }} />
            </div>
          );
        })}

        {/* Tooltip for hovered wall bar */}
        {hoveredWall && (() => {
          const w = hoveredWall.wall;
          const dist = distancePct(w.strike, spotPrice);
          const tooltipLeft = Math.max(12, Math.min(88, hoveredWall.leftPct));
          return (
            <div
              className="absolute z-30 pointer-events-none"
              style={{
                left: `${tooltipLeft}%`,
                top: '6px',
                transform: 'translateX(-50%)',
              }}
            >
              <div className="bg-gray-900 text-white text-[11px] leading-relaxed rounded-lg shadow-xl border border-gray-600 px-3 py-2 whitespace-nowrap">
                <div className="font-semibold text-white mb-1">
                  Strike: ${formatStrike(w.strike)}
                </div>
                <div className={hoveredWall.isPut ? 'text-emerald-400' : 'text-red-400'}>
                  Type: {hoveredWall.isPut ? 'PUT' : 'CALL'}
                </div>
                <div className="flex items-center gap-1.5">
                  <div style={{ width: '8px', height: '8px', backgroundColor: hoveredWall.isPut ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)', borderRadius: '2px' }} />
                  OI: {w.totalOI.toLocaleString()}
                </div>
                <div className="flex items-center gap-1.5">
                  <div style={{ width: '8px', height: '8px', backgroundColor: hoveredWall.isPut ? 'rgba(52, 211, 153, 0.45)' : 'rgba(248, 113, 113, 0.45)', borderRadius: '2px' }} />
                  Volume: {w.totalVolume.toLocaleString()}
                </div>
                <div>Distance: {dist > 0 ? '+' : ''}{dist.toFixed(2)}%</div>
                <div>Expirations: {w.expirations.length}</div>
                {w.expirations.length > 0 && (
                  <div className="mt-1 pt-1 border-t border-gray-700 space-y-0.5">
                    {w.expirations.map((exp, ei) => {
                      const expWeight = exp.weight ?? 1.0;
                      return (
                        <div key={ei} className="text-gray-400">
                          {exp.expirationDate}: OI: {exp.oi.toLocaleString()} | Vol: {exp.volume.toLocaleString()} | Weight: {(expWeight * 100).toFixed(0)}%
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Spot price marker — prominent yellow line */}
        <div
          className="absolute top-0 bottom-0 z-10 pointer-events-none"
          style={{
            left: `${pct(spotPrice)}%`,
            width: '2.5px',
            backgroundColor: '#facc15',
          }}
        />
        {/* Spot price label */}
        <div
          className="absolute z-10 font-bold text-yellow-400 whitespace-nowrap bg-gray-900/90 px-2 py-0.5 rounded text-xs pointer-events-none"
          style={{
            top: '50%',
            left: `${pct(spotPrice)}%`,
            transform: 'translate(-50%, -50%)',
          }}
        >
          ${formatStrike(spotPrice)}
        </div>

        {/* Drag selection rectangle */}
        {isDragging && (
          <div
            className="absolute top-0 bottom-0 bg-white/10 border-l border-r border-white/30 pointer-events-none z-20"
            style={{
              left: `${dragLeftPct}%`,
              width: `${dragWidthPct}%`,
            }}
          />
        )}
      </div>

      {/* ── Legend for dual bars ── */}
      <div className="flex items-center gap-4 justify-center py-1 bg-gray-800/30 border-t border-gray-700/50">
        <div className="flex items-center gap-1">
          <div style={{ width: '12px', height: '8px', backgroundColor: 'rgba(16, 185, 129, 0.8)', borderRadius: '2px' }} />
          <span className="text-[10px] text-gray-400">OI</span>
        </div>
        <div className="flex items-center gap-1">
          <div style={{ width: '12px', height: '8px', backgroundColor: 'rgba(52, 211, 153, 0.45)', borderRadius: '2px' }} />
          <span className="text-[10px] text-gray-400">Volume</span>
        </div>
      </div>

      {/* ── Price scale at the bottom ── */}
      <div className="relative border-t border-gray-700 bg-gray-900/50" style={{ height: '32px' }}>
        {ticks.map((tick) => {
          const isSpot = Math.abs(tick - spotPrice) < 0.01;
          return (
            <div
              key={tick}
              className="absolute top-0 flex flex-col items-center"
              style={{
                left: `${pct(tick)}%`,
                transform: 'translateX(-50%)',
              }}
            >
              {/* Tick mark line */}
              <div
                className={isSpot ? 'bg-yellow-400' : 'bg-gray-600'}
                style={{ width: '1px', height: '6px' }}
              />
              {/* Price label */}
              <span
                className={`text-[10px] font-mono whitespace-nowrap ${
                  isSpot ? 'text-yellow-400 font-bold' : 'text-gray-500'
                }`}
              >
                {tick.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------- Loading State ----------

const LoadingState: React.FC = () => (
  <div className="flex flex-col items-center justify-center min-h-[60vh] text-gray-400">
    <IconLoader className="h-8 w-8 mb-4" />
    <p className="text-lg">Loading options data...</p>
    <p className="text-sm text-gray-500 mt-1">Fetching from GitHub</p>
  </div>
);

// ---------- Error State ----------

const ErrorState: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center min-h-[60vh] text-gray-400">
    <div className="text-4xl mb-4">⚠️</div>
    <p className="text-lg text-red-400 mb-2">Failed to load data</p>
    <p className="text-sm text-gray-500 mb-4">{message}</p>
    <button
      onClick={onRetry}
      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
    >
      <IconRefresh className="h-4 w-4" /> Retry
    </button>
  </div>
);

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function VercelView() {
  const [data, setData] = useState<OptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('SPY');
  const [timeSinceUpdate, setTimeSinceUpdate] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [showUpdatedFlash, setShowUpdatedFlash] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const prevTimestampRef = useRef<string | null>(null);
  const [expirationFilter, setExpirationFilter] = useState<ExpirationFilterPreset>('all');

  // ---- Filtered data (client-side only) ----

  const filteredData = useMemo(() => {
    if (!data || expirationFilter === 'all') return data;

    const filterFn = (exp: ExpirationDetail) => {
      switch (expirationFilter) {
        case '0dte': return exp.daysToExpiry === 0;
        case '1-7dte': return exp.daysToExpiry >= 1 && exp.daysToExpiry <= 7;
        case '8-30dte': return exp.daysToExpiry >= 8 && exp.daysToExpiry <= 30;
        case '30+dte': return exp.daysToExpiry > 30;
        default: return true;
      }
    };

    const filterWalls = (walls: WallLevel[]): WallLevel[] => {
      return walls
        .map(wall => {
          const filteredExps = wall.expirations.filter(filterFn);
          const totalOI = filteredExps.reduce((sum, e) => sum + e.oi, 0);
          const totalVolume = filteredExps.reduce((sum, e) => sum + e.volume, 0);
          const scoreRatio = totalOI > 0 ? totalOI / wall.totalOI : 0;
          return {
            ...wall,
            totalOI,
            totalVolume,
            score: wall.score * scoreRatio,
            expirations: filteredExps,
          };
        })
        .filter(wall => wall.totalOI > 0);
    };

    return {
      ...data,
      putWalls: filterWalls(data.putWalls),
      callWalls: filterWalls(data.callWalls),
    };
  }, [data, expirationFilter]);

  // ---- Data fetching ----

  const loadData = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);

    const result: FetchResult = await fetchOptionsData(symbol, forceRefresh);

    if (result.success && result.data) {
      setData(result.data);
      prevTimestampRef.current = result.data.timestamp;
      setLastRefreshed(new Date());
      setError(null);
    } else {
      setError(result.error || 'Unknown error');
      // Keep stale data if available
      if (result.data) setData(result.data);
    }

    setLoading(false);

    // Update time since
    const ts = await getTimeSinceUpdate(symbol);
    setTimeSinceUpdate(ts);
  }, [symbol]);

  // Silent background refresh — does NOT show the full-page loading spinner
  const silentRefresh = useCallback(async () => {
    setIsBackgroundRefreshing(true);
    try {
      const result: FetchResult = await fetchOptionsData(symbol, false);
      if (result.success && result.data) {
        const prevTimestamp = prevTimestampRef.current;
        setData(result.data);
        prevTimestampRef.current = result.data.timestamp;
        setLastRefreshed(new Date());
        // Flash indicator only when data actually changed
        if (prevTimestamp !== result.data.timestamp) {
          setShowUpdatedFlash(true);
          setTimeout(() => setShowUpdatedFlash(false), 3000);
        }
      } else if (result.data) {
        setData(result.data);
      }
      const ts = await getTimeSinceUpdate(symbol);
      setTimeSinceUpdate(ts);
    } finally {
      setIsBackgroundRefreshing(false);
    }
  }, [symbol]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh: 60s during US market hours (13:30-20:00 UTC), 5 min otherwise
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const now = new Date();
      const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      // US market open: 9:30 AM - 4:00 PM ET = 13:30 - 20:00 UTC
      const isMarket = utcMinutes >= 13 * 60 + 30 && utcMinutes <= 20 * 60;
      const delay = isMarket ? 60 * 1000 : 5 * 60 * 1000;

      timeoutId = setTimeout(() => {
        silentRefresh();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => clearTimeout(timeoutId);
  }, [silentRefresh]);

  // ---- Handlers ----

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  };

  const SYMBOLS = ['SPY', 'QQQ', 'SPX', 'NDX'] as const;

  const handleSymbolChange = (newSymbol: string) => {
    setSymbol(newSymbol);
    setExpirationFilter('all');
  };

  // ---- Render ----

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* ===== HEADER ===== */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          {/* Left: Symbol + Price */}
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-white tracking-tight">
              {data?.symbol || symbol}
            </h1>
            {data && (
              <div className="flex items-center gap-3">
                <span className="text-2xl font-mono font-bold text-yellow-400">
                  ${formatStrike(data.spotPrice)}
                </span>
              </div>
            )}
          </div>

          {/* Right: Controls */}
          <div className="flex items-center gap-3">
            {/* Timestamp + auto-refresh indicator */}
            {data && (
              <div className="hidden sm:block text-right relative">
                <p className="text-xs text-gray-500 flex items-center gap-1.5 justify-end">
                  {isBackgroundRefreshing && (
                    <IconRefresh className="h-3 w-3 animate-spin text-blue-400 flex-shrink-0" />
                  )}
                  Updated {timeSinceUpdate || formatTimestamp(data.timestamp)}
                </p>
                {showUpdatedFlash && (
                  <span className="absolute -top-2 -right-2 text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-medium animate-pulse pointer-events-none">
                    New data!
                  </span>
                )}
              </div>
            )}

            {/* Refresh */}
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading || isBackgroundRefreshing}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh data"
            >
              <IconRefresh className={refreshing ? 'animate-spin' : ''} />
            </button>

            {/* Settings */}
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              title="Settings"
            >
              <IconSettings />
            </button>
          </div>
        </div>
      </header>

      {/* ===== ASSET TAB CARDS ===== */}
      <div className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex gap-2 overflow-x-auto py-2 scrollbar-hide">
            {SYMBOLS.map((s) => {
              const isActive = s === symbol;
              return (
                <button
                  key={s}
                  onClick={() => handleSymbolChange(s)}
                  className={`
                    flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold
                    transition-all duration-200 ease-in-out border
                    ${
                      isActive
                        ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20'
                        : 'bg-slate-800 border-slate-700 text-gray-400 hover:bg-slate-700 hover:text-gray-200 hover:border-slate-600'
                    }
                  `}
                >
                  <span className="block leading-tight">{s}</span>
                  {data && data.symbol === s && (
                    <span className={`block text-[10px] leading-tight mt-0.5 ${isActive ? 'text-blue-200' : 'text-gray-500'}`}>
                      ${formatStrike(data.spotPrice)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ===== EXPIRATION FILTER BAR ===== */}
      {data && (
        <div className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-800">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center gap-2 overflow-x-auto py-2 scrollbar-hide">
              <span className="text-[11px] text-gray-500 font-medium uppercase tracking-wider flex-shrink-0 mr-1">
                Expiry
              </span>
              {([
                { key: 'all' as ExpirationFilterPreset, label: 'All' },
                { key: '0dte' as ExpirationFilterPreset, label: '0 DTE' },
                { key: '1-7dte' as ExpirationFilterPreset, label: '1-7 DTE' },
                { key: '8-30dte' as ExpirationFilterPreset, label: '8-30 DTE' },
                { key: '30+dte' as ExpirationFilterPreset, label: '30+ DTE' },
              ]).map(({ key, label }) => {
                const isActive = expirationFilter === key;
                return (
                  <button
                    key={key}
                    onClick={() => setExpirationFilter(key)}
                    className={`
                      flex-shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold
                      transition-all duration-200 ease-in-out border
                      ${
                        isActive
                          ? 'bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-500/20'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200 hover:border-gray-600'
                      }
                    `}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ===== MAIN CONTENT ===== */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {loading && !data ? (
          <LoadingState />
        ) : error && !data ? (
          <ErrorState message={error} onRetry={handleRefresh} />
        ) : data ? (
          <div className="space-y-6">
            {/* Price Position Bar */}
            <PricePositionBar data={filteredData!} />

            {/* Info bar */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
              {expirationFilter === 'all' ? (
                <span>{data.allExpirations.length} expiration dates analyzed</span>
              ) : (
                <span>
                  Active filter: {({
                    '0dte': '0 DTE',
                    '1-7dte': '1-7 DTE',
                    '8-30dte': '8-30 DTE',
                    '30+dte': '30+ DTE',
                  }[expirationFilter])} — {filteredData!.putWalls.length + filteredData!.callWalls.length} of {data.putWalls.length + data.callWalls.length} levels shown
                </span>
              )}
              <span>•</span>
              <span>{filteredData!.putWalls.length} put walls, {filteredData!.callWalls.length} call walls</span>
              <span>•</span>
              <span>Data: {formatTimestamp(data.timestamp)}</span>
            </div>

            {/* Wall Tables — side by side on desktop, stacked on mobile */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* PUT WALLS (Supports) — sorted by strike DESC (closest to spot first) */}
              <WallTable
                title="Put Walls (Supports)"
                walls={[...filteredData!.putWalls].sort((a, b) => b.strike - a.strike)}
                spotPrice={data.spotPrice}
                isPut={true}
                accentColor="text-emerald-400"
              />

              {/* CALL WALLS (Resistances) — sorted by strike ASC (closest to spot first) */}
              <WallTable
                title="Call Walls (Resistances)"
                walls={[...filteredData!.callWalls].sort((a, b) => a.strike - b.strike)}
                spotPrice={data.spotPrice}
                isPut={false}
                accentColor="text-red-400"
              />
            </div>

            {/* Footer note */}
            <p className="text-center text-xs text-gray-600 pt-4 pb-8">
              {expirationFilter === 'all'
                ? 'Options data aggregated across all expirations • Solid bars = OI | Light bars = Volume'
                : `Expiration filter: ${({
                    '0dte': '0 DTE',
                    '1-7dte': '1-7 DTE',
                    '8-30dte': '8-30 DTE',
                    '30+dte': '30+ DTE',
                  }[expirationFilter])} • Solid bars = OI | Light bars = Volume`
              }
            </p>
          </div>
        ) : null}
      </main>

      {/* ===== SETTINGS PANEL ===== */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          currentSymbol={symbol}
        />
      )}
    </div>
  );
}
