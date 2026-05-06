/**
 * Vercel Data Service (Simplified)
 *
 * Fetches options data from the static JSON file hosted on GitHub/Vercel
 * and parses it into the simplified OptionsData type.
 *
 * @module services/vercelDataService
 */

import { OptionsData, WallLevel, ExpirationDetail } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** GitHub Raw URL for the options data JSON file */
const DATA_URL = 'https://raw.githubusercontent.com/pitgian/quant-options-agent/master/data/options_data.json';

/** Cache duration in milliseconds (15 minutes) */
const CACHE_DURATION_MS = 15 * 60 * 1000;

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/** Raw JSON structure produced by the Python script */
interface RawJson {
  version: string;
  generated: string;
  symbols: Record<string, RawSymbolData>;
}

interface RawSymbolData {
  spot: number;
  generated: string;
  expiries: RawExpiry[];
  walls?: {
    put_walls: RawWall[];
    call_walls: RawWall[];
  };
}

interface RawExpiry {
  label: string;
  date: string;
  options: RawOption[];
}

interface RawOption {
  strike: number;
  side: 'CALL' | 'PUT';
  oi: number;
  vol: number;
}

interface RawExpirationDetail {
  expiration_date: string;
  days_to_expiry: number;
  oi: number;
  volume: number;
  weight: number;
}

interface RawWall {
  strike: number;
  type: string;
  total_oi: number;
  total_vol: number;
  score: number;
  contributing_expiries: string[];
  distance_pct: number;
  expirations?: RawExpirationDetail[];
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
 * - Returns cached data if less than 15 minutes old
 * - Falls back to stale cache on network errors
 */
async function fetchRawData(forceRefresh: boolean = false): Promise<RawJson | null> {
  const now = Date.now();

  // Return fresh cache if available
  if (!forceRefresh && cache && (now - cache.timestamp) < CACHE_DURATION_MS) {
    console.log('[vercelDataService] Returning cached data (age:',
      Math.round((now - cache.timestamp) / 1000 / 60), 'min)');
    return cache.data;
  }

  try {
    console.log('[vercelDataService] Fetching fresh data from GitHub Raw...');

    const response = await fetch(DATA_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: RawJson = await response.json();

    if (!data.version || !data.symbols) {
      throw new Error('Invalid data structure: missing version or symbols');
    }

    // Update cache
    cache = { timestamp: now, data };

    console.log('[vercelDataService] Fetched data — version:', data.version,
      '| generated:', data.generated,
      '| symbols:', Object.keys(data.symbols).join(', '));

    return data;
  } catch (error) {
    console.error('[vercelDataService] Fetch error:', error);

    // Fall back to stale cache
    if (cache) {
      console.warn('[vercelDataService] Falling back to stale cached data');
      return cache.data;
    }

    return null;
  }
}

// ============================================================================
// DATA MAPPING
// ============================================================================

/**
 * Builds per-expiration breakdown for a wall strike by looking up
 * the raw options data from each expiry.
 */
function buildExpirationDetails(
  strike: number,
  wallType: 'put' | 'call',
  expiries: RawExpiry[]
): ExpirationDetail[] {
  const side = wallType === 'put' ? 'PUT' : 'CALL';
  const details: ExpirationDetail[] = [];

  for (const expiry of expiries) {
    const match = expiry.options.find(
      opt => opt.strike === strike && opt.side === side
    );

    if (match && (match.oi > 0 || match.vol > 0)) {
      const expiryDate = new Date(expiry.date);
      const now = new Date();
      const daysToExpiry = Math.max(0, Math.ceil(
        (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      ));

      details.push({
        expirationDate: expiry.date,
        daysToExpiry,
        oi: match.oi,
        volume: match.vol,
        weight: 1.0,
      });
    }
  }

  return details;
}

/**
 * Maps raw wall data from JSON to WallLevel[] for the frontend.
 */
function mapWalls(
  rawWalls: RawWall[],
  wallType: 'put' | 'call',
  expiries: RawExpiry[]
): WallLevel[] {
  if (!rawWalls || !Array.isArray(rawWalls)) return [];

  return rawWalls.map(w => ({
    strike: w.strike,
    totalOI: w.total_oi,
    totalVolume: w.total_vol,
    score: w.score,
    type: wallType,
    expirations: w.expirations && w.expirations.length > 0
      ? w.expirations.map(e => ({
          expirationDate: e.expiration_date,
          daysToExpiry: e.days_to_expiry,
          oi: e.oi,
          volume: e.volume,
          weight: e.weight ?? 1.0,
        }))
      : buildExpirationDetails(w.strike, wallType, expiries),
  }));
}

// ============================================================================
// WALL COMPUTATION FROM OLD FORMAT (v2.0 backward compatibility)
// ============================================================================

/**
 * Computes walls from raw expiry data (old format v2.0).
 *
 * Aggregates OI and Volume per strike across all expirations, computes a score
 * using min-max normalized OI (weight 0.6) + normalized Volume (weight 0.4),
 * and selects the top walls below/above spot price.
 */
function computeWallsFromExpiries(
  expiries: RawExpiry[],
  spotPrice: number
): { putWalls: WallLevel[]; callWalls: WallLevel[] } {
  // Aggregate OI and Volume per strike, per side
  const putMap = new Map<number, { oi: number; vol: number }>();
  const callMap = new Map<number, { oi: number; vol: number }>();

  for (const expiry of expiries) {
    for (const opt of expiry.options) {
      const map = opt.side === 'PUT' ? putMap : callMap;
      const existing = map.get(opt.strike) || { oi: 0, vol: 0 };
      existing.oi += opt.oi;
      existing.vol += opt.vol;
      map.set(opt.strike, existing);
    }
  }

  /**
   * Selects top N walls from an aggregated strike map.
   * Filters by `filterFn` (e.g. strike < spot for puts), scores, sorts, and builds WallLevel[].
   */
  function computeTopWalls(
    map: Map<number, { oi: number; vol: number }>,
    wallType: 'put' | 'call',
    filterFn: (strike: number) => boolean
  ): WallLevel[] {
    const entries = Array.from(map.entries())
      .filter(([strike, data]) => filterFn(strike) && (data.oi > 0 || data.vol > 0));

    if (entries.length === 0) return [];

    // Min-max normalization values
    const oiValues = entries.map(([, d]) => d.oi);
    const volValues = entries.map(([, d]) => d.vol);
    const minOI = Math.min(...oiValues);
    const maxOI = Math.max(...oiValues);
    const minVol = Math.min(...volValues);
    const maxVol = Math.max(...volValues);

    const scored = entries.map(([strike, data]) => {
      const normOI = maxOI > minOI ? (data.oi - minOI) / (maxOI - minOI) : 1;
      const normVol = maxVol > minVol ? (data.vol - minVol) / (maxVol - minVol) : 1;
      const score = normOI * 0.6 + normVol * 0.4;
      return { strike, oi: data.oi, vol: data.vol, score };
    });

    // Sort by score descending, take top 12
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 12);

    return top.map(({ strike, oi, vol, score }) => ({
      strike,
      totalOI: oi,
      totalVolume: vol,
      score,
      type: wallType,
      expirations: buildExpirationDetails(strike, wallType, expiries).map(e => ({
        ...e,
        weight: 1.0,
      })),
    }));
  }

  // Put walls: strikes below spot price
  const putWalls = computeTopWalls(putMap, 'put', (strike) => strike < spotPrice);
  // Call walls: strikes above spot price
  const callWalls = computeTopWalls(callMap, 'call', (strike) => strike > spotPrice);

  return { putWalls, callWalls };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Fetches OptionsData for a specific symbol.
 *
 * @param symbol - The symbol to fetch (e.g., 'SPY', 'QQQ')
 * @param forceRefresh - If true, bypasses cache and fetches fresh data
 * @returns Parsed OptionsData or null if unavailable
 */
export async function fetchOptionsData(
  symbol: string = 'SPY',
  forceRefresh: boolean = false
): Promise<OptionsData | null> {
  const raw = await fetchRawData(forceRefresh);
  if (!raw) return null;

  const upperSymbol = symbol.toUpperCase();
  const symbolData = raw.symbols[upperSymbol];

  if (!symbolData) {
    console.warn(`[vercelDataService] Symbol "${upperSymbol}" not found in data`);
    return null;
  }

  const allExpirations = symbolData.expiries?.map(e => e.date) || [];

  // Determine wall data source: new format (pre-computed walls) or old format (compute from expiries)
  let putWalls: WallLevel[];
  let callWalls: WallLevel[];

  if (symbolData.walls) {
    // New format: walls are pre-computed in the JSON
    putWalls = mapWalls(symbolData.walls.put_walls, 'put', symbolData.expiries || []);
    callWalls = mapWalls(symbolData.walls.call_walls, 'call', symbolData.expiries || []);
  } else if (symbolData.expiries && symbolData.expiries.length > 0) {
    // Old format (v2.0): compute walls on the fly from raw options data
    console.log(`[vercelDataService] Computing walls from raw expiry data for "${upperSymbol}" (old format v2.0)`);
    const computed = computeWallsFromExpiries(symbolData.expiries, symbolData.spot);
    putWalls = computed.putWalls;
    callWalls = computed.callWalls;
  } else {
    console.warn(`[vercelDataService] No wall data found for "${upperSymbol}"`);
    return null;
  }

  return {
    symbol: upperSymbol,
    spotPrice: symbolData.spot,
    timestamp: symbolData.generated || raw.generated,
    putWalls,
    callWalls,
    allExpirations,
  };
}

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
  const data = await fetchOptionsData(symbol);
  if (!data) return false;

  try {
    const generatedTime = new Date(data.timestamp).getTime();
    return (Date.now() - generatedTime) < CACHE_DURATION_MS;
  } catch {
    return false;
  }
}

/**
 * Gets the age of the data in minutes for a given symbol.
 */
export async function getDataAgeMinutes(symbol: string = 'SPY'): Promise<number> {
  const data = await fetchOptionsData(symbol);
  if (!data) return -1;

  try {
    const generatedTime = new Date(data.timestamp).getTime();
    return Math.max(0, Math.floor((Date.now() - generatedTime) / (1000 * 60)));
  } catch {
    return -1;
  }
}

/**
 * Gets a human-readable last update time for a given symbol.
 */
export async function getLastUpdateTime(symbol: string = 'SPY'): Promise<string> {
  const data = await fetchOptionsData(symbol);
  if (!data) return 'Unknown';

  try {
    const date = new Date(data.timestamp);
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
export function clearCache(): void {
  cache = null;
  console.log('[vercelDataService] Cache cleared');
}

/**
 * Gets the current cache status for debugging.
 */
export function getCacheStatus(): { cached: boolean; ageMinutes: number; symbols: string[] } | null {
  if (!cache) return null;

  return {
    cached: true,
    ageMinutes: Math.round((Date.now() - cache.timestamp) / 1000 / 60),
    symbols: Object.keys(cache.data.symbols),
  };
}
