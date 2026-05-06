/**
 * Data Service (Simplified)
 *
 * Thin adapter over vercelDataService. Provides a simple interface
 * for the frontend to fetch and cache OptionsData.
 *
 * @module services/dataService
 */

import { OptionsData } from '../types';
import {
  fetchOptionsData as fetchFromVercel,
  clearCache as clearVercelCache,
  getDataAgeMinutes,
  getLastUpdateTime,
  getAvailableSymbols,
} from './vercelDataService';

// ============================================================================
// LOCAL STORAGE CACHE
// ============================================================================

const CACHE_KEY = 'options_data_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface LocalCacheEntry {
  symbol: string;
  data: OptionsData;
  timestamp: number;
}

function getLocalCache(symbol: string): OptionsData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const entry: LocalCacheEntry = JSON.parse(raw);
    if (entry.symbol !== symbol) return null;
    if (Date.now() - entry.timestamp >= CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

function setLocalCache(symbol: string, data: OptionsData): void {
  try {
    const entry: LocalCacheEntry = { symbol, data, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch (e) {
    console.warn('[dataService] Failed to write local cache:', e);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface FetchResult {
  success: boolean;
  data: OptionsData | null;
  fromCache: boolean;
  error?: string;
}

/**
 * Fetches OptionsData for a given symbol.
 *
 * Checks localStorage cache first, then falls back to vercelDataService.
 */
export async function fetchOptionsData(
  symbol: string = 'SPY',
  forceRefresh: boolean = false
): Promise<FetchResult> {
  // Check local cache unless force refresh
  if (!forceRefresh) {
    const cached = getLocalCache(symbol);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }
  }

  try {
    const data = await fetchFromVercel(symbol, forceRefresh);

    if (!data) {
      return { success: false, data: null, fromCache: false, error: 'No data available' };
    }

    // Save to local cache
    setLocalCache(symbol, data);

    return { success: true, data, fromCache: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[dataService] Fetch failed:', message);

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
 * Clears all caches (local + vercel).
 */
export function clearAllCaches(): void {
  localStorage.removeItem(CACHE_KEY);
  clearVercelCache();
}

/**
 * Re-exports for convenience
 */
export { getAvailableSymbols, getDataAgeMinutes, getLastUpdateTime };
