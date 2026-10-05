/**
 * Auction Market Theory — motore puro per lo stato dell'asta e la scala
 * dei livelli del giorno.
 *
 * Principi AMT implementati:
 *   - Il mercato è un'asta: il prezzo cerca volume (fair value), si equilibra
 *     nella Value Area (70% dei volumi) e esce per cercare nuovo valore.
 *   - POC = prezzo più "giusto" → magnete. VAH/VAL = confini di value:
 *     rifiuto → rotazione verso POC; accettazione → migrazione di value.
 *   - Apertura fuori dalla value di ieri = giornata direzionale in ricerca;
 *     apertura dentro = giornata rotazionale (fade dei confini).
 *   - Initial Balance (primi 60 min) = range di equilibrio iniziale: rottura
 *     = probabile trend day.
 *   - Naked POC = POC non ancora rivisitato = magnete ad alta probabilità.
 *
 * @module lib/auction
 */

export interface ProfileStats {
  poc: number;
  vah: number;
  val: number;
  totalVol: number;
}

/**
 * POC + Value Area (70%) da un profilo {prezzo: volume}.
 * Espansione della VA dal POC un nodo alla volta, prendendo sempre il lato
 * con più volume (metodo standard TPO/volume profile).
 */
export function profileStats(profile: Record<string, number>): ProfileStats | null {
  const prices = Object.keys(profile).map(Number).filter(p => isFinite(p) && profile[String(p)] > 0);
  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);
  const vols = prices.map(p => profile[String(p)]);
  let pocIdx = 0;
  for (let i = 1; i < vols.length; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;
  const total = vols.reduce((s, v) => s + v, 0);
  const target = total * 0.7;
  let lo = pocIdx, hi = pocIdx, acc = vols[pocIdx];
  while (acc < target && (lo > 0 || hi < vols.length - 1)) {
    const up = hi < vols.length - 1 ? vols[hi + 1] : -1;
    const dn = lo > 0 ? vols[lo - 1] : -1;
    if (up >= dn && up >= 0) { hi++; acc += vols[hi]; }
    else if (dn >= 0) { lo--; acc += vols[lo]; }
    else break;
  }
  return {
    poc: prices[pocIdx],
    vah: prices[hi],
    val: prices[lo],
    totalVol: total,
  };
}

export type OpenType = 'above_vah' | 'inside_va' | 'below_val';

/**
 * Classificazione AMT dell'apertura rispetto alla value di ieri.
 */
export function classifyOpen(open: number, prev: ProfileStats): OpenType {
  if (open > prev.vah) return 'above_vah';
  if (open < prev.val) return 'below_val';
  return 'inside_va';
}

/** Stato del prezzo rispetto alla value di ieri (aggiornato in tempo reale). */
export function valuePosition(price: number, prev: ProfileStats): OpenType {
  return classifyOpen(price, prev);
}

// ---------------------------------------------------------------------------
// Ladder: merge + cluster + rank dei livelli del giorno
// ---------------------------------------------------------------------------

export type Family = 'amt' | 'price' | 'options';

export interface LadderLevel {
  /** Prezzo arrotondato a 5 punti (la griglia operativa di ES/NQ). */
  price: number;
  /** Etichetta breve per la UI ("Max di ieri", "VWAP", "Muro Call 0DTE"…). */
  label: string;
  /** Etichetta tecnica originale (PDH, VWAP+1σ, NAKED POC…). */
  rawLabel: string;
  family: Family;
  gammaSign?: 'pin' | 'trigger';
  isFlip?: boolean;
  isNaked?: boolean;
  /** Quanti livelli distinti confluiscono nella stessa zona. */
  merged: number;
}

export interface LadderInput {
  label: string;
  price: number;
  family: Family;
  gammaSign?: 'pin' | 'trigger';
  isFlip?: boolean;
  isNaked?: boolean;
}

export const LADDER_LABEL_IT: Record<string, string> = {
  PDH: 'Max di ieri', PDL: 'Min di ieri',
  ONH: 'Max overnight', ONL: 'Min overnight',
  VWAP: 'VWAP', 'VWAP+1σ': 'VWAP +1σ', 'VWAP-1σ': 'VWAP −1σ',
  OPEN: 'Apertura RTH', 'W-OPEN': 'Open settimanale',
  'IB-HIGH': 'Initial Balance max', 'IB-LOW': 'Initial Balance min',
  'VAH-1d': 'Value high di ieri', 'POC-1d': 'POC di ieri', 'VAL-1d': 'Value low di ieri',
  'POC-dev': 'POC di oggi', 'NAKED POC': 'POC naked',
  PWH: 'Max sett. scorsa', PWL: 'Min sett. scorsa',
};

const AMT_LABELS = new Set(['VAH-1d', 'POC-1d', 'VAL-1d', 'POC-dev', 'NAKED POC', 'IB-HIGH', 'IB-LOW']);

export function ladderFamily(label: string): Family {
  return AMT_LABELS.has(label) ? 'amt' : 'price';
}

/**
 * Costruisce la scala del giorno: arrotonda ogni livello a 5 punti, fonde i
 * coincidenti (raggruppando le fonti) e assegna un punteggio di importanza:
 *
 *   score = fonti_indipendenti*3 + magnete(naked)*2 + flip*1 + pin*1
 *           + vicinanza_al_prezzo ( entro lo 0.5% )
 *
 * Restituisce le zone ordinate per importanza; il chiamante le divide
 * sopra/sotto lo spot.
 */
export function buildLadder(inputs: LadderInput[], spot: number, bucketSize = 5, maxPerSide = 6): {
  above: LadderLevel[];
  below: LadderLevel[];
} {
  const buckets = new Map<number, LadderInput[]>();
  for (const inp of inputs) {
    if (!inp.price || !isFinite(inp.price)) continue;
    const key = Math.round(inp.price / bucketSize) * bucketSize;
    buckets.set(key, [...(buckets.get(key) ?? []), inp]);
  }

  const zones: (LadderLevel & { score: number })[] = [];
  for (const [price, members] of buckets.entries()) {
    const families = new Set(members.map(m => m.family));
    const hasNaked = members.some(m => m.isNaked);
    const hasFlip = members.some(m => m.isFlip);
    const hasPin = members.some(m => m.gammaSign === 'pin');
    const near = Math.abs(price - spot) / spot < 0.005;
    const score = families.size * 3
      + (hasNaked ? 2 : 0)
      + (hasFlip ? 1 : 0)
      + (hasPin ? 1 : 0)
      + (near ? 1 : 0);
    // etichetta: il membro più autorevole (AMT > opzioni > prezzo) e, tra i
    // muri, il pin batte il trigger.
    const order = { amt: 0, options: 1, price: 2 };
    const best = [...members].sort((a, b) =>
      (order[a.family] - order[b.family]) || (b.isNaked ? 1 : 0) - (a.isNaked ? 1 : 0)
    )[0];
    zones.push({
      price,
      label: LADDER_LABEL_IT[best.label] ?? best.label,
      rawLabel: best.label,
      family: best.family,
      gammaSign: members.find(m => m.gammaSign)?.gammaSign,
      isFlip: members.some(m => m.isFlip),
      isNaked: hasNaked,
      merged: members.length,
      score,
    });
  }

  const rank = (a: LadderLevel & { score: number }, b: LadderLevel & { score: number }) =>
    b.score - a.score || Math.abs(a.price - spot) - Math.abs(b.price - spot);

  const pick = (side: 'above' | 'below') => {
    const pool = zones
      .filter(z => side === 'above' ? z.price > spot : z.price < spot)
      .sort((a, b) => side === 'above'
        ? a.price - b.price          // sopra: il più vicino allo spot prima
        : b.price - a.price);        // sotto: idem
    // top-N per importanza, ma mostrate in ordine di prezzo (scala operativa)
    const top = [...pool].sort(rank).slice(0, maxPerSide);
    const topSet = new Set(top);
    return pool.filter(z => topSet.has(z));
  };

  return { above: pick('above'), below: pick('below') };
}
