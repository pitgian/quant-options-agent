/**
 * useOptionsData — Custom hook for unified market options data management
 *
 * Handles: market selection (S&P 500 / Nasdaq 100), parallel data fetching for Index + ETF,
 * auto-refresh, loading/error states, and expiry filtering.
 *
 * @module hooks/useOptionsData
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { DayTradingData, ExpiryFilter } from '../types';
import { fetchOptionsData, FetchResult, getTimeSinceUpdate } from '../services/dataService';

// ============================================================================
// HOOK RETURN TYPE
// ============================================================================

export interface UseOptionsDataReturn {
  /** True during initial load */
  loading: boolean;
  /** Error message string, if any */
  error: string | null;
  /** Currently selected market */
  market: 'SP500' | 'NASDAQ100';
  /** Change the active market */
  setMarket: (market: 'SP500' | 'NASDAQ100') => void;
  /** ETF-specific day trading data */
  etfData: DayTradingData | null;
  /** Index-specific day trading data */
  indexData: DayTradingData | null;
  /** Human-readable time since last data update */
  timeSinceUpdate: string;
  /** True when a manual refresh is in progress */
  refreshing: boolean;
  /** True when a background (silent) refresh is in progress */
  isBackgroundRefreshing: boolean;
  /** True briefly after new data arrives from a background refresh */
  showUpdatedFlash: boolean;
  /** Currently selected expiry filter */
  expiryFilter: ExpiryFilter;
  /** Change the expiry filter */
  setExpiryFilter: (filter: ExpiryFilter) => void;
  /** Trigger a manual (forced) refresh */
  handleRefresh: () => Promise<void>;
  /** Trigger a silent background refresh */
  silentRefresh: () => Promise<void>;
  /** Timestamp of the last successful client-side fetch */
  lastRefreshed: Date | null;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useOptionsData(): UseOptionsDataReturn {
  const [market, setMarketState] = useState<'SP500' | 'NASDAQ100'>('SP500');
  const [etfData, setEtfData] = useState<DayTradingData | null>(null);
  const [indexData, setIndexData] = useState<DayTradingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeSinceUpdate, setTimeSinceUpdate] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [showUpdatedFlash, setShowUpdatedFlash] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('0dte');

  const prevTimestampRef = useRef<string | null>(null);
  const marketRef = useRef(market);

  // Keep marketRef in sync for race condition guards
  useEffect(() => {
    marketRef.current = market;
  }, [market]);

  const setMarket = useCallback((newMarket: 'SP500' | 'NASDAQ100') => {
    setMarketState(newMarket);
    setExpiryFilter('0dte');
    setEtfData(null);
    setIndexData(null);
    setError(null);
  }, []);

  // ---- Data fetching ----
  const loadData = useCallback(async (forceRefresh = false) => {
    const currentMarket = market;
    setLoading(true);
    setError(null);

    const etfSymbol = currentMarket === 'SP500' ? 'SPY' : 'QQQ';
    const indexSymbol = currentMarket === 'SP500' ? 'SPX' : 'NDX';

    try {
      // Fetch both symbols in parallel from the cache or pipeline
      const [etfResult, indexResult] = await Promise.all([
        fetchOptionsData(etfSymbol, expiryFilter, forceRefresh),
        fetchOptionsData(indexSymbol, expiryFilter, forceRefresh),
      ]);

      // GUARD: market may have changed during fetch
      if (currentMarket !== marketRef.current) return;

      if (etfResult.success && etfResult.data && indexResult.success && indexResult.data) {
        setEtfData(etfResult.data);
        setIndexData(indexResult.data);
        prevTimestampRef.current = etfResult.data.timestamp ?? null;
        setLastRefreshed(new Date());
        setError(null);
      } else {
        setError(etfResult.error || indexResult.error || 'Failed to load options data');
      }
    } catch (err) {
      if (currentMarket !== marketRef.current) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (currentMarket === marketRef.current) {
        setLoading(false);
      }
    }

    // Update time since (use ETF timestamp as reference)
    const ts = await getTimeSinceUpdate(etfSymbol);
    if (currentMarket !== marketRef.current) return;
    setTimeSinceUpdate(ts);
  }, [market, expiryFilter]);

  // Silent background refresh
  const silentRefresh = useCallback(async () => {
    setIsBackgroundRefreshing(true);
    const currentMarket = market;
    const etfSymbol = currentMarket === 'SP500' ? 'SPY' : 'QQQ';
    const indexSymbol = currentMarket === 'SP500' ? 'SPX' : 'NDX';

    try {
      const [etfResult, indexResult] = await Promise.all([
        fetchOptionsData(etfSymbol, expiryFilter, true),
        fetchOptionsData(indexSymbol, expiryFilter, true),
      ]);

      // GUARD: Only update if market hasn't changed
      if (currentMarket !== marketRef.current) return;

      if (etfResult.success && etfResult.data && indexResult.success && indexResult.data) {
        const prevTimestamp = prevTimestampRef.current;
        const newTimestamp = etfResult.data.timestamp ?? null;

        if (prevTimestamp !== newTimestamp) {
          setEtfData(etfResult.data);
          setIndexData(indexResult.data);
          prevTimestampRef.current = newTimestamp;
          setLastRefreshed(new Date());
          setShowUpdatedFlash(true);
          setTimeout(() => setShowUpdatedFlash(false), 3000);
        }
      }

      const ts = await getTimeSinceUpdate(etfSymbol);
      if (currentMarket !== marketRef.current) return;
      setTimeSinceUpdate(ts);
    } finally {
      setIsBackgroundRefreshing(false);
    }
  }, [market, expiryFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh: 60s during US market hours (13:30-20:00 UTC), 5 min otherwise
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const now = new Date();
      const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
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

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  };

  return {
    loading,
    error,
    market,
    setMarket,
    etfData,
    indexData,
    timeSinceUpdate,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    silentRefresh,
    lastRefreshed,
  };
}
