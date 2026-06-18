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
const GIST_USER = import.meta.env.VITE_GIST_USER;
const GIST_ID = import.meta.env.VITE_GIST_ID;

const REPO_DATA_URL = 'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data/options_data.json';
const GIST_DATA_URL = GIST_USER && GIST_ID 
  ? `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/options_data.json`
  : null;

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
 * - Tries to fetch the latest data from GitHub Gist or Raw repo branch
 * - Falls back to local JSON file
 * - Falls back to stale in-memory cache as last resort
 */
export async function fetchRawData(forceRefresh: boolean = false): Promise<RawJson | null> {
  const now = Date.now();

  // Return fresh cache if available
  if (!forceRefresh && cache && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return cache.data;
  }

  const isDev = import.meta.env.DEV;

  // Build the list of URLs to try in order
  const urls: { name: string; url: string | null }[] = [];
  
  if (isDev) {
    urls.push({ name: 'Local File', url: LOCAL_DATA_URL });
    if (GIST_DATA_URL) urls.push({ name: 'Gist', url: GIST_DATA_URL });
    urls.push({ name: 'GitHub Repo Branch', url: REPO_DATA_URL });
  } else {
    if (GIST_DATA_URL) urls.push({ name: 'Gist', url: GIST_DATA_URL });
    urls.push({ name: 'GitHub Repo Branch', url: REPO_DATA_URL });
    urls.push({ name: 'Local Static Fallback', url: LOCAL_DATA_URL });
  }

  const fetchJson = async (url: string): Promise<RawJson> => {
    const response = await fetch(`${url}?t=${Date.now()}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-cache',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: RawJson = await response.json();

    if (!data.version || !data.symbols) {
      throw new Error('Invalid data structure');
    }

    return data;
  };

  let bestData: RawJson | null = null;
  let bestTime = 0;

  for (const source of urls) {
    if (!source.url) continue;
    try {
      console.log(`Fetching options data from ${source.name}...`);
      const data = await fetchJson(source.url);
      const genTime = data.generated ? new Date(data.generated).getTime() : 0;
      
      // Keep track of the newest data we find
      if (!bestData || genTime > bestTime) {
        bestData = data;
        bestTime = genTime;
      }
      
      // If the data is fresh (less than 10 minutes old), we can stop searching to speed up loading
      const ageMs = now - genTime;
      if (ageMs < 10 * 60 * 1000) {
        console.log(`Source ${source.name} is fresh (age: ${Math.round(ageMs / 1000 / 60)}m). Stopping fetch cascade.`);
        break;
      }
    } catch (err) {
      console.warn(`Failed to fetch from ${source.name}:`, err);
    }
  }

  if (bestData) {
    cache = { timestamp: now, data: bestData };
    return bestData;
  }

  // Fallback to memory cache as absolute last resort
  if (cache) {
    console.warn("All fetch sources failed, returning stale memory cache");
    return cache.data;
  }

  return null;
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
