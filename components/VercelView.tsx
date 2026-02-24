/**
 * VercelView Component
 *
 * A public-facing component for the Vercel site that displays
 * options levels and quantitative metrics with a 4-tab system
 * for SPY, QQQ, SPX, and NDX symbols.
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
import { SymbolData, ExpiryData, OptionData, QuantMetrics } from '../types';

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
 * Formats GEX value in millions/billions
 */
function formatGEX(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  if (Math.abs(value) >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (Math.abs(value) >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }
  return formatNumber(value);
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
 * Metrics card component
 */
function MetricsCard({ 
  title, 
  value, 
  tooltip 
}: { 
  title: string; 
  value: string; 
  tooltip?: string;
}): ReactElement {
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1" title={tooltip}>
        {title}
      </div>
      <div className="text-lg font-semibold text-white">
        {value}
      </div>
    </div>
  );
}

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
 * Expiry section component
 */
const ExpirySection: React.FC<{ expiry: ExpiryData }> = ({ expiry }) => {
  const topCalls = getTopOptionsByOI(expiry.options, 'CALL', 5);
  const topPuts = getTopOptionsByOI(expiry.options, 'PUT', 5);
  const metrics = expiry.quantMetrics;
  
  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
      {/* Expiry Header */}
      <div className="px-4 py-3 bg-gray-800/70 border-b border-gray-700/50">
        <h4 className="font-semibold text-white">
          {getExpiryDisplayLabel(expiry)}
        </h4>
      </div>
      
      {/* Quant Metrics */}
      {metrics && (
        <div className="p-4 border-b border-gray-700/30">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricsCard 
              title="Gamma Flip" 
              value={formatCurrency(metrics.gamma_flip)}
              tooltip="Price level where cumulative gamma exposure flips from positive to negative"
            />
            <MetricsCard 
              title="Max Pain" 
              value={formatCurrency(metrics.max_pain)}
              tooltip="Strike price where option holders have maximum losses"
            />
            <MetricsCard 
              title="Total GEX" 
              value={formatGEX(metrics.total_gex)}
              tooltip="Total gamma exposure - positive means dealers absorb volatility"
            />
            <MetricsCard 
              title="Skew Type" 
              value={metrics.volatility_skew?.skew_type?.toUpperCase() || 'N/A'}
              tooltip="Shape of IV curve - indicates market sentiment"
            />
          </div>
        </div>
      )}
      
      {/* Options Tables */}
      <div className="p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <OptionsTable title="Top 5 CALL Levels (by OI)" options={topCalls} side="CALL" />
          <OptionsTable title="Top 5 PUT Levels (by OI)" options={topPuts} side="PUT" />
        </div>
      </div>
    </div>
  );
};

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
 * - Automatic data fetching with caching
 * - Loading and error states
 * - Quantitative metrics display
 * - Top options by open interest
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
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white">
                Quant Options Levels
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
            
            {/* Expiry Sections */}
            {activeSymbolData.expiries && activeSymbolData.expiries.length > 0 ? (
              <div className="space-y-6">
                {activeSymbolData.expiries.map((expiry, idx) => (
                  <ExpirySection 
                    key={`${expiry.label}-${expiry.date}-${idx}`} 
                    expiry={expiry} 
                  />
                ))}
              </div>
            ) : (
              <EmptySymbolState symbol={activeTab} />
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
