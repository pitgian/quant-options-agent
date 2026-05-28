/**
 * Services Index — Public API
 *
 * Composes all service modules into a single pipeline:
 *   fetch → filter expiries → walls → GEX → DayTradingData
 *
 * @module services/index
 */

import { DayTradingData, ExpiryFilter } from '../types';

// Service imports
import { fetchRawData, getAvailableSymbols, isDataFresh, getDataAgeMinutes, getLastUpdateTime, clearFetchCache } from './fetchService';
import { RawExpiry } from './fetchService';
import { computeGEXPerStrike, computeGexRegime, computeGexStrikeData } from './gexService';
import { computeWalls } from './wallService';
import { buildDayTradingData } from './keyLevelService';

// Re-export types needed by consumers
export type { RawJson, RawSymbolData, RawExpiry, RawOption } from './fetchService';

// ============================================================================
// EXPIRY FILTERING
// ============================================================================

/**
 * Filters raw expiries based on the selected expiry filter preset.
 */
function filterExpiries(expiries: RawExpiry[], filter: ExpiryFilter): RawExpiry[] {
  if (filter === 'all') return expiries;

  const now = Date.now();
  return expiries.filter(expiry => {
    const expiryDate = new Date(expiry.date);
    const dte = Math.ceil((expiryDate.getTime() - now) / (1000 * 60 * 60 * 24));
    if (dte < 0) return false;

    switch (filter) {
      case '0dte': return dte === 0;
      case '1-7dte': return dte >= 1 && dte <= 7;
      case '8-30dte': return dte >= 8 && dte <= 30;
      case '30+dte': return dte > 30;
      default: return true;
    }
  });
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

/**
 * Fetches and computes DayTradingData for a specific symbol.
 *
 * Pipeline:
 *   1. Fetch raw data via fetchService
 *   2. Filter expiries based on ExpiryFilter
 *   3. Compute walls via wallService
 *   4. Compute GEX regime via gexService
 *   5. Build DayTradingData via keyLevelService
 *
 * @param symbol - The symbol to fetch (e.g., 'SPY', 'QQQ')
 * @param expiryFilter - Expiration filter preset (default: 'all')
 * @param forceRefresh - If true, bypasses cache and fetches fresh data
 * @returns Parsed DayTradingData or null if unavailable
 */
export async function fetchOptionsData(
  symbol: string = 'SPY',
  expiryFilter: ExpiryFilter = 'all',
  forceRefresh: boolean = false
): Promise<DayTradingData | null> {
  const raw = await fetchRawData(forceRefresh);
  if (!raw) return null;

  const upperSymbol = symbol.toUpperCase();
  const symbolData = raw.symbols[upperSymbol];

  if (!symbolData) {
    return null;
  }

  if (!symbolData.expiries || symbolData.expiries.length === 0) {
    return null;
  }

  const generatedAt = symbolData.generated || raw.generated;

  // Step 1: Filter expiries
  const filteredExpiries = filterExpiries(symbolData.expiries, expiryFilter);
  if (filteredExpiries.length === 0) return null;

  // Step 2: Compute walls
  const { putWalls, callWalls } = computeWalls(
    filteredExpiries,
    symbolData.spot,
    generatedAt,
    upperSymbol
  );

  // Step 3: Compute GEX
  const gexStrikeMap = computeGEXPerStrike(filteredExpiries, symbolData.spot, generatedAt, upperSymbol);
  const gexRegime = computeGexRegime(gexStrikeMap, symbolData.spot);
  const gexStrikeData = computeGexStrikeData(gexStrikeMap);

  // Step 4: Build DayTradingData
  return buildDayTradingData(
    upperSymbol,
    symbolData.spot,
    generatedAt,
    putWalls,
    callWalls,
    gexRegime,
    gexStrikeData
  );
}

// ============================================================================
// RE-EXPORTS
// ============================================================================

export { getAvailableSymbols, isDataFresh, getDataAgeMinutes, getLastUpdateTime };
export { clearFetchCache as clearCache };
export { computeGEXPerStrike, computeGexRegime, computeGexStrikeData } from './gexService';
export { computeWalls } from './wallService';
export { buildDayTradingData } from './keyLevelService';
