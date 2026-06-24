/**
 * Covariate Adapter stats service
 *
 * Fetches data/adapter_training_stats.json (produced by train_adapter.py on
 * the `data` branch / Gist) with the same local→Gist→repo cascade used for
 * the other data files, plus a short in-memory cache.
 *
 * @module services/adapterStatsService
 */

import type { AdapterTrainingStats } from '../types';

const GIST_USER = import.meta.env.VITE_GIST_USER;
const GIST_ID = import.meta.env.VITE_GIST_ID;

const REPO_URL =
  'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data/adapter_training_stats.json';
const GIST_URL =
  GIST_USER && GIST_ID
    ? `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/adapter_training_stats.json`
    : null;
const LOCAL_URL = '/data/adapter_training_stats.json';

const CACHE_TTL_MS = 60 * 1000; // 1 minute

let cache: { ts: number; data: AdapterTrainingStats } | null = null;

export async function fetchAdapterStats(force = false): Promise<AdapterTrainingStats | null> {
  const now = Date.now();
  if (!force && cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const isDev = import.meta.env.DEV;
  const urls: { name: string; url: string | null }[] = [];
  if (isDev) {
    urls.push({ name: 'Local', url: LOCAL_URL });
    if (GIST_URL) urls.push({ name: 'Gist', url: GIST_URL });
    urls.push({ name: 'Repo', url: REPO_URL });
  } else {
    if (GIST_URL) urls.push({ name: 'Gist', url: GIST_URL });
    urls.push({ name: 'Repo', url: REPO_URL });
    urls.push({ name: 'Local', url: LOCAL_URL });
  }

  let best: AdapterTrainingStats | null = null;
  let bestTime = 0;

  for (const src of urls) {
    if (!src.url) continue;
    try {
      const res = await fetch(`${src.url}?t=${now}`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const data = (await res.json()) as AdapterTrainingStats;
      if (!data || typeof data !== 'object' || data.version === undefined) continue;
      const t = data.trained_at ? new Date(data.trained_at).getTime() : 0;
      if (!best || t > bestTime) {
        best = data;
        bestTime = t;
      }
    } catch (err) {
      console.warn(`[adapterStats] ${src.name} failed:`, err);
    }
  }

  if (best) cache = { ts: now, data: best };
  return best;
}

export function clearAdapterStatsCache(): void {
  cache = null;
}
