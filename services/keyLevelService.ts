/**
 * Key Level Service
 *
 * Converts walls and GEX regime into DayTradingData for the UI.
 * Builds support/resistance levels sorted by proximity to spot.
 *
 * @module services/keyLevelService
 */

import { Wall, GexRegime, DayTradingLevel, DayTradingData, GexStrikeData, CrossSymbolConfluence, CrossSymbolLevel } from '../types';

// ============================================================================
// DAY TRADING DATA BUILDER
// ============================================================================

/**
 * Builds DayTradingData from computed walls and GEX regime.
 *
 * Converts put walls → support levels, call walls → resistance levels.
 * Sorts by proximity to spot and limits to 7 per side.
 */
export function buildDayTradingData(
  symbol: string,
  spot: number,
  timestamp: string,
  putWalls: Wall[],
  callWalls: Wall[],
  gexRegime: GexRegime,
  gexStrikeData: GexStrikeData[],
  crossSymbolConfluence?: CrossSymbolConfluence
): DayTradingData {
  // Convert put walls to support levels (below spot)
  const support: DayTradingLevel[] = putWalls
    .filter(w => w.strike <= spot)
    .map(w => ({
      strike: w.strike,
      type: 'support' as const,
      strength: w.score,
      totalOI: w.totalOI,
      totalVolume: w.totalVolume,
      distance: w.distance,
      label: 'Put Wall',
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7);

  // Convert call walls to resistance levels (above spot)
  const resistance: DayTradingLevel[] = callWalls
    .filter(w => w.strike >= spot)
    .map(w => ({
      strike: w.strike,
      type: 'resistance' as const,
      strength: w.score,
      totalOI: w.totalOI,
      totalVolume: w.totalVolume,
      distance: w.distance,
      label: 'Call Wall',
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7);

  // Merge cross-symbol confluence levels
  const crossLevels = extractCrossSymbolLevels(symbol, crossSymbolConfluence);
  const crossSupport = crossLevels.filter(l => l.type === 'support');
  const crossResistance = crossLevels.filter(l => l.type === 'resistance');

  // Insert cross-symbol levels into the appropriate arrays
  const mergedSupport = mergeLevels(support, crossSupport, spot);
  const mergedResistance = mergeLevels(resistance, crossResistance, spot);

  return {
    symbol,
    spot,
    timestamp,
    lastUpdated: timestamp, // backward compat alias
    gexRegime,
    resistance: mergedResistance,
    support: mergedSupport,
    gexStrikeData,
    crossSymbolConfluence,
  };
}

// ============================================================================
// CROSS-SYMBOL LEVEL EXTRACTION
// ============================================================================

/**
 * Mapping from displayed symbol → pair key and which side to use as primary.
 */
const SYMBOL_PAIR_MAP: Record<string, { pairKey: string; side: 'etf' | 'index' }> = {
  SPY: { pairKey: 'SPY_SPX', side: 'etf' },
  QQQ: { pairKey: 'QQQ_NDX', side: 'etf' },
  SPX: { pairKey: 'SPY_SPX', side: 'index' },
  NDX: { pairKey: 'QQQ_NDX', side: 'index' },
};

/**
 * Extracts cross-symbol confluence levels relevant to the displayed symbol.
 *
 * For ETF symbols (SPY, QQQ): uses the etf side as primary, index as paired.
 * For index symbols (SPX, NDX): uses the index side as primary, etf as paired.
 */
function extractCrossSymbolLevels(
  symbol: string,
  confluence?: CrossSymbolConfluence
): DayTradingLevel[] {
  if (!confluence) return [];

  const mapping = SYMBOL_PAIR_MAP[symbol.toUpperCase()];
  if (!mapping) return [];

  const pair = confluence[mapping.pairKey as keyof CrossSymbolConfluence];
  if (!pair) return [];

  const upperSymbol = symbol.toUpperCase();

  return pair.levels
    .map((level: CrossSymbolLevel): DayTradingLevel | null => {
      // Dynamically determine which side is primary by checking the symbol field
      const etfIsPrimary = level.etf.symbol.toUpperCase() === upperSymbol;
      const indexIsPrimary = level.index.symbol.toUpperCase() === upperSymbol;

      // Skip levels where neither side matches the requested symbol
      if (!etfIsPrimary && !indexIsPrimary) return null;

      const primary = etfIsPrimary ? level.etf : level.index;
      const paired = etfIsPrimary ? level.index : level.etf;

      return {
        strike: primary.strike,
        type: level.type,
        strength: level.cross_score,
        totalOI: primary.total_oi,
        totalVolume: primary.total_vol,
        distance: primary.distance_pct,
        label: `Cross-Symbol ${level.type === 'support' ? 'Support' : 'Resistance'}`,
        isCrossSymbol: true,
        crossScore: level.cross_score,
        pairedSymbol: paired.symbol,
        pairedStrike: paired.strike,
        pairedScore: paired.score,
        pairedWallType: paired.wall_type,
        combinedOI: level.combined_oi,
        combinedVol: level.combined_vol,
        combinedActivity: level.combined_activity,
      };
    })
    .filter((level): level is DayTradingLevel => level !== null);
}

/**
 * Merges regular levels with cross-symbol levels, keeping them sorted by
 * proximity to spot (absolute distance). Regular levels keep their original
 * position; cross-symbol levels are inserted at the correct sorted position.
 */
function mergeLevels(
  regular: DayTradingLevel[],
  cross: DayTradingLevel[],
  spot: number
): DayTradingLevel[] {
  if (cross.length === 0) return regular;

  // Filter out cross-symbol levels whose strikes are outside a reasonable range
  const MAX_DISTANCE_PCT = 20;
  const validCross = cross.filter(l => {
    if (!l.isCrossSymbol) return true; // regular levels don't need this check
    const distPct = Math.abs(l.strike - spot) / spot * 100;
    return distPct <= MAX_DISTANCE_PCT;
  });

  // Combine and sort by absolute distance from spot
  const merged = [...regular, ...validCross].sort(
    (a, b) => Math.abs(a.distance) - Math.abs(b.distance)
  );

  // Allow up to 10 levels per side (7 regular + 3 cross-symbol buffer)
  return merged.slice(0, 10);
}
