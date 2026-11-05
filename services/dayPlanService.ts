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
  /** Serie dell'opzione che genera il muro (solo walls: call/put). */
  side?: 'call' | 'put';
  /** Lato dominante dello strike per i muri gamma (call vs put):
   *  etichetta 'Call wall' / 'Put wall' alla InsiderFinance. */
  wall_side?: 'call' | 'put';
  /** Open Interest del muro (contratti) — solo per i walls. */
  oi?: number;
  /** Catena che genera il livello (solo fonti opzioni):
   *  'etf' = SPY/QQQ (default anche se assente, piani legacy)
   *  'index' = SPX/NDX (opzioni europee, hedge sui futures). */
  chain?: 'etf' | 'index';
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
  /** Regime dal segno del GEX sullo spot: presente anche senza flip. */
  gamma_regime?: 'long' | 'short' | null;
  top_gamma?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  /** Stessi aggregati ma dalla catena INDICE (SPX per ES, NDX per NQ):
   *  assenti se la catena indice è degradata o mancante nello snapshot. */
  gamma_regime_index?: 'long' | 'short' | null;
  top_gamma_index?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  gex_flip_0dte_index?: number;
  /** Profili gamma per borsa di scadenza (selettore maturità della scala):
   *  0dte = solo scadenze di oggi · week = entro 7 giorni · all = top_gamma. */
  top_gamma_0dte?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  top_gamma_week?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  top_gamma_0dte_index?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  top_gamma_week_index?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  /** Profilo GEX COMPLETO per strike per borsa (0dte/week/all): l'istogramma.
   *  s = strike in scala NQ · c = GEX lato call (≥0, Mld) · p = GEX lato put (≤0, Mld). */
  gex_profile?: Array<{ s: number; c: number; p: number }>;
  gex_profile_0dte?: Array<{ s: number; c: number; p: number }>;
  gex_profile_week?: Array<{ s: number; c: number; p: number }>;
  gex_profile_index?: Array<{ s: number; c: number; p: number }>;
  gex_profile_0dte_index?: Array<{ s: number; c: number; p: number }>;
  gex_profile_week_index?: Array<{ s: number; c: number; p: number }>;
  max_pain_nearest_index?: number;
  max_pain_all_index?: number;
  vwap?: number;
  vwap_sigma?: number;
  ib?: { high: number | null; low: number | null };
  spot_etf?: number;
}

export interface LevelHistoryEntry {
  date: string;
  kind: string;
  dist_pts?: number;
  regime?: 'long' | 'short' | null;
  scenario?: string | null;
  divergence?: boolean | null;
  near_mp?: boolean | null;
  spot?: number;
  held: boolean;
}

export interface LevelStat {
  name: string;
  nome_it: string;
  n: number;
  held: number;
  rate: number;
  /** Verdetti giornalieri con snapshot dello stato (dataset decision model). */
  history?: LevelHistoryEntry[];
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

// In produzione il piano vive sul data branch (raw.githubusercontent);
// in SVILUPPO usa i file locali /data serviti dal middleware vite — così
// si testa il pipeline rigenerato localmente senza pushare.
const BASE = import.meta.env.DEV
  ? '/data'
  : 'https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data';
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
