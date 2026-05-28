// Simplified Day Trading Types
// Clean types for walls, GEX regime, and day trading levels

// ============================================================================
// SIMPLIFIED TYPES
// ============================================================================

/**
 * Simplified wall — a strike with significant put or call interest.
 */
export interface Wall {
  strike: number;
  type: 'put_wall' | 'call_wall';
  score: number;           // 0-100
  totalOI: number;
  totalVolume: number;
  callOI: number;
  callVolume: number;
  putOI: number;
  putVolume: number;
  netGEX: number;
  distance: number;        // % from spot
  nearestExpiry: string;
}

/**
 * GEX regime — overall market gamma environment.
 */
export interface GexRegime {
  regime: 'positive' | 'negative' | 'neutral';
  label: string;           // "Low Volatility" / "High Volatility" / "Neutral"
  netGEX: number;          // total net GEX
  flipPoint: number | null; // null if can't be reliably computed
}

/**
 * Day trading level — what the UI displays.
 */
export interface DayTradingLevel {
  strike: number;
  type: 'support' | 'resistance';
  strength: number;        // 0-100 score
  totalOI: number;
  totalVolume: number;
  distance: number;        // % from spot
  label: string;           // e.g. "Put Wall", "Call Wall"
}

/**
 * Display data for the UI.
 */
export interface DayTradingData {
  symbol: string;
  spot: number;
  timestamp: string;
  gexRegime: GexRegime;
  resistance: DayTradingLevel[];  // above spot, sorted by proximity
  support: DayTradingLevel[];     // below spot, sorted by proximity
  gexStrikeData: GexStrikeData[]; // per-strike GEX for chart rendering
  /** @deprecated Use timestamp instead. Kept for backward compat. */
  lastUpdated?: string;
}

/**
 * Per-strike GEX data for chart rendering.
 */
export interface GexStrikeData {
  strike: number;
  netGEX: number;
  callGEX: number;
  putGEX: number;
  callOI: number;
  putOI: number;
  callVolume: number;
  putVolume: number;
}

/**
 * Expiry filter for client-side filtering.
 */
export type ExpiryFilter = '0dte' | '1-7dte' | '8-30dte' | '30+dte' | 'all';

// ============================================================================
// DEPRECATED TYPES — kept for UI component backward compatibility
// Will be removed in Phase 3 when UI components are updated
// ============================================================================

/** @deprecated Use Wall instead */
export interface WallLevel {
  strike: number;
  totalOI: number;
  totalVolume: number;
  score: number;
  expirations: ExpirationDetail[];
  type: 'put' | 'call' | 'confluence';
  putOI: number;
  putVolume: number;
  callOI: number;
  callVolume: number;
  callGEX: number;
  putGEX: number;
  netGEX: number;
  totalInterest?: number;
  confluenceRatio?: number;
}

/** @deprecated Will be removed in Phase 3 */
export interface ExpirationDetail {
  expirationDate: string;
  daysToExpiry: number;
  oi: number;
  volume: number;
  weight: number;
  putOI?: number;
  putVolume?: number;
  callOI?: number;
  callVolume?: number;
}

/** @deprecated Will be removed in Phase 3 */
export interface ConfluenceLevel {
  strike: number;
  putOI: number;
  callOI: number;
  putVolume: number;
  callVolume: number;
  totalInterest: number;
  balanceRatio: number;
  confluenceScore: number;
  distanceFromSpot: number;
  expirations: ExpirationDetail[];
}

/** @deprecated Will be removed in Phase 3 */
export type KeyLevelType = 'put_wall' | 'call_wall' | 'confluence';

/** @deprecated Will be removed in Phase 3 */
export interface KeyLevel {
  type: KeyLevelType;
  strike: number;
  score: number;
  distanceFromSpot: number;
  label: string;
  details: WallLevel | ConfluenceLevel;
}

/** @deprecated Will be removed in Phase 3 */
export interface ChartData {
  strikes: GexStrikeData[];
  spotPrice: number;
  gexFlipPoint: number;
  totalNetGEX: number;
  putWalls: WallLevel[];
  callWalls: WallLevel[];
  confluenceLevels: ConfluenceLevel[];
  keyLevels: KeyLevel[];
}

/** @deprecated Use DayTradingData instead */
export interface OptionsData {
  symbol: string;
  spotPrice: number;
  putWalls: WallLevel[];
  callWalls: WallLevel[];
  confluenceLevels: ConfluenceLevel[];
  keyLevels: KeyLevel[];
  totalNetGEX: number;
  gexFlipPoint: number;
  allExpirations: string[];
  chartData?: ChartData;
  lastUpdated?: string;
}

/** @deprecated Use ExpiryFilter instead */
export type ExpirationFilterPreset = ExpiryFilter;
