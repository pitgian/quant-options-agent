/**
 * spotService — Frontend Spot Price Service
 *
 * Fetches real-time spot prices from the /api/spot Vercel serverless function.
 * Includes in-memory caching (15s TTL) to avoid excessive API calls.
 *
 * Gracefully degrades: returns null if the API is unavailable, allowing
 * the UI to fall back to the cron job spot price from options_data.json.
 *
 * @module services/spotService
 */

const SPOT_API_URL = '/api/spot';
const SPOT_CACHE_TTL = 15_000; // 15 seconds minimum between API calls

export interface SpotResponse {
  /** Direct ETF prices: { SPY: 761.23, QQQ: 524.15 } */
  spots: Record<string, number>;
  /** Derived index prices: { SPX: 7612.30, NDX: 21490.15 } */
  derived: Record<string, number>;
  /** ISO timestamp of when the data was fetched */
  timestamp: string;
}

let cachedSpot: { data: SpotResponse; fetchedAt: number } | null = null;

/**
 * Fetch live spot prices from the serverless API.
 * Uses in-memory cache to avoid hitting Finnhub more than once per 15 seconds.
 * Returns null if the API is unavailable (graceful degradation).
 */
export async function fetchLiveSpot(): Promise<SpotResponse | null> {
  // Check in-memory cache
  if (cachedSpot && Date.now() - cachedSpot.fetchedAt < SPOT_CACHE_TTL) {
    return cachedSpot.data;
  }

  try {
    const response = await fetch(`${SPOT_API_URL}?t=${Date.now()}`);
    if (!response.ok) return cachedSpot?.data ?? null;

    const data: SpotResponse = await response.json();
    cachedSpot = { data, fetchedAt: Date.now() };
    return data;
  } catch {
    return cachedSpot?.data ?? null;
  }
}

/**
 * Get the live spot price for a specific symbol.
 * Checks both direct ETF prices and derived index prices.
 * Returns null if not available (falls back to cron job spot).
 */
export function getSpotForSymbol(
  spotResponse: SpotResponse | null,
  symbol: string
): number | null {
  if (!spotResponse) return null;
  const upper = symbol.toUpperCase();

  if (spotResponse.spots[upper] != null) return spotResponse.spots[upper];
  if (spotResponse.derived[upper] != null) return spotResponse.derived[upper];

  return null;
}
