/**
 * Services Index — Public API
 *
 * Composes all service modules into a single pipeline:
 *   fetch → filter expiries → walls → GEX → DayTradingData
 *
 * @module services/index
 */

import { DayTradingData, ExpiryFilter, CrossSymbolConfluence, CrossSymbolPair, CrossSymbolLevel, CrossSymbolSide } from '../types';

// Service imports
import { fetchRawData, getAvailableSymbols, isDataFresh, getDataAgeMinutes, getLastUpdateTime, clearFetchCache } from './fetchService';
import { RawExpiry, RawCrossSymbolPair, RawCrossSymbolLevel, RawCrossSymbolSide } from './fetchService';
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

  // Step 4: Parse cross-symbol confluence data
  const crossSymbolConfluence = parseCrossSymbolConfluence(raw.cross_symbol_confluence);

  // Step 5: Build DayTradingData
  return buildDayTradingData(
    upperSymbol,
    symbolData.spot,
    generatedAt,
    putWalls,
    callWalls,
    gexRegime,
    gexStrikeData,
    crossSymbolConfluence
  );
}

// ============================================================================
// CROSS-SYMBOL CONFLUENCE PARSING
// ============================================================================

/**
 * Transforms raw cross-symbol confluence JSON into typed CrossSymbolConfluence.
 * Returns undefined if the data is missing or incomplete.
 */
function parseCrossSymbolConfluence(
  raw: Record<string, RawCrossSymbolPair> | undefined
): CrossSymbolConfluence | undefined {
  if (!raw) return undefined;

  const parseSide = (s: RawCrossSymbolSide): CrossSymbolSide => ({
    symbol: s.symbol,
    strike: s.strike,
    distance_pct: s.distance_pct,
    total_oi: s.total_oi,
    total_vol: s.total_vol,
    score: s.score,
    wall_type: s.wall_type,
  });

  const parseLevel = (l: RawCrossSymbolLevel): CrossSymbolLevel => ({
    type: l.type as 'support' | 'resistance',
    cross_score: l.cross_score,
    etf: parseSide(l.etf),
    index: parseSide(l.index),
    combined_oi: l.combined_oi,
    combined_vol: l.combined_vol,
    combined_activity: l.combined_activity,
  });

  const parsePair = (p: RawCrossSymbolPair): CrossSymbolPair => {
    const levels = p.levels.map(parseLevel);

    // Validate symbol fields: filter out levels where etf/index sides are swapped
    const validLevels = levels.filter(level => {
      const etfMatch = level.etf.symbol.toUpperCase() === p.etf_symbol.toUpperCase();
      const indexMatch = level.index.symbol.toUpperCase() === p.index_symbol.toUpperCase();
      if (!etfMatch || !indexMatch) {
        console.warn(
          `[parseCrossSymbolConfluence] Symbol mismatch in pair ${p.pair}: ` +
          `expected etf=${p.etf_symbol}/index=${p.index_symbol}, ` +
          `got etf=${level.etf.symbol}/index=${level.index.symbol}. Skipping level.`
        );
        return false;
      }
      return true;
    });

    return {
      pair: p.pair,
      etf_symbol: p.etf_symbol,
      index_symbol: p.index_symbol,
      ratio: p.ratio,
      levels: validLevels,
    };
  };

  const result: Partial<CrossSymbolConfluence> = {};

  if (raw.SPY_SPX) result.SPY_SPX = parsePair(raw.SPY_SPX);
  if (raw.QQQ_NDX) result.QQQ_NDX = parsePair(raw.QQQ_NDX);

  // Only return if at least one pair exists
  if (!result.SPY_SPX && !result.QQQ_NDX) return undefined;

  return result as CrossSymbolConfluence;
}

// ============================================================================
// RE-EXPORTS
// ============================================================================

export { getAvailableSymbols, isDataFresh, getDataAgeMinutes, getLastUpdateTime };
export { clearFetchCache as clearCache };
export { computeGEXPerStrike, computeGexRegime, computeGexStrikeData } from './gexService';
export { computeWalls } from './wallService';
export { buildDayTradingData } from './keyLevelService';
