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
  // 80% Monte Carlo confidence band on the per-candle OHLC (derived from the
  // stochastic Kronos samples). Optional for backward-compat with older
  // snapshots that only carried the central trajectory.
  close_p10?: number;
  close_p90?: number;
  high_p10?: number;
  high_p90?: number;
  low_p10?: number;
  low_p90?: number;
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
  // Outer (p90/p10) and central (p50) horizon range, in real price space.
  // Optional for backward-compat with snapshots generated before the MC band.
  expected_high_p50?: number;
  expected_low_p50?: number;
  /**
   * Self-improving bias-correction diagnostic. Produced by scripts/bias_corrector.py:
   * learns the model's systematic directional bias from the verification track
   * record (last 14d) and tilts the forecast to compensate. Optional — absent
   * on snapshots produced before the bias-correction layer was deployed.
   *
   *   applied:        whether a correction was actually applied this run.
   *   correction_pct: the % tilt applied at the LAST candle (full time-weight).
   *                   Positive = tilted up (model was under-predicting).
   *   holdout_delta_pp: directional-accuracy gain on the 30% holdout, in pp.
   *                   Negative or near-zero with applied=false means the
   *                   anti-worsening gate rejected the correction.
   *   n_samples:      scored records used for the estimate.
   *   reason:         why applied / why not (human-readable).
   */
  bias_correction?: KronosBiasCorrection;
}

export interface KronosBiasCorrection {
  applied: boolean;
  method: 'offset_median' | 'linreg_context' | 'none' | string;
  correction_pct: number;
  n_samples: number;
  n_train?: number;
  holdout_n?: number;
  holdout_delta_pp?: number;
  window_days?: number;
  reason: string;
}

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
export interface KronosCoherence {
  score: number;
  agree: boolean;
  label: 'CONCORDI' | 'MISTO' | 'DISCORDI';
  strength_4h_pct: number;
  strength_1d_pct: number;
}

export interface KronosForecastItem {
  ticker: string;
  last_price_4h: number;
  last_price_1d: number;
  trend_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength_pct: number;
  coherence?: KronosCoherence;
  // Legacy resolutions (5m/15m/1h) are no longer generated; kept optional
  // for backward-compatibility with older kronos_forecast.json snapshots.
  forecast_5m?: KronosResolutionForecast;
  forecast_15m?: KronosResolutionForecast;
  forecast_1h?: KronosResolutionForecast;
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
// FORECAST VERIFICATION — track record of past Kronos forecasts vs reality
// ============================================================================

/**
 * A single recorded forecast snapshot, written by scripts/forecast_tracker.py
 * (data/kronos_forecast_history.json) on every Kronos run.
 *
 * A snapshot starts "pending" (realized_* fields null) and becomes "scored"
 * once its horizon (target_at) has matured and we could fetch the realized
 * ETF close. NEUTRAL/FLAT forecasts have direction_correct=null because they
 * declared no directional view — they are excluded from directional accuracy.
 */
export interface ForecastSnapshot {
  /** Schema version (mirrors `v` in the Python record). */
  v?: number;
  /** When the forecast was issued (ISO UTC, = forecast.updated_at). */
  issued_at: string;
  /** 'SPY' | 'QQQ'. */
  symbol: string;
  /** '4h' | '1d'. */
  horizon: '4h' | '1d';
  /** Timestamp of the final predicted candle = verification maturity date. */
  target_at: string;
  /** Starting price (the forecast's own last_price). */
  anchor_price: number;
  /** Predicted close of the final candle (what the model bet on). */
  predicted_target: number;
  /** Predicted range high/low (for range-coverage scoring). */
  predicted_high: number;
  predicted_low: number;
  /** 80% Monte Carlo band on the final candle's close (v2+ snapshots; absent on v1). */
  band_p10?: number | null;
  band_p90?: number | null;
  /** The forecast's own directional stance ('UP' | 'DOWN' | 'FLAT'). */
  predicted_direction: 'UP' | 'DOWN' | 'FLAT';
  /** The live trend_bias captured at issue time ('BULLISH' | 'BEARISH' | 'NEUTRAL'). */
  trend_bias?: string;
  // --- scored fields (null until target_at has matured) ---
  realized_price: number | null;
  /** True if sign(realized − anchor) == sign(predicted_target − anchor). Null for FLAT. */
  direction_correct: boolean | null;
  /** |predicted_target − realized| / realized × 100. */
  abs_pct_error: number | null;
  /** True if predicted_low ≤ realized ≤ predicted_high. */
  range_hit: boolean | null;
  /** True if band_p10 ≤ realized ≤ band_p90. Null for snapshots without a band. */
  band_hit?: boolean | null;
  scored_at: string | null;
}

/** Shape of data/kronos_forecast_history.json. */
export interface ForecastTrackRecord {
  snapshots: ForecastSnapshot[];
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

/**
 * Longitudinal summary of a SINGLE training run, appended every execution of
 * train_adapter.py into `loss_history_runs`. Unlike `AdapterLossPoint` (which
 * holds per-epoch values regenerated — with stochastic Kronos baselines — on
 * every run), this is a stable, comparable history across runs/days.
 */
export interface AdapterLossRun {
  /** ISO timestamp of the run. */
  ts: string;
  /** Whether a checkpoint was actually saved (false = guard blocked it, too few real samples). */
  trained: boolean;
  /** Real samples accumulated at this run (may fluctuate: see subsampling + deadline notes). */
  real_samples: number;
  per_horizon_real_samples?: Record<string, number>;
  train_samples?: number;
  val_samples?: number;
  final_train_loss?: number;
  final_val_loss?: number;
  best_val_loss?: number;
  best_epoch?: number;
  final_improvement_pct?: number;
  final_baseline_val_loss?: number;
  /** Number of epochs actually executed (0 when the guard blocked training). */
  epochs_run?: number;
  stopped_early?: boolean;
  validated_pred_lens?: number[];
  /** True when this entry is a DAILY AGGREGATE produced by the Python
   *  two-tier retention (loss = mean of the day's trained runs, samples = peak).
   *  Such entries are already one-per-day and must NOT be re-aggregated by the
   *  UI — they plot as a single point like any other run. */
  aggregated?: boolean;
  /** Day string (YYYY-MM-DD) for aggregated entries. */
  day?: string;
  /** How many raw runs were folded into an aggregated day. */
  n_runs?: number;
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
  /** One entry per training run, oldest→newest. Stable longitudinal history for cross-run comparison. */
  loss_history_runs?: AdapterLossRun[];
}


