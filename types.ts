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

  // Cross-symbol confluence fields (present when isCrossSymbol is true)
  isCrossSymbol?: boolean;
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

export interface KronosPredictedCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KronosAdapterStatus {
  applied: boolean;
  pred_len: number;
  residual_norm: number | null;
  supported: boolean;
  reason: string | null;
  covariates: { skew: number; pcr: number; gex_b: number } | null;
}

export interface KronosResolutionForecast {
  last_price: number;
  expected_high: number;
  expected_low: number;
  predicted_volatility_pct: number;
  candles: KronosPredictedCandle[];
  adapter_status?: KronosAdapterStatus;
}

export interface KronosForecastItem {
  ticker: string;
  last_price_5m: number;
  last_price_15m: number;
  last_price_1h: number;
  last_price_4h: number;
  last_price_1d: number;
  trend_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength_pct: number;
  forecast_5m: KronosResolutionForecast;
  forecast_15m: KronosResolutionForecast;
  forecast_1h: KronosResolutionForecast;
  forecast_4h: KronosResolutionForecast;
  forecast_1d: KronosResolutionForecast;
  error?: string;
  
  // Optional legacy properties for safety
  last_price?: number;
  expected_high?: number;
  expected_low?: number;
  predicted_volatility_pct?: number;
  candles?: KronosPredictedCandle[];
}

export interface KronosForecast {
  updated_at: string;
  SP500_bias: KronosForecastItem;
  NASDAQ_bias: KronosForecastItem;
}

// ============================================================================
// COVARIATE ADAPTER — training stats & health
// ============================================================================

export interface AdapterLossPoint {
  epoch: number;
  train_loss: number;
  val_loss: number;
}

export interface AdapterHorizonMetric {
  pred_len: number;
  val_samples: number;
  /** Residual error AFTER adapter correction (normalized space). Lower = better. */
  val_mse: number;
  /** MSE of Kronos baseline ALONE = variance of the target residual. Reference for improvement_pct. */
  baseline_val_mse?: number;
  /** Share of baseline error the adapter explains: (baseline - adapter) / baseline * 100. 100% = perfect, 0% = no help, <0% = harmful. */
  improvement_pct?: number;
}

export interface AdapterTrainingStats {
  version: number;
  trained_at: string;
  symbols: string[];
  history_records?: Record<string, number>;
  real_samples_total: number;
  per_horizon_real_samples?: Record<string, number>;
  min_real_samples_required: number;
  saved: boolean;
  reason?: string | null;
  epochs?: number;
  device?: string;
  train_samples?: number;
  val_samples?: number;
  final_train_loss?: number;
  final_val_loss?: number;
  /** MSE of Kronos baseline alone on the full validation set (normalized). */
  final_baseline_val_loss?: number;
  /** Overall share of baseline error the adapter explains on val set (R²-like, %). */
  final_improvement_pct?: number;
  cov_stats?: {
    skew: { mean: number; std: number };
    pcr: { mean: number; std: number };
    gex: { mean: number; std: number };
  };
  horizons?: Record<string, AdapterHorizonMetric>;
  loss_history?: AdapterLossPoint[];
}


