/**
 * Level report service — fetches data/level_report.json (produced by
 * scripts/level_tracker.py in CI) with the same local→repo cascade as the
 * other data services.
 *
 * The report aggregates the level track record per family
 * (symbol × type × gamma sign): of the touches in the 24h window, how often
 * the level REPELLED price (bounce) vs got VIOLATED (break), with an exact
 * binomial verdict vs the 50% no-edge null.
 *
 * @module services/levelReportService
 */

export type LevelVerdict = 'BOUNCE_EDGE' | 'BREAK_EDGE' | 'NO_DATA';

export interface LevelReportKind {
  n_issued: number;
  n_scored: number;
  n_touched: number;
  bounces: number;
  breaks: number;
  bounce_rate: number | null;
  ci95: [number, number] | null;
  p_value: number | null;
  verdict: LevelVerdict;
}

export interface LevelReport {
  version: number;
  generated_at: string;
  min_touched_for_verdict: number;
  total_issued: number;
  total_scored: number;
  note: string;
  kinds: Record<string, LevelReportKind>;
}

const REPO_URL =
  'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data/level_report.json';
const LOCAL_URL = '/data/level_report.json';
const CACHE_TTL_MS = 60 * 1000;

let cache: { ts: number; data: LevelReport } | null = null;

export async function fetchLevelReport(force = false): Promise<LevelReport | null> {
  const now = Date.now();
  if (!force && cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const isDev = import.meta.env.DEV;
  const urls = isDev
    ? [LOCAL_URL, REPO_URL]
    : [REPO_URL, LOCAL_URL];

  let best: LevelReport | null = null;
  let bestTime = 0;
  for (const url of urls) {
    try {
      const res = await fetch(`${url}?t=${now}`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const data = (await res.json()) as LevelReport;
      if (!data || typeof data !== 'object' || data.version === undefined) continue;
      const t = data.generated_at ? new Date(data.generated_at).getTime() : 0;
      if (!best || t > bestTime) {
        best = data;
        bestTime = t;
      }
    } catch (err) {
      console.warn('[levelReport] fetch failed:', err);
    }
  }

  if (best) cache = { ts: now, data: best };
  return best;
}

export function clearLevelReportCache(): void {
  cache = null;
}
