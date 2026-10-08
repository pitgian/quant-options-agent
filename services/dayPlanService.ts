/**
 * dayPlanService — l'unico servizio dati dell'app.
 *
 * Scarica data/day_plan.json (il piano dei livelli del giorno generato dal
 * backend) + data/level_stats.json (affidabilità storica per livello) e
 * mantiene il prezzo live dei futures via /api-spot.
 *
 * @module services/dayPlanService
 */

export interface DayPlanLevel {
  name: string;
  nome_it: string;
  price: number;
  kind: 'magnet' | 'barrier' | 'pivot' | 'reference' | 'trigger';
  source: 'price' | 'amt' | 'options';
  dist_pts: number;
  gamma?: 'pin' | 'trigger';
}

export interface DayPlan {
  version: number;
  generated_at: string;
  futures: string;
  last_price: number;
  read: string[];
  levels: DayPlanLevel[];
  profile_today?: Record<string, number>;
  developing_poc?: number; developing_va_h?: number; developing_va_l?: number;
  max_pain_nearest?: number;
  max_pain_all?: number;
  gex_flip_0dte?: number;
  top_gamma?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short' }>;
  vwap?: number;
  vwap_sigma?: number;
  ib?: { high: number | null; low: number | null };
  spot_etf?: number;
}

export interface LevelStat {
  name: string;
  nome_it: string;
  n: number;
  held: number;
  rate: number;
}

export interface LevelStats {
  version: number;
  generated_at: string;
  levels: Record<string, LevelStat>;
}

export interface LiveSpot {
  ES: number | null;
  NQ: number | null;
}

const BASE = 'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data';
const TTL = 60 * 1000;

let statsCache: { ts: number; data: Record<string, LevelStat> } | null = null;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[dayPlan] ${url} failed:`, err);
    return null;
  }
}

interface DayPlanFile { version: number; generated_at: string; plans: Record<string, DayPlan> }

let fileCache: { ts: number; data: DayPlanFile } | null = null;

/** L'intero file (ES + NQ): serve per il confronto dei regimi SPY/QQQ. */
export async function fetchDayPlanFile(force = false): Promise<DayPlanFile | null> {
  const now = Date.now();
  if (!force && fileCache && now - fileCache.ts < TTL) return fileCache.data;
  const data = await fetchJson<DayPlanFile>(`${BASE}/day_plan.json`);
  if (data) fileCache = { ts: now, data };
  return data;
}

export async function fetchLevelStats(force = false): Promise<Record<string, LevelStat>> {
  const now = Date.now();
  if (!force && statsCache && now - statsCache.ts < TTL) return statsCache.data;
  const data = await fetchJson<{ levels?: Record<string, LevelStat> }>(`${BASE}/level_stats.json`);
  const stats = data?.levels ?? {};
  statsCache = { ts: now, data: stats };
  return stats;
}

export async function fetchLiveSpot(): Promise<LiveSpot | null> {
  try {
    const res = await fetch(`/api-spot?t=${Date.now()}`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const d = await res.json();
    return { ES: d.ES ?? null, NQ: d.NQ ?? null };
  } catch {
    return null;
  }
}

export function clearDayPlanCache(): void {
  fileCache = null;
  statsCache = null;
}
