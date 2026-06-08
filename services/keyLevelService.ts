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
// CONSTANTS
// ============================================================================

const DAY_TRADING_MAX_DISTANCE_PCT = 5; // Only show levels within 5% of spot for day trading
const MIN_CROSS_SYMBOL_SCORE = 60;      // Minimum cross_score for meaningful confluence

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
  // Find GEX peaks above/below spot to identify Major Gamma Walls
  let maxPositiveGexStrike = -1;
  let maxPositiveGex = 0;
  let maxNegativeGexStrike = -1;
  let minNegativeGex = 0;

  for (const strikeData of gexStrikeData) {
    if (strikeData.netGEX > maxPositiveGex && strikeData.strike >= spot) {
      maxPositiveGex = strikeData.netGEX;
      maxPositiveGexStrike = strikeData.strike;
    }
    if (strikeData.netGEX < minNegativeGex && strikeData.strike <= spot) {
      minNegativeGex = strikeData.netGEX;
      maxNegativeGexStrike = strikeData.strike;
    }
  }

  // Convert put walls to support levels (below spot)
  const support: DayTradingLevel[] = putWalls
    .filter(w => w.strike <= spot)
    .filter(w => w.strike >= spot * 0.3)    // Reject strikes below 30% of spot
    .filter(w => w.distance <= DAY_TRADING_MAX_DISTANCE_PCT)
    .map(w => {
      const isGammaPeak = w.strike === maxNegativeGexStrike;
      return {
        strike: w.strike,
        type: 'support' as const,
        strength: w.score,
        totalOI: w.totalOI,
        totalVolume: w.totalVolume,
        distance: w.distance,
        label: isGammaPeak ? 'Major Gamma Wall' : 'Put Wall',
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7);

  // Convert call walls to resistance levels (above spot)
  const resistance: DayTradingLevel[] = callWalls
    .filter(w => w.strike >= spot)
    .filter(w => w.strike <= spot * 3.0)    // Reject strikes above 300% of spot
    .filter(w => w.distance <= DAY_TRADING_MAX_DISTANCE_PCT)
    .map(w => {
      const isGammaPeak = w.strike === maxPositiveGexStrike;
      return {
        strike: w.strike,
        type: 'resistance' as const,
        strength: w.score,
        totalOI: w.totalOI,
        totalVolume: w.totalVolume,
        distance: w.distance,
        label: isGammaPeak ? 'Major Gamma Wall' : 'Call Wall',
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7);

  // Create Gamma Flip Pivot level if it is within range
  const flipLevel: DayTradingLevel | null = gexRegime.flipPoint !== null ? {
    strike: gexRegime.flipPoint,
    type: gexRegime.flipPoint <= spot ? 'support' : 'resistance',
    strength: 95, // Gamma Flip is highly significant
    totalOI: 0,
    totalVolume: 0,
    distance: spot > 0 ? (Math.abs(gexRegime.flipPoint - spot) / spot) * 100 : 0,
    label: 'Gamma Flip (Pivot)',
  } : null;

  // Insert Gamma Flip level into the appropriate array
  if (flipLevel && flipLevel.distance <= DAY_TRADING_MAX_DISTANCE_PCT) {
    if (flipLevel.type === 'support') {
      const existingIdx = support.findIndex(s => s.strike === flipLevel.strike);
      if (existingIdx === -1) {
        support.push(flipLevel);
        support.sort((a, b) => a.distance - b.distance);
      } else {
        support[existingIdx].label = `${support[existingIdx].label} / GEX Flip`;
        support[existingIdx].strength = Math.max(support[existingIdx].strength, 95);
      }
    } else {
      const existingIdx = resistance.findIndex(r => r.strike === flipLevel.strike);
      if (existingIdx === -1) {
        resistance.push(flipLevel);
        resistance.sort((a, b) => a.distance - b.distance);
      } else {
        resistance[existingIdx].label = `${resistance[existingIdx].label} / GEX Flip`;
        resistance[existingIdx].strength = Math.max(resistance[existingIdx].strength, 95);
      }
    }
  }

  // Merge cross-symbol confluence levels
  const crossLevels = extractCrossSymbolLevels(symbol, crossSymbolConfluence, spot);
  // Re-classify based on current spot position (not stale Python backend classification)
  const crossSupport = crossLevels.filter(l => l.strike <= spot);
  const crossResistance = crossLevels.filter(l => l.strike > spot);

  // Insert cross-symbol levels into the appropriate arrays
  const mergedSupport = mergeLevels(support, crossSupport, spot, 'support');
  const mergedResistance = mergeLevels(resistance, crossResistance, spot, 'resistance');

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
  confluence: CrossSymbolConfluence | undefined,
  spot: number
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

      // SANITY CHECK: primary strike must be within reasonable range of spot
      const strikeToSpotRatio = primary.strike / spot;
      if (strikeToSpotRatio < 0.3 || strikeToSpotRatio > 3.0) return null;

      // Only include cross-symbol levels with meaningful confluence score
      if (level.cross_score < MIN_CROSS_SYMBOL_SCORE) return null;

      return {
        strike: primary.strike,
        type: level.type,
        strength: Math.min(100, Math.round(level.cross_score)),
        totalOI: primary.total_oi,
        totalVolume: primary.total_vol,
        distance: primary.distance_pct,
        label: `Cross-Symbol ${level.type === 'support' ? 'Support' : 'Resistance'}`,
        isCrossSymbol: true,
        crossScore: Math.min(100, Math.round(level.cross_score)),
        pairedSymbol: paired.symbol,
        pairedStrike: paired.strike,
        pairedScore: paired.score,
        pairedWallType: paired.wall_type,
        pairedOI: paired.total_oi,
        pairedVol: paired.total_vol,
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
  spot: number,
  direction: 'support' | 'resistance'
): DayTradingLevel[] {
  if (cross.length === 0) return regular;

  // Filter out cross-symbol levels whose strikes are outside a reasonable range
  const MAX_DISTANCE_PCT = 5; // was 20, now consistent with day trading focus
  const validCross = cross.filter(l => {
    if (!l.isCrossSymbol) return true; // regular levels don't need this check
    const distPct = Math.abs(l.strike - spot) / spot * 100;
    if (distPct > MAX_DISTANCE_PCT) return false;
    // DIRECTIONAL CHECK: support must be below spot, resistance above
    if (direction === 'support' && l.strike > spot) return false;
    if (direction === 'resistance' && l.strike < spot) return false;
    return true;
  });

  // Deduplicate: remove regular levels that overlap with cross-symbol levels
  const crossStrikes = new Set(validCross.map(l => l.strike));
  const dedupedRegular = regular.filter(l => !crossStrikes.has(l.strike));

  // Combine and sort by absolute distance from spot
  const merged = [...dedupedRegular, ...validCross].sort(
    (a, b) => Math.abs(a.distance) - Math.abs(b.distance)
  );

  // Allow up to 10 levels per side (7 regular + 3 cross-symbol buffer)
  return merged.slice(0, 10);
}
