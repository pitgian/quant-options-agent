/**
 * Data Service
 *
 * Thin adapter over the modular service pipeline. Provides a simple interface
 * for the frontend to fetch and cache DayTradingData with localStorage caching.
 *
 * @module services/dataService
 */

import { DayTradingData, ExpiryFilter } from '../types';
import {
  fetchOptionsData as fetchFromPipeline,
  clearCache as clearPipelineCache,
  getDataAgeMinutes,
  getLastUpdateTime,
  getAvailableSymbols,
} from './index';

// ============================================================================
// LOCAL STORAGE CACHE
// ============================================================================

const CACHE_VERSION = '6.1';
const CACHE_KEY = `options_data_cache_v${CACHE_VERSION}`;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface LocalCacheEntry {
  symbol: string;
  filter: ExpiryFilter;
  data: DayTradingData;
  timestamp: number;
}

function getLocalCache(symbol: string, filter: ExpiryFilter): DayTradingData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const entry: LocalCacheEntry = JSON.parse(raw);
    if (entry.symbol !== symbol || entry.filter !== filter) return null;
    if (Date.now() - entry.timestamp >= CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

function setLocalCache(symbol: string, filter: ExpiryFilter, data: DayTradingData): void {
  try {
    const entry: LocalCacheEntry = { symbol, filter, data, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Silently ignore storage errors
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface FetchResult {
  success: boolean;
  data: DayTradingData | null;
  fromCache: boolean;
  error?: string;
}

/**
 * Fetches DayTradingData for a given symbol and expiry filter.
 *
 * Checks localStorage cache first, then falls back to the service pipeline.
 */
export async function fetchOptionsData(
  symbol: string = 'SPY',
  expiryFilter: ExpiryFilter = '0dte',
  forceRefresh: boolean = false
): Promise<FetchResult> {
  // Check local cache unless force refresh
  if (!forceRefresh) {
    const cached = getLocalCache(symbol, expiryFilter);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }
  }

  try {
    const data = await fetchFromPipeline(symbol, expiryFilter, forceRefresh);

    if (!data) {
      return { success: false, data: null, fromCache: false, error: 'No data available' };
    }

    // Save to local cache
    setLocalCache(symbol, expiryFilter, data);

    return { success: true, data, fromCache: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    return { success: false, data: null, fromCache: false, error: message };
  }
}

/**
 * Returns a human-readable string for time since last update.
 */
export async function getTimeSinceUpdate(symbol: string = 'SPY'): Promise<string> {
  const minutes = await getDataAgeMinutes(symbol);

  if (minutes < 0) return 'Never';
  if (minutes === 0) return 'Just now';

  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
}

/**
 * Clears all caches (local + pipeline).
 */
export function clearAllCaches(): void {
  localStorage.removeItem(CACHE_KEY);
  clearPipelineCache();
}

/**
 * Gets cache information for debugging.
 */
export function getCacheInfo(): { version: string; hasLocalCache: boolean; localCacheSymbol?: string; localCacheAge?: number } {
  const info: { version: string; hasLocalCache: boolean; localCacheSymbol?: string; localCacheAge?: number } = {
    version: CACHE_VERSION,
    hasLocalCache: false,
  };

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const entry: LocalCacheEntry = JSON.parse(raw);
      info.hasLocalCache = true;
      info.localCacheSymbol = entry.symbol;
      info.localCacheAge = Math.round((Date.now() - entry.timestamp) / 1000 / 60);
    }
  } catch {
    // ignore
  }

  return info;
}

/**
 * Re-exports for convenience
 */
export { getAvailableSymbols, getDataAgeMinutes, getLastUpdateTime };
