/**
 * Forecast Score Service
 *
 * Fetches the Kronos forecast-verification history (data/kronos_forecast_history.json
 * on the `data` branch) and computes the track-record metrics surfaced in the
 * "Track Record" tab: directional accuracy, MAPE, range coverage, and a rolling
 * accuracy time series.
 *
 * The history is produced by scripts/forecast_tracker.py (one snapshot per
 * forecast, scored against realized prices once the horizon matures).
 *
 * @module services/forecastScoreService
 */

import type { ForecastSnapshot, ForecastTrackRecord } from '../types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TRACK_RECORD_REPO_URL =
  'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data/kronos_forecast_history.json';
const TRACK_RECORD_LOCAL_URL = '/data/kronos_forecast_history.json';

export type Horizon = '4h' | '1d';
export type TrackSymbol = 'SPY' | 'QQQ';

export interface MetricSet {
  /** Fraction of directional forecasts that called the right sign, 0–1. */
  directionalAccuracy: number | null;
  /** Sample size backing directionalAccuracy (FLAT/NEUTRAL excluded). */
  directionalN: number;
  /** 95% Wilson confidence interval half-width on directionalAccuracy, 0–1. */
  directionalCi95: number | null;
  /** Mean absolute % error of predicted_target vs realized, in %. */
  mape: number | null;
  mapeN: number;
  /** Std-dev of abs_pct_error samples, in %. */
  mapeStd: number | null;
  /** Fraction of forecasts whose realized close fell inside [pred_low, pred_high]. */
  rangeCoverage: number | null;
  rangeN: number;
  /** Fraction of forecasts whose realized close fell inside [band_p10, band_p90]
   *  (the 80% Monte Carlo band). Nominally ~0.80; systematic under-coverage
   *  means the band is too tight (overconfident). Null until v2 snapshots mature. */
  bandCoverage: number | null;
  bandN: number;
  /** 95% Wilson CI half-width on bandCoverage, 0–1. */
  bandCi95: number | null;
  /** Total snapshots considered (scored only). */
  totalScored: number;
}

export interface GroupKey {
  symbol: TrackSymbol;
  horizon: Horizon;
}

export interface TrackRecordMetrics {
  /** Per (symbol, horizon) breakdown. */
  byGroup: Record<string, MetricSet>;
  /** Aggregate across all selected symbol/horizon. */
  overall: MetricSet;
  /** Rolling directional accuracy, one point per day bucket. */
  rolling: RollingPoint[];
  /** Snapshots not yet matured (target_at in the future, or unscored). */
  pendingCount: number;
  /** Total snapshots in the selected window (scored + pending). */
  totalCount: number;
  /** Earliest/latest issued_at among selected snapshots (ISO), for header range. */
  windowStart: string | null;
  windowEnd: string | null;
}

export interface RollingPoint {
  /** Day bucket key (YYYY-MM-DD, from issued_at). */
  day: string;
  horizon: Horizon;
  /** Directional accuracy within that day bucket, 0–1 (null if no scored dirs). */
  accuracy: number | null;
  /** Number of directional forecasts in the bucket. */
  n: number;
}

export interface ComputeOptions {
  /** Only count snapshots issued within the last N days. Default: 30. */
  windowDays?: number;
  /** Filter to one symbol, or undefined for both. */
  symbol?: TrackSymbol;
  /** Filter to one horizon, or undefined for both. */
  horizon?: Horizon;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the forecast-verification history. Mirrors the cascade in
 * useOptionsData.fetchKronosForecast: local in dev, GitHub raw URL otherwise,
 * cache-busting query, newest-wins.
 */
export async function fetchTrackRecord(): Promise<ForecastTrackRecord | null> {
  const isDev = import.meta.env.DEV;
  const urls = isDev
    ? [TRACK_RECORD_LOCAL_URL, TRACK_RECORD_REPO_URL]
    : [TRACK_RECORD_REPO_URL, TRACK_RECORD_LOCAL_URL];

  for (const url of urls) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
      });
      if (!res.ok) continue;
      const data = await res.json();
      // The Python writer stores a flat array; accept both shapes defensively.
      const snapshots: ForecastSnapshot[] = Array.isArray(data)
        ? data
        : data?.snapshots ?? [];
      if (!Array.isArray(snapshots)) continue;
      return { snapshots };
    } catch (err) {
      console.warn(`fetchTrackRecord: failed ${url}`, err);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metrics (pure)
// ---------------------------------------------------------------------------

/**
 * Wilson score interval 95% half-width for a binomial proportion. Gives a
 * sane uncertainty band even for tiny samples (n=1 → wide CI, not 0).
 */
function wilsonCi95(successes: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return Math.min(centre + half, 1) - Math.max(centre - half, 0); // full width
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeMetricSet(snaps: ForecastSnapshot[]): MetricSet {
  // Directional: only forecasts that took a stance (UP/DOWN, i.e. direction_correct !== null).
  const dirSamples = snaps.filter((s) => s.direction_correct !== null);
  const dirHits = dirSamples.filter((s) => s.direction_correct === true).length;
  const directionalN = dirSamples.length;
  const directionalAccuracy = directionalN > 0 ? dirHits / directionalN : null;
  const directionalCi95 = wilsonCi95(dirHits, directionalN);

  // MAPE
  const apeSamples = snaps
    .filter((s) => typeof s.abs_pct_error === 'number')
    .map((s) => s.abs_pct_error as number);
  const mape = apeSamples.length > 0 ? mean(apeSamples) : null;
  const mapeStd = apeSamples.length > 1 ? stdDev(apeSamples) : null;

  // Range coverage
  const rangeSamples = snaps.filter((s) => s.range_hit !== null);
  const rangeHits = rangeSamples.filter((s) => s.range_hit === true).length;
  const rangeN = rangeSamples.length;
  const rangeCoverage = rangeN > 0 ? rangeHits / rangeN : null;

  // Monte Carlo band coverage (v2+ snapshots only; legacy v1 records have no
  // band_hit and are ignored, so the metric only reflects the post-band era).
  const bandSamples = snaps.filter((s) => s.band_hit !== null && s.band_hit !== undefined);
  const bandHits = bandSamples.filter((s) => s.band_hit === true).length;
  const bandN = bandSamples.length;
  const bandCoverage = bandN > 0 ? bandHits / bandN : null;
  const bandCi95 = wilsonCi95(bandHits, bandN);

  // totalScored = any snapshot with a realized price
  const totalScored = snaps.filter((s) => s.realized_price !== null).length;

  return {
    directionalAccuracy,
    directionalN,
    directionalCi95,
    mape,
    mapeN: apeSamples.length,
    mapeStd,
    rangeCoverage,
    rangeN,
    bandCoverage,
    bandN,
    bandCi95,
    totalScored,
  };
}

function groupKey(symbol: string, horizon: string): string {
  return `${symbol}|${horizon}`;
}

/**
 * Compute the full track-record metrics for the selected window/filters.
 *
 * Pure function — exported for unit testing (see forecastScoreService.test.ts).
 */
export function computeMetrics(
  snapshots: ForecastSnapshot[],
  options: ComputeOptions = {},
): TrackRecordMetrics {
  const { windowDays = 30, symbol, horizon } = options;

  const cutoff = windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : 0;

  const selected = snapshots.filter((s) => {
    const issued = Date.parse(s.issued_at);
    if (Number.isNaN(issued)) return false;
    if (windowDays > 0 && issued < cutoff) return false;
    if (symbol && s.symbol !== symbol) return false;
    if (horizon && s.horizon !== horizon) return false;
    return true;
  });

  // Per-group breakdown across ALL four (symbol, horizon) combinations present.
  const groups: Record<string, ForecastSnapshot[]> = {};
  for (const s of selected) {
    const k = groupKey(s.symbol, s.horizon);
    (groups[k] ??= []).push(s);
  }
  const byGroup: Record<string, MetricSet> = {};
  for (const [k, snaps] of Object.entries(groups)) {
    byGroup[k] = computeMetricSet(snaps);
  }

  const overall = computeMetricSet(selected);

  // Rolling daily directional accuracy, per horizon, merged+sorted by day.
  const buckets: Record<string, Record<Horizon, { hits: number; n: number }>> = {};
  for (const s of selected) {
    if (s.direction_correct === null) continue; // FLAT excluded from rolling dir
    const day = s.issued_at.slice(0, 10);
    (buckets[day] ??= { '4h': { hits: 0, n: 0 }, '1d': { hits: 0, n: 0 } });
    const b = buckets[day][s.horizon as Horizon];
    if (!b) continue;
    b.n += 1;
    if (s.direction_correct === true) b.hits += 1;
  }
  const rolling: RollingPoint[] = [];
  for (const [day, byH] of Object.entries(buckets)) {
    for (const h of ['4h', '1d'] as Horizon[]) {
      const b = byH[h];
      if (b.n === 0) continue;
      rolling.push({
        day,
        horizon: h,
        accuracy: b.hits / b.n,
        n: b.n,
      });
    }
  }
  rolling.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.horizon < b.horizon ? -1 : 1));

  const pendingCount = selected.filter((s) => s.realized_price === null).length;

  const issuedTimes = selected
    .map((s) => Date.parse(s.issued_at))
    .filter((t) => !Number.isNaN(t));
  const windowStart = issuedTimes.length
    ? new Date(Math.min(...issuedTimes)).toISOString()
    : null;
  const windowEnd = issuedTimes.length
    ? new Date(Math.max(...issuedTimes)).toISOString()
    : null;

  return {
    byGroup,
    overall,
    rolling,
    pendingCount,
    totalCount: selected.length,
    windowStart,
    windowEnd,
  };
}

/** Wilson half-width → display string like "±8.2pp" (percentage points), or '—'. */
export function formatCi95(ci: number | null): string {
  if (ci === null) return '—';
  return `±${((ci / 2) * 100).toFixed(1)}pp`;
}
