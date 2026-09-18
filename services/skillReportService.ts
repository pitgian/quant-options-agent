/**
 * Skill report + Alpha Lab service
 *
 * Fetches data/skill_report.json and data/alpha_lab.json — both produced by
 * the CI self-improvement step (scripts/skill_evaluator.py / alpha_lab.py) on
 * the `data` branch — with the same local→repo cascade used by the other data
 * services, plus a short in-memory cache.
 *
 * skill_report.json : deduped skill vs the naive no-move baseline + verdicts
 * alpha_lab.json    : walk-forward champion per group + progress timeline
 *
 * @module services/skillReportService
 */

export type SkillVerdict = 'ALPHA' | 'NO_ALPHA' | 'ANTI';

export interface SkillDirection {
  n_directional: number;
  n_flat: number;
  accuracy_pct: number | null;
  p_value: number | null;
  realized_up_pct: number | null;
}

export interface SkillGroup {
  n_targets: number;
  mae_model_pct: number;
  mae_naive_pct: number;
  /** Positive = beats the naive "price does not move" baseline. */
  skill_vs_naive_pct: number;
  mean_abs_move_pct: number;
  mean_pred_move_pct: number;
  direction: SkillDirection;
  correlation: { pred_vs_real: number | null; p_value: number | null };
  band_coverage_pct: number | null;
  window: { first_target: string | null; last_target: string | null };
  verdict: SkillVerdict;
}

export interface SkillReport {
  version: number;
  generated_at: string;
  window_days: number | null;
  min_targets_for_verdict: number;
  total_scored_snapshots: number;
  total_distinct_targets: number;
  duplication_factor: number;
  groups: Record<string, SkillGroup>;
}

export interface AlphaLabGroup {
  n_targets: number;
  champion: string | null;
  mode: 'model' | 'dampen' | 'passthrough' | 'observe';
  skill_vs_naive_pct: number | null;
  beats_naive_p: number | null;
  arena?: Record<string, { n_test: number; mae_pct: number; skill_vs_naive_pct?: number; beats_naive_p?: number }>;
}

export interface AlphaLab {
  version: number;
  generated_at: string;
  groups: Record<string, AlphaLabGroup>;
  timeline: Array<{
    ts: string;
    group: string;
    n_targets: number;
    champion: string | null;
    mode: string;
    skill_vs_naive_pct: number | null;
    issued_skill: number | null;
  }>;
}

const REPO_BASE = 'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data';
const CACHE_TTL_MS = 60 * 1000;

let skillCache: { ts: number; data: SkillReport } | null = null;
let labCache: { ts: number; data: AlphaLab } | null = null;

async function fetchJson<T>(filename: string, now: number): Promise<T | null> {
  const isDev = import.meta.env.DEV;
  const urls = isDev
    ? [`/data/${filename}`, `${REPO_BASE}/${filename}`]
    : [`${REPO_BASE}/${filename}`, `/data/${filename}`];

  let best: T | null = null;
  let bestTime = 0;
  for (const url of urls) {
    try {
      const res = await fetch(`${url}?t=${now}`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const data = (await res.json()) as T;
      if (!data || typeof data !== 'object') continue;
      const gen = (data as { generated_at?: unknown }).generated_at;
      const t = typeof gen === 'string' ? new Date(gen).getTime() : 0;
      if (!best || t > bestTime) {
        best = data;
        bestTime = t;
      }
    } catch (err) {
      console.warn(`[skillReport] ${filename} failed:`, err);
    }
  }
  return best;
}

export async function fetchSkillReport(force = false): Promise<SkillReport | null> {
  const now = Date.now();
  if (!force && skillCache && now - skillCache.ts < CACHE_TTL_MS) return skillCache.data;
  const data = await fetchJson<SkillReport>('skill_report.json', now);
  if (data) skillCache = { ts: now, data };
  return data;
}

export async function fetchAlphaLab(force = false): Promise<AlphaLab | null> {
  const now = Date.now();
  if (!force && labCache && now - labCache.ts < CACHE_TTL_MS) return labCache.data;
  const data = await fetchJson<AlphaLab>('alpha_lab.json', now);
  if (data) labCache = { ts: now, data };
  return data;
}

export function clearSkillReportCache(): void {
  skillCache = null;
  labCache = null;
}
