/**
 * Fetch Service
 *
 * Handles raw data fetching from GitHub with in-memory caching (15-min TTL).
 * Provides data freshness checks and metadata queries.
 *
 * @module services/fetchService
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

/** GitHub Raw URL for the options data JSON file */
const GITHUB_DATA_URL = 'https://raw.githubusercontent.com/pitgian/quant-options-agent/master/data/options_data.json';
const LOCAL_DATA_URL = '/data/options_data.json';

/** Cache duration in milliseconds (3 minutes — must be shorter than cron interval) */
const CACHE_DURATION_MS = 3 * 60 * 1000;

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/** Raw JSON structure produced by the Python script */
export interface RawJson {
  version: string;
  generated: string;
  symbols: Record<string, RawSymbolData>;
  cross_symbol_confluence?: Record<string, RawCrossSymbolPair>;
}

export interface RawSymbolData {
  spot: number;
  generated: string;
  expiries: RawExpiry[];
  walls?: {
    put_walls: RawWall[];
    call_walls: RawWall[];
    confluence_levels?: RawConfluenceLevel[];
  };
  total_net_gex?: number;
  gex_flip_point?: number | null;
  futures_volume_profile?: Record<string, number>;
}

export interface RawExpiry {
  label: string;
  date: string;
  options: RawOption[];
}

export interface RawOption {
  strike: number;
  side: 'CALL' | 'PUT';
  oi: number;
  vol: number;
  gamma?: number;
}

export interface RawWall {
  strike: number;
  type: string;
  total_oi: number;
  total_vol: number;
  score: number;
  contributing_expiries: string[];
  distance_pct: number;
  expirations?: RawExpirationDetail[];
  put_oi?: number;
  put_vol?: number;
  call_oi?: number;
  call_vol?: number;
  call_gex?: number;
  put_gex?: number;
  net_gex?: number;
}

export interface RawConfluenceLevel extends RawWall {
  total_interest?: number;
  confluence_ratio?: number;
}

export interface RawExpirationDetail {
  expiration_date: string;
  days_to_expiry: number;
  oi: number;
  volume: number;
  weight: number;
}

// ============================================================================
// CROSS-SYMBOL RAW TYPES
// ============================================================================

export interface RawCrossSymbolSide {
  symbol: string;
  strike: number;
  distance_pct: number;
  total_oi: number;
  total_vol: number;
  score: number;
  wall_type: string;
}

export interface RawCrossSymbolLevel {
  type: string;  // 'support' | 'resistance'
  cross_score: number;
  etf: RawCrossSymbolSide;
  index: RawCrossSymbolSide;
  combined_oi: number;
  combined_vol: number;
  combined_activity: number;
}

export interface RawCrossSymbolPair {
  pair: string;
  etf_symbol: string;
  index_symbol: string;
  ratio: number;
  levels: RawCrossSymbolLevel[];
}

/** Internal cache entry */
interface CacheEntry {
  timestamp: number;
  data: RawJson;
}

// ============================================================================
// MODULE-LEVEL CACHE
// ============================================================================

let cache: CacheEntry | null = null;

// ============================================================================
// RAW DATA FETCHING
// ============================================================================

/**
 * Fetches the raw JSON data with in-memory caching.
 *
 * - Tries to fetch the latest data from GitHub Raw URL first (works in both dev and prod)
 * - Falls back to the local JSON file if offline or GitHub is down
 * - Falls back to stale in-memory cache as last resort
 */
export async function fetchRawData(forceRefresh: boolean = false): Promise<RawJson | null> {
  const now = Date.now();

  // Return fresh cache if available
  if (!forceRefresh && cache && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return cache.data;
  }

  const isDev = import.meta.env.DEV;
  const url1 = isDev ? LOCAL_DATA_URL : GITHUB_DATA_URL;
  const url2 = isDev ? GITHUB_DATA_URL : LOCAL_DATA_URL;

  // 1. Try fetching from primary URL
  try {
    const response = await fetch(`${url1}?t=${Date.now()}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-cache',
    });

    if (!response.ok) {
      throw new Error(`Primary HTTP ${response.status}: ${response.statusText}`);
    }

    const data: RawJson = await response.json();

    if (!data.version || !data.symbols) {
      throw new Error('Invalid data structure from primary source');
    }

    // Update cache
    cache = { timestamp: now, data };
    return data;
  } catch (primaryError) {
    console.warn(`Failed to fetch from primary source, falling back to secondary:`, primaryError);

    // 2. Fallback to secondary URL
    try {
      const response = await fetch(`${url2}?t=${Date.now()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-cache',
      });

      if (!response.ok) {
        throw new Error(`Secondary HTTP ${response.status}: ${response.statusText}`);
      }

      const data: RawJson = await response.json();

      if (!data.version || !data.symbols) {
        throw new Error('Invalid data structure from secondary source');
      }

      // Update cache
      cache = { timestamp: now, data };
      return data;
    } catch (secondaryError) {
      console.error('All options data sources failed:', secondaryError);

      // 3. Fall back to stale in-memory cache if available
      if (cache) {
        return cache.data;
      }

      return null;
    }
  }
}

// ============================================================================
// METADATA HELPERS
// ============================================================================

/**
 * Returns all available symbols in the cached/fetched data.
 */
export async function getAvailableSymbols(): Promise<string[]> {
  const raw = await fetchRawData();
  if (!raw?.symbols) return [];
  return Object.keys(raw.symbols);
}

/**
 * Checks if the data for a symbol is fresh (generated less than 15 minutes ago).
 */
export async function isDataFresh(symbol: string = 'SPY'): Promise<boolean> {
  const raw = await fetchRawData();
  if (!raw) return false;

  const symbolData = raw.symbols[symbol.toUpperCase()];
  if (!symbolData) return false;

  try {
    const generatedTime = new Date(symbolData.generated || raw.generated).getTime();
    return (Date.now() - generatedTime) < CACHE_DURATION_MS;
  } catch {
    return false;
  }
}

/**
 * Gets the age of the data in minutes for a given symbol.
 */
export async function getDataAgeMinutes(symbol: string = 'SPY'): Promise<number> {
  const raw = await fetchRawData();
  if (!raw) return -1;

  const symbolData = raw.symbols[symbol.toUpperCase()];
  if (!symbolData) return -1;

  try {
    const generatedTime = new Date(symbolData.generated || raw.generated).getTime();
    return Math.max(0, Math.floor((Date.now() - generatedTime) / (1000 * 60)));
  } catch {
    return -1;
  }
}

/**
 * Gets a human-readable last update time for a given symbol.
 */
export async function getLastUpdateTime(symbol: string = 'SPY'): Promise<string> {
  const raw = await fetchRawData();
  if (!raw) return 'Unknown';

  const symbolData = raw.symbols[symbol.toUpperCase()];
  if (!symbolData) return 'Unknown';

  try {
    const date = new Date(symbolData.generated || raw.generated);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    });
  } catch {
    return 'Unknown';
  }
}

/**
 * Clears the in-memory cache.
 */
export function clearFetchCache(): void {
  cache = null;
}

/**
 * Gets the current cache status for debugging.
 */
export function getFetchCacheStatus(): { cached: boolean; ageMinutes: number; symbols: string[] } | null {
  if (!cache) return null;

  return {
    cached: true,
    ageMinutes: Math.round((Date.now() - cache.timestamp) / 1000 / 60),
    symbols: Object.keys(cache.data.symbols),
  };
}
