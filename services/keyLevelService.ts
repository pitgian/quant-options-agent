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

  // Identify the absolute strongest (global) Put Wall and Call Wall strikes
  const primaryPutWallStrike = putWalls.length > 0 ? putWalls[0].strike : null;
  const primaryCallWallStrike = callWalls.length > 0 ? callWalls[0].strike : null;

  // Convert put walls to support levels (below spot)
  const support: DayTradingLevel[] = putWalls
    .filter(w => w.strike <= spot)
    .filter(w => w.strike >= spot * 0.3)    // Reject strikes below 30% of spot
    .filter(w => w.distance <= DAY_TRADING_MAX_DISTANCE_PCT)
    .map(w => {
      const isGammaPeak = w.strike === maxNegativeGexStrike;
      const isPrimaryWall = w.strike === primaryPutWallStrike;
      return {
        strike: w.strike,
        type: 'support' as const,
        strength: w.score,
        totalOI: w.totalOI,
        totalVolume: w.totalVolume,
        distance: w.distance,
        label: isGammaPeak ? 'Major Gamma Wall' : (isPrimaryWall ? 'Put Wall' : 'Supporto'),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  // Convert call walls to resistance levels (above spot)
  const resistance: DayTradingLevel[] = callWalls
    .filter(w => w.strike >= spot)
    .filter(w => w.strike <= spot * 3.0)    // Reject strikes above 300% of spot
    .filter(w => w.distance <= DAY_TRADING_MAX_DISTANCE_PCT)
    .map(w => {
      const isGammaPeak = w.strike === maxPositiveGexStrike;
      const isPrimaryWall = w.strike === primaryCallWallStrike;
      return {
        strike: w.strike,
        type: 'resistance' as const,
        strength: w.score,
        totalOI: w.totalOI,
        totalVolume: w.totalVolume,
        distance: w.distance,
        label: isGammaPeak ? 'Major Gamma Wall' : (isPrimaryWall ? 'Call Wall' : 'Resistenza'),
      };
    })
    .sort((a, b) => a.distance - b.distance);

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

  // Filter out clustered levels (minimum 0.4% distance from each other)
  const spacedSupport = filterSpacedLevels(support, spot, 0.4);
  const spacedResistance = filterSpacedLevels(resistance, spot, 0.4);

  // Keep top 5 closest to spot
  const finalSupport = spacedSupport
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
    .slice(0, 5);

  const finalResistance = spacedResistance
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
    .slice(0, 5);

  return {
    symbol,
    spot,
    timestamp,
    lastUpdated: timestamp, // backward compat alias
    gexRegime,
    resistance: finalResistance,
    support: finalSupport,
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
        label: (primary.wall_type.includes('major') || paired.wall_type.includes('major'))
          ? (level.type === 'support' ? 'Major Put Wall' : 'Major Call Wall')
          : (level.type === 'support' ? 'Put Wall' : 'Call Wall'),
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

  // Create a map of strike -> level from regular
  const mergedMap = new Map<number, DayTradingLevel>();
  regular.forEach(l => {
    mergedMap.set(l.strike, { ...l });
  });

  // Merge the cross-symbol levels
  validCross.forEach(cl => {
    const existing = mergedMap.get(cl.strike);
    if (existing) {
      // Merge! Keep the descriptive regular level's label (like 'Put Wall' or 'GEX Flip'), but mark it as cross symbol
      existing.isCrossSymbol = true;
      existing.strength = Math.max(existing.strength, cl.strength);
      existing.pairedSymbol = cl.pairedSymbol;
      existing.pairedStrike = cl.pairedStrike;
      existing.pairedScore = cl.pairedScore;
      existing.pairedWallType = cl.pairedWallType;
      existing.pairedOI = cl.pairedOI;
      existing.pairedVol = cl.pairedVol;
      existing.combinedOI = cl.combinedOI;
      existing.combinedVol = cl.combinedVol;
      existing.combinedActivity = cl.combinedActivity;
    } else {
      // Just add it
      mergedMap.set(cl.strike, cl);
    }
  });

  // Sort by absolute distance from spot
  const merged = Array.from(mergedMap.values()).sort(
    (a, b) => Math.abs(a.distance) - Math.abs(b.distance)
  );

  // Allow up to 10 levels per side (7 regular + 3 cross-symbol buffer)
  return merged.slice(0, 10);
}

/**
 * Filters out key levels that are too close to each other (clustering),
 * prioritizing the levels with higher strength/score.
 *
 * Enforces a minimum distance of `minDistancePct` (e.g. 0.4% of spot).
 */
function filterSpacedLevels(
  levels: DayTradingLevel[],
  spot: number,
  minDistancePct: number
): DayTradingLevel[] {
  if (levels.length <= 1) return levels;

  const minDistance = spot * (minDistancePct / 100);

  // Sort by strength descending so we prioritize keeping stronger levels
  const sortedByStrength = [...levels].sort((a, b) => b.strength - a.strength);

  const selected: DayTradingLevel[] = [];

  for (const level of sortedByStrength) {
    // Check if too close to any already selected level
    const isTooClose = selected.some(s => Math.abs(s.strike - level.strike) < minDistance);
    if (!isTooClose) {
      selected.push(level);
    }
  }

  return selected;
}
