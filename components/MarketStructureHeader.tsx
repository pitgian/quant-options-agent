/**
 * MarketStructureHeader — sticky control bar for MarketStructureView.
 *
 * Extracted from MarketStructureView (Phase 2) to isolate the ~165-line
 * header JSX (market selector + 6 control groups + refresh + status flags)
 * from the chart and panels below.
 *
 * @module components/MarketStructureHeader
 */

import React from 'react';
import { ExpiryFilter } from '../types';
import { EXPIRY_OPTIONS } from '../lib/expiry';
import { KRONOS_TIMEFRAMES, type KronosTimeframe } from '../lib/kronos';
import { IconRefresh } from './Icons';

const ZOOM_OPTIONS = [
  { label: '± 1.5%', value: 1.5 },
  { label: '± 3.0%', value: 3.0 },
  { label: '± 5.0%', value: 5.0 },
];

export type FuturesTimeframe = 'auto' | '1d' | '2d' | '5d' | '7d' | '30d' | '90d' | 'max';

export interface MarketStructureHeaderProps {
  market: 'SP500' | 'NASDAQ100';
  setMarket: (m: 'SP500' | 'NASDAQ100') => void;
  zoomPct: number;
  setZoomPct: (z: number) => void;
  rowHeight: number;
  setRowHeight: React.Dispatch<React.SetStateAction<number>>;
  expiryFilter: ExpiryFilter;
  setExpiryFilter: (f: ExpiryFilter) => void;
  selectedFuturesTf: FuturesTimeframe;
  setSelectedFuturesTf: (tf: FuturesTimeframe) => void;
  kronosTimeframe: KronosTimeframe;
  setKronosTimeframe: (tf: KronosTimeframe) => void;
  refreshing: boolean;
  handleRefresh: () => void;
  timeSinceUpdate: string;
  isBackgroundRefreshing: boolean;
  flashVisible: boolean;
}

export function MarketStructureHeader({
  market, setMarket,
  zoomPct, setZoomPct,
  rowHeight, setRowHeight,
  expiryFilter, setExpiryFilter,
  selectedFuturesTf, setSelectedFuturesTf,
  kronosTimeframe, setKronosTimeframe,
  refreshing, handleRefresh, timeSinceUpdate,
  isBackgroundRefreshing, flashVisible,
}: MarketStructureHeaderProps) {
  return (
    <header
      className="sticky z-40 border-b border-gray-800 bg-[#161b22]/95 backdrop-blur px-4 py-3"
      style={{ top: 'var(--app-nav-h, 0px)' }}
    >
      <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 flex-wrap">
        {/* Market selector (S&P 500 vs Nasdaq 100) */}
        <div className="flex bg-slate-900 rounded-xl p-1 border border-slate-800">
          <button
            onClick={() => setMarket('SP500')}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
            style={{
              backgroundColor: market === 'SP500' ? '#1e293b' : 'transparent',
              color: market === 'SP500' ? '#e2e8f0' : '#64748b',
            }}
          >
            🇺🇸 S&P 500
          </button>
          <button
            onClick={() => setMarket('NASDAQ100')}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
            style={{
              backgroundColor: market === 'NASDAQ100' ? '#1e293b' : 'transparent',
              color: market === 'NASDAQ100' ? '#e2e8f0' : '#64748b',
            }}
          >
            💻 Nasdaq 100
          </button>
        </div>

        {/* Controls & Zooms */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Range selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Range:</span>
            <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800">
              {ZOOM_OPTIONS.map((zo) => (
                <button
                  key={zo.value}
                  onClick={() => setZoomPct(zo.value)}
                  className="px-2.5 py-1 rounded text-[10px] font-semibold transition-all duration-150"
                  style={{
                    backgroundColor: zoomPct === zo.value ? '#1e293b' : 'transparent',
                    color: zoomPct === zo.value ? '#e2e8f0' : '#64748b',
                  }}
                >
                  {zo.label}
                </button>
              ))}
            </div>
          </div>

          {/* Row Height Spacing Control */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Zoom:</span>
            <div className="flex items-center gap-1.5 bg-[#161b22] rounded-lg px-2 py-1 border border-slate-800">
              <button
                onClick={() => setRowHeight(h => Math.max(14, h - 2))}
                disabled={rowHeight <= 14}
                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                title="Stringi righe (più livelli visibili)"
              >
                -
              </button>
              <input
                type="range"
                min="14"
                max="36"
                step="2"
                value={rowHeight}
                onChange={(e) => setRowHeight(Number(e.target.value))}
                className="w-16 accent-blue-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
                title={`Altezza righe: ${rowHeight}px`}
              />
              <button
                onClick={() => setRowHeight(h => Math.min(36, h + 2))}
                disabled={rowHeight >= 36}
                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                title="Allarga righe (maggior dettaglio)"
              >
                +
              </button>
            </div>
          </div>

          {/* Expiry filter */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Scadenza:</span>
            <select
              value={expiryFilter}
              onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
              className="bg-slate-900 border border-slate-850 text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Futures Timeframe selector */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Futures:</span>
            <select
              value={selectedFuturesTf}
              onChange={(e) => setSelectedFuturesTf(e.target.value as FuturesTimeframe)}
              className="bg-slate-900 border border-slate-850 text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="auto">Auto (Allineato scadenza)</option>
              <option value="1d">Giornaliero (dalle 00:00)</option>
              <option value="7d">Settimanale (da Lunedì)</option>
              <option value="30d">Mensile (dal 1°)</option>
              <option value="90d">Trimestrale (da inizio Qt.)</option>
              <option value="max">Cumulativo (Max)</option>
            </select>
          </div>

          {/* Kronos AI Timeframe selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Kronos:</span>
            <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800">
              {KRONOS_TIMEFRAMES.map((tf) => (
                <button
                  key={tf.key}
                  onClick={() => setKronosTimeframe(tf.key)}
                  className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all duration-150"
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

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
            title={timeSinceUpdate ? `Aggiornato: ${timeSinceUpdate}` : 'Aggiorna'}
          >
            <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {timeSinceUpdate && (
              <span className="text-[11px] text-gray-500">{timeSinceUpdate}</span>
            )}
          </button>

          {/* Background refresh status */}
          {isBackgroundRefreshing && (
            <span className="inline-flex items-center gap-1 text-[11px] text-blue-400/80 animate-pulse">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
              Aggiornamento in corso…
            </span>
          )}

          {/* Success flash */}
          {flashVisible && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 animate-pulse">
              ✓ Dati aggiornati
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
