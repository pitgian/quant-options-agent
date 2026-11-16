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
  /** 'cage' = GABBIA GAMMA: call e put entrambe grosse e in equilibrio sullo
   *  stesso strike (pin a doppia barriera: put = pavimento sotto, call =
   *  soffitto sopra). Non arriva dal piano: la ricava la UI dai profili per
   *  strike, perché il netto lì è ≈ 0 e top_gamma (ordinato per |net|) la
   *  scarterebbe sempre. */
  kind: 'magnet' | 'barrier' | 'pivot' | 'reference' | 'trigger' | 'cage';
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
  /** Strike in scala nativa della fonte (SPY/QQQ o SPX/NDX): per il
   *  confronto 1:1 con InsiderFinance accanto al prezzo in scala futures. */
  native?: number;
  nativeSource?: string;
  /* ── Solo sui livelli GEX-FLIP* (dalla 16/11, method 'curve-bs-v1') ──
     La curva di esposizione ha UN taglio: sotto sta il regime `regime`
     opposto, sopra il suo contrario. I due confini della ZONA in cui sta il
     prezzo vengono pubblicati così il sito e NT8 non devono indovinare nulla. */
  /** Regime della borsa di questo flip ('long' | 'short'). */
  regime?: 'long' | 'short' | null;
  /** Confine di regime subito SOTTO il prezzo (null = la zona non ha fondo
   *  entro la banda valutata dal pipeline). */
  zone_low?: number | null;
  /** Confine di regime subito SOPRA il prezzo (null = zona senza tetto). */
  zone_high?: number | null;
  /** Quante volte la curva taglia entro la banda (1 = libro pulito). */
  crossings?: number;
  /** Metodo di calcolo del flip, per leggere il track record nel tempo. */
  method?: string;
}

/** Banda di regime di UNA borsa di scadenza, dalla curva di esposizione gamma
 *  (day_plan.gamma_flip, 16/11). Prezzi in scala futures; *_native in scala
 *  della catena (SPY/QQQ o SPX/NDX). */
export interface GammaBand {
  regime: 'long' | 'short' | null;
  /** Il confine più vicino al prezzo. */
  flip: number | null;
  /** Ultimo confine sotto il prezzo (null = nessun taglio scendendo). */
  flip_below: number | null;
  /** Primo confine sopra il prezzo. */
  flip_above: number | null;
  flip_native?: number | null;
  flip_below_native?: number | null;
  flip_above_native?: number | null;
  crossings?: number;
  band_pct?: number;
}

export type GammaBuckets = Partial<Record<'all' | 'week' | '0dte', GammaBand | null>>;

/** Il "quaderno del regime": stessa curva letta sulle tre borse di scadenza,
 *  per entrambe le catene. regime e flip vengono dalla STESSA funzione → il
 *  badge non può più dire 'short' col prezzo sopra il confine. */
export interface GammaNotebook {
  method?: string;
  note?: string;
  etf?: { symbol: string } & GammaBuckets;
  index?: ({ symbol: string } & GammaBuckets) | null;
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
  /** GEX flip della borsa ≤7gg, in scala futures (e in strike nativo della
   *  catena ETF). Calcolato dal pipeline sullo stesso perimetro delle scadenze
   *  entro 7 giorni: con 0DTE e 'Tutte' sono TRE confini di regime diversi. */
  gex_flip_week?: number;
  gex_flip_week_native?: number;
  gex_flip_week_index?: number;
  /** Regime dal segno del GEX sullo spot: presente anche senza flip. */
  gamma_regime?: 'long' | 'short' | null;
  /** Regime+flip dalla curva di esposizione (16/11): assente nei piani vecchi,
   *  in quel caso la UI ripiega sui campi flat/gamma_regime*. */
  gamma?: GammaNotebook;
  top_gamma?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  /** Stessi aggregati ma dalla catena INDICE (SPX per ES, NDX per NQ):
   *  assenti se la catena indice è degradata o mancante nello snapshot. */
  gamma_regime_index?: 'long' | 'short' | null;
  /** Regime gamma per borsa di scadenza (0dte / week). Il regime 'all' resta
   *  gamma_regime(_index). Servono perché con 0DTE il segno del GEX attorno
   *  allo spot può essere OPPOSTO a quello strutturale. */
  gamma_regime_0dte?: 'long' | 'short' | null;
  gamma_regime_week?: 'long' | 'short' | null;
  gamma_regime_0dte_index?: 'long' | 'short' | null;
  gamma_regime_week_index?: 'long' | 'short' | null;
  top_gamma_index?: Array<{ strike: number; strike_fut: number; net_gex: number; sign: 'long' | 'short'; side?: 'call' | 'put' }>;
  /** Max pain e flip della catena ETF in scala NATIVA (SPY/QQQ): per
   *  l'istogramma fonte 'etf', i cui strike sono in scala nativa. */
  max_pain_nearest_native?: number;
  max_pain_all_native?: number;
  gex_flip_native?: number;
  gex_flip_0dte_native?: number;
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
  /** Profili ETF convertiti in scala futures + bin 25pt: solo per la
   *  modalità 'Entrambi' (somma per strike identico con il libro indice). */
  gex_profile_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  gex_profile_0dte_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  gex_profile_week_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  gex_profile_index?: Array<{ s: number; c: number; p: number }>;
  gex_profile_0dte_index?: Array<{ s: number; c: number; p: number }>;
  gex_profile_week_index?: Array<{ s: number; c: number; p: number }>;
  /** Stessi profili indice aggregati su bin 25pt (stessa griglia del profilo
   *  ETF convertito): serve solo alla modalità 'Entrambi', che somma per
   *  strike identico. */
  gex_profile_index_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  gex_profile_0dte_index_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  gex_profile_week_index_binned?: Array<{ s: number; c: number; p: number; co?: number; po?: number }>;
  max_pain_nearest_index?: number;
  max_pain_all_index?: number;
  vwap?: number;
  vwap_sigma?: number;
  ib?: { high: number | null; low: number | null };
  spot_etf?: number;
  /** Fattori di conversione NATIVO→futures pubblicati dal pipeline:
   *  ETF (SPY/QQQ)→futures e indice (SPX/NDX)→futures. Il client li usa per
   *  il doppio prezzo (futures ↔ nativo) sulla scala e nel tooltip dell'istogramma. */
  etf_to_fut_ratio?: number;
  idx_to_fut_ratio?: number;
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

/** Livelli che la scala usa davvero: SOLO opzioni. I nomi price/AMT (PDH,
 *  VWAP, POC…) non vengono più pubblicati dal pipeline (13/11) ma restano
 *  nelle stats storiche: il filtro li tiene fuori da pannelli e test di
 *  separazione, altrimenti il track record parlerebbe di livelli morti. */
const OPTIONS_LEVEL_RE = /^(PIN|TRIGGER|GEX-FLIP|MAXPAIN)/;
export function isOptionsLevel(statsKey: string): boolean {
  const name = statsKey.includes(':') ? statsKey.slice(statsKey.indexOf(':') + 1) : statsKey;
  return OPTIONS_LEVEL_RE.test(name.replace(/-IDX$/, ''));
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
  const all = data?.levels ?? {};
  const stats: Record<string, LevelStat> = {};
  for (const [k, v] of Object.entries(all)) if (isOptionsLevel(k)) stats[k] = v;
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
