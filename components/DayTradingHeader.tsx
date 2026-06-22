/**
 * DayTradingHeader — sticky control bar for DayTradingView.
 *
 * Extracted from DayTradingView (Phase 2c). The header is pure JSX that
 * threads state directly to its controls; isolating it makes the main
 * component read as "guide + two market columns" at a glance.
 *
 * @module components/DayTradingHeader
 */

import React from 'react';
import { ExpiryFilter } from '../types';
import { EXPIRY_OPTIONS } from '../lib/expiry';
import { KRONOS_TIMEFRAMES, type KronosTimeframe } from '../lib/kronos';
import { IconRefresh } from './Icons';

export interface DayTradingHeaderProps {
  kronosTimeframe: KronosTimeframe;
  setKronosTimeframe: (tf: KronosTimeframe) => void;
  expiryFilter: ExpiryFilter;
  setExpiryFilter: (f: ExpiryFilter) => void;
  showCrossSymbol: boolean;
  setShowCrossSymbol: React.Dispatch<React.SetStateAction<boolean>>;
  refreshing: boolean;
  handleRefresh: () => void;
  lastUpdatedText: string;
  isBackgroundRefreshing: boolean;
  flashVisible: boolean;
}

export function DayTradingHeader({
  kronosTimeframe, setKronosTimeframe,
  expiryFilter, setExpiryFilter,
  showCrossSymbol, setShowCrossSymbol,
  refreshing, handleRefresh, lastUpdatedText,
  isBackgroundRefreshing, flashVisible,
}: DayTradingHeaderProps) {
  return (
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
  );
}
