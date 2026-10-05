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
  /** Net GEX at this strike (call GEX − put GEX, aggregated across expiries).
   *  Determines the expected MECHANISM, per dealer-gamma theory and the Sep-2026
   *  empirical check (scratch/validate_levels.py):
   *    netGEX > 0 → dealers LONG gamma → they trade AGAINST the move → the
   *                 level tends to REPEL price ("pin").
   *    netGEX < 0 → dealers SHORT gamma → they hedge WITH the move → the level
   *                 tends to be BROKEN/accelerated through ("trigger").
   *  The Aug-30 out-of-sample check: positive-gamma call peak rejected 80% of
   *  touches vs 42% random; raw-OI put walls were broken MORE often than
   *  random levels (42% vs 63%). Rank pins above raw-OI walls. */
  netGEX?: number;
  gammaSign?: 'pin' | 'trigger';

  // Cross-symbol confluence fields (present when isCrossSymbol is true)
  isCrossSymbol?: boolean;
  /** True when this level coincides with a cross-symbol confluence. Set on BOTH
   *  cross-only levels (isCrossSymbol=true) and regular walls that a cross level
   *  reinforces (isCrossSymbol=false, so the toggle never hides the wall). */
  hasCrossConfluence?: boolean;
  crossScore?: number;          // cross-symbol confluence score (0-100)
  pairedSymbol?: string;        // the other symbol in the pair (e.g. "SPX" when viewing SPY)
  pairedStrike?: number;        // the strike on the paired symbol
  pairedScore?: number;         // the score on the paired symbol side
  pairedWallType?: string;      // wall type on the paired side (e.g. "put")
  pairedOI?: number;            // paired symbol's individual OI
  pairedVol?: number;           // paired symbol's individual volume
  combinedOI?: number;          // combined OI across both symbols
  combinedVol?: number;         // combined volume across both symbols
  combinedActivity?: number;    // combined activity metric
}

/**
 * Display data for the UI.
 */
/** Livello del playbook intraday (derivato dai futures ES/NQ, scala nativa). */
export interface IntradayLevel {
  label: string;
  price: number;
  side: 'above' | 'below' | 'at';
  dist_pct: number;
}

/** Playbook intraday del desk: PDH/PDL, ONH/ONL, VWAP±σ, POC prev/dev, naked. */
export interface IntradayLevels {
  futures_symbol?: string;
  as_of?: string;
  last_price?: number;
  pdh?: number; pdl?: number;
  onh?: number; onl?: number;
  open_rth?: number;
  week_open?: number; pwh?: number; pwl?: number;
  vwap?: number; vwap_sigma?: number;
  vwap_bands?: { s1_up: number; s1_dn: number; s2_up: number; s2_dn: number };
  prev_day_profile?: { poc: number; vah: number; val: number };
  developing_profile?: { poc: number; vah: number; val: number };
  naked_pocs?: Array<{ price: number; session: string }>;
  levels?: IntradayLevel[];
}

export interface DayTradingData {
  symbol: string;
  spot: number;
  timestamp: string;
  /** Playbook intraday del desk (livelli prezzo da ES/NQ, scala nativa). */
  intradayLevels?: IntradayLevels;
  gexRegime: GexRegime;
  resistance: DayTradingLevel[];  // above spot, sorted by proximity
  support: DayTradingLevel[];     // below spot, sorted by proximity
  gexStrikeData: GexStrikeData[]; // per-strike GEX for chart rendering
  /** @deprecated Use timestamp instead. Kept for backward compat. */
  lastUpdated?: string;
  /** Cross-symbol confluence data (pre-computed by Python backend) */
  crossSymbolConfluence?: CrossSymbolConfluence;
  /** Futures volume profile mapping strike price to total traded volume */
  futuresVolumeProfile?: Record<string, number>;
  /** Futures volume profiles by timeframe preset (e.g. '2d', '7d', '30d', '90d') */
  futuresVolumeProfiles?: Record<string, Record<string, number>>;
  volatilitySkew25d?: number;
  putCallOiRatio?: number;
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
// CROSS-SYMBOL CONFLUENCE TYPES
// ============================================================================

/** Cross-symbol confluence level from one side (ETF or Index) */
export interface CrossSymbolSide {
  symbol: string;
  strike: number;
  distance_pct: number;
  total_oi: number;
  total_vol: number;
  score: number;
  wall_type: string;
}

/** A matched cross-symbol confluence level */
export interface CrossSymbolLevel {
  type: 'support' | 'resistance';
  cross_score: number;
  etf: CrossSymbolSide;
  index: CrossSymbolSide;
  combined_oi: number;
  combined_vol: number;
  combined_activity: number;
}

/** Data for one pair (e.g., SPY_SPX) */
export interface CrossSymbolPair {
  pair: string;
  etf_symbol: string;
  index_symbol: string;
  ratio: number;
  levels: CrossSymbolLevel[];
}

/** All cross-symbol confluence data */
export interface CrossSymbolConfluence {
  SPY_SPX?: CrossSymbolPair;
  QQQ_NDX?: CrossSymbolPair;
}

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

// ============================================================================
// KRONOS FORECAST TYPES
// ============================================================================

/**
 * Coerenza direzionale tra i due orizzonti (4h vs 1d).
 *
 * Uno score 0-100 che quantifica quanto i due forecast concordano in direzione
 * E in entità. Serve a rendere esplicito quando un bias è solido (entrambi gli
 * orizzonti dicono la stessa cosa) vs quando è rumore (i due orizzonti si
 * contraddicono). Generato lato Python in run_kronos.py; opzionale per backward
 * compat con snapshot JSON più vecchi che non lo contengono.
 *
 *   score: 0-100. ≥70 CONCORDI, 40-69 MISTO, <40 DISCORDI.
 *   agree: true se 4h e 1d puntano nella stessa direzione (entrambi >0 o <0).
 *   strength_{4h,1d}_pct: variazione % attesa (close finale vs last_price) per
 *     ciascun orizzonte, con segno.
 */

