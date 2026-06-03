/**
 * useOptionsData — Custom hook for options data management
 *
 * Handles: symbol selection, data fetching, auto-refresh, loading/error states,
 * expiry filtering, and highlighted strike interaction.
 *
 * Returns DayTradingData for simplified day trading display.
 * Also provides legacy OptionsData fields for backward compatibility with
 * existing UI components (will be removed in Phase 3).
 *
 * @module hooks/useOptionsData
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  DayTradingData,
  ExpiryFilter,
  // Legacy types (backward compat)
  OptionsData,
  WallLevel,
  ConfluenceLevel,
  KeyLevel,
  ExpirationFilterPreset,
} from '../types';
import { fetchOptionsData, FetchResult, getTimeSinceUpdate } from '../services/dataService';
import { fetchLiveSpot, getSpotForSymbol } from '../services/spotService';

// ============================================================================
// LEGACY DATA BRIDGE
// ============================================================================

/**
 * Converts DayTradingData to legacy OptionsData format for backward compatibility
 * with existing UI components. Will be removed in Phase 3.
 *
 * @deprecated This is a temporary bridge. UI components should be updated to
 * use DayTradingData directly.
 */
function toLegacyOptionsData(data: DayTradingData): OptionsData {
  const putWalls: WallLevel[] = data.support.map(s => ({
    strike: s.strike,
    totalOI: s.totalOI,
    totalVolume: s.totalVolume,
    score: s.strength,
    expirations: [],
    type: 'put' as const,
    putOI: s.totalOI,
    putVolume: s.totalVolume,
    callOI: 0,
    callVolume: 0,
    callGEX: 0,
    putGEX: 0,
    netGEX: 0,
  }));

  const callWalls: WallLevel[] = data.resistance.map(r => ({
    strike: r.strike,
    totalOI: r.totalOI,
    totalVolume: r.totalVolume,
    score: r.strength,
    expirations: [],
    type: 'call' as const,
    putOI: 0,
    putVolume: 0,
    callOI: r.totalOI,
    callVolume: r.totalVolume,
    callGEX: 0,
    putGEX: 0,
    netGEX: 0,
  }));

  const confluenceLevels: ConfluenceLevel[] = [];

  const keyLevels: KeyLevel[] = [
    ...data.support.map(s => ({
      type: 'put_wall' as const,
      strike: s.strike,
      score: s.strength,
      distanceFromSpot: s.distance,
      label: s.label,
      details: putWalls.find(w => w.strike === s.strike) || {
        strike: s.strike,
        totalOI: s.totalOI,
        totalVolume: s.totalVolume,
        score: s.strength,
        expirations: [],
        type: 'put' as const,
        putOI: s.totalOI,
        putVolume: s.totalVolume,
        callOI: 0,
        callVolume: 0,
        callGEX: 0,
        putGEX: 0,
        netGEX: 0,
      },
    })),
    ...data.resistance.map(r => ({
      type: 'call_wall' as const,
      strike: r.strike,
      score: r.strength,
      distanceFromSpot: r.distance,
      label: r.label,
      details: callWalls.find(w => w.strike === r.strike) || {
        strike: r.strike,
        totalOI: r.totalOI,
        totalVolume: r.totalVolume,
        score: r.strength,
        expirations: [],
        type: 'call' as const,
        putOI: 0,
        putVolume: 0,
        callOI: r.totalOI,
        callVolume: r.totalVolume,
        callGEX: 0,
        putGEX: 0,
        netGEX: 0,
      },
    })),
  ];

  return {
    symbol: data.symbol,
    spotPrice: data.spot,
    putWalls,
    callWalls,
    confluenceLevels,
    keyLevels,
    totalNetGEX: data.gexRegime.netGEX,
    gexFlipPoint: data.gexRegime.flipPoint ?? 0,
    allExpirations: [],
    lastUpdated: data.timestamp,
  };
}

// ============================================================================
// HOOK RETURN TYPE
// ============================================================================

/** Return type of the useOptionsData hook */
export interface UseOptionsDataReturn {
  /** New simplified day trading data */
  data: DayTradingData | null;
  /** True during initial load (no stale data available) */
  loading: boolean;
  /** Error message string, if any */
  error: string | null;
  /** Currently selected symbol */
  symbol: string;
  /** Change the active symbol */
  setSymbol: (symbol: string) => void;
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
  /** Currently highlighted strike for cross-component interaction */
  highlightedStrike: number | null;
  /** Set the highlighted strike */
  setHighlightedStrike: (strike: number | null) => void;
  /** Timestamp of the last successful client-side fetch */
  lastRefreshed: Date | null;
  /** Live spot price from Finnhub (real-time), null if unavailable */
  liveSpot: number | null;

  // ---- Legacy backward compatibility (deprecated, Phase 3 will remove) ----
  /** @deprecated Use data instead. Legacy OptionsData for backward compat. */
  displayData: OptionsData | null;
  /** @deprecated Use expiryFilter instead */
  expirationFilter: ExpirationFilterPreset;
  /** @deprecated Use setExpiryFilter instead */
  setExpirationFilter: (filter: ExpirationFilterPreset) => void;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useOptionsData(): UseOptionsDataReturn {
  const [data, setData] = useState<DayTradingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbolState] = useState('SPY');
  const [timeSinceUpdate, setTimeSinceUpdate] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [showUpdatedFlash, setShowUpdatedFlash] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const prevTimestampRef = useRef<string | null>(null);
  const symbolRef = useRef(symbol);
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('0dte');
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(null);
  const [liveSpot, setLiveSpot] = useState<number | null>(null);

  // ---- Symbol change handler (also resets filter) ----
  const setSymbol = useCallback((newSymbol: string) => {
    setSymbolState(newSymbol);
    setExpiryFilter('0dte');
    setHighlightedStrike(null);
    setData(null);          // Prevent stale data from wrong symbol
    setError(null);         // Clear any previous error
  }, []);

  // Keep symbolRef in sync for race condition guards
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);

  // ---- Legacy backward compat wrappers ----
  const expirationFilter = expiryFilter;
  const setExpirationFilter = useCallback((filter: ExpirationFilterPreset) => {
    setExpiryFilter(filter);
  }, []);

  // ---- Legacy displayData bridge ----
  const displayData = useMemo(() => {
    if (!data) return null;
    return toLegacyOptionsData(data);
  }, [data]);

  // ---- Data fetching ----
  const loadData = useCallback(async (forceRefresh = false) => {
    const currentSymbol = symbol;
    setLoading(true);
    setError(null);

    try {
      const result: FetchResult = await fetchOptionsData(currentSymbol, expiryFilter, forceRefresh);

      // GUARD: symbol may have changed during fetch
      if (currentSymbol !== symbolRef.current) return;

      if (result.success && result.data) {
        setData(result.data);
        prevTimestampRef.current = result.data.timestamp ?? null;
        setLastRefreshed(new Date());
        setError(null);
      } else {
        setError(result.error || 'Unknown error');
      }
    } catch (err) {
      if (currentSymbol !== symbolRef.current) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (currentSymbol === symbolRef.current) {
        setLoading(false);
      }
    }

    // Update time since
    const ts = await getTimeSinceUpdate(currentSymbol);
    if (currentSymbol !== symbolRef.current) return;
    setTimeSinceUpdate(ts);
  }, [symbol, expiryFilter]);

  // Silent background refresh — does NOT show the full-page loading spinner.
  // Uses forceRefresh=true to bypass localStorage cache and fetch fresh data
  // from GitHub (via fetchService). Only updates React state when the data
  // timestamp actually changes, avoiding unnecessary re-renders.
  const silentRefresh = useCallback(async () => {
    setIsBackgroundRefreshing(true);
    const currentSymbol = symbol;
    try {
      const result: FetchResult = await fetchOptionsData(currentSymbol, expiryFilter, true);
      // GUARD: Only update if symbol hasn't changed during fetch
      if (currentSymbol !== symbolRef.current) return;
      if (result.success && result.data) {
        const prevTimestamp = prevTimestampRef.current;
        const newTimestamp = result.data.timestamp ?? null;
        // Only update state when data actually changed (new timestamp)
        if (prevTimestamp !== newTimestamp) {
          setData(result.data);
          prevTimestampRef.current = newTimestamp;
          setLastRefreshed(new Date());
          setShowUpdatedFlash(true);
          setTimeout(() => setShowUpdatedFlash(false), 3000);
        }
      }
      const ts = await getTimeSinceUpdate(currentSymbol);
      if (currentSymbol !== symbolRef.current) return;
      setTimeSinceUpdate(ts);
    } finally {
      setIsBackgroundRefreshing(false);
    }
  }, [symbol, expiryFilter]);

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

  // Live spot price polling — every 30 seconds during market hours
  useEffect(() => {
    if (!data?.symbol) return;

    const isMarketHours = () => {
      const now = new Date();
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      const minutesSinceMidnight = utcH * 60 + utcM;
      return minutesSinceMidnight >= 13 * 60 + 30 && minutesSinceMidnight < 20 * 60;
    };

    const pollSpot = async () => {
      if (!isMarketHours()) return;
      try {
        const spotResponse = await fetchLiveSpot();
        if (spotResponse && data?.symbol) {
          const spot = getSpotForSymbol(spotResponse, data.symbol);
          if (spot && spot > 0) setLiveSpot(spot);
        }
      } catch {
        // Silently fail — keep using cron job spot
      }
    };

    pollSpot();
    const interval = setInterval(pollSpot, 30_000);
    return () => clearInterval(interval);
  }, [data?.symbol]);

  // ---- Handlers ----
  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  };

  return {
    data,
    loading,
    error,
    symbol,
    setSymbol,
    timeSinceUpdate,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    silentRefresh,
    highlightedStrike,
    setHighlightedStrike,
    lastRefreshed,
    liveSpot,
    // Legacy backward compat
    displayData,
    expirationFilter,
    setExpirationFilter,
  };
}
