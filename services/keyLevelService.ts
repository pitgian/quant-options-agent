/**
 * Key Level Service
 *
 * Converts walls and GEX regime into DayTradingData for the UI.
 * Builds support/resistance levels sorted by proximity to spot.
 *
 * @module services/keyLevelService
 */

import { Wall, GexRegime, DayTradingLevel, DayTradingData, GexStrikeData } from '../types';

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
  gexStrikeData: GexStrikeData[]
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

  return {
    symbol,
    spot,
    timestamp,
    lastUpdated: timestamp, // backward compat alias
    gexRegime,
    resistance,
    support,
    gexStrikeData,
  };
}
