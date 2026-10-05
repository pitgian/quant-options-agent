import React, { useMemo } from 'react';
import { Badge } from './ui';
import type { DayTradingLevel, IntradayLevels, IntradayLevel } from '../types';

/**
 * LevelSheet — IL foglio dei livelli di oggi.
 *
 * Fondle le tre fonti indipendenti in un'unica gerarchia di ZONE (arrotondate
 * a 5 punti ES/NQ) e le ordina per CONFLUENZA: più fonti coincidono sulla
 * stessa zona, più alta è l'opportunità operativa.
 *
 *   📐 AMT     — POC/VAH/VAL di ieri, POC developing, naked POC, Initial Balance
 *   💵 Prezzo  — PDH/PDL, ONH/ONL, VWAP ±σ, aperture RTH/settimana
 *   ⚙️ Opzioni — muri pin/trigger, GEX flip
 *
 * La tabella è divisa in SOPRA / SOTTO il prezzo, ordinate per prossimità.
 *
 * @module components/LevelSheet
 */

type Family = 'amt' | 'price' | 'options';

interface Candidate {
  price: number;         // già in scala futures, round a 5pt nel clustering
  label: string;
  family: Family;
  gammaSign?: 'pin' | 'trigger';
  isFlip?: boolean;
  isNaked?: boolean;
}

export interface LevelSheetProps {
  playbook?: IntradayLevels;
  /** Muri da opzioni in scala ETF (strike) — convertiti qui in futures. */
  walls: DayTradingLevel[];
  /** GEX flip in scala ETF (strike). */
  gexFlipEtf?: number | null;
  /** Prezzo futures live. */
  spotFut: number;
  /** Fattore di conversione ETF → futures (ES/SPY o NQ/QQQ, live). */
  etfToFut: number;
  /** Moltiplicatore indice → futures (basis ES−SPX incluso dal chiamante? no: solo ratio indice/futures). */
  indexToFut: number;
  futuresSymbol: string;
}

const FAMILY_META: Record<Family, { badge: string; icon: string; name: string }> = {
  amt: { badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30', icon: '📐', name: 'AMT' },
  price: { badge: 'bg-blue-500/15 text-blue-300 border-blue-500/30', icon: '💵', name: 'Prezzo' },
  options: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: '⚙️', name: 'Opzioni' },
};

const LABEL_IT: Record<string, string> = {
  PDH: 'Max ieri', PDL: 'Min ieri', ONH: 'Max overnight', ONL: 'Min overnight',
  VWAP: 'VWAP', 'VWAP+1σ': 'VWAP +1σ', 'VWAP-1σ': 'VWAP −1σ',
  OPEN: 'Apertura RTH', 'W-OPEN': 'Apertura settimana',
  'IB-HIGH': 'Initial Balance high', 'IB-LOW': 'Initial Balance low',
  'VAH-1d': 'VAH ieri', 'POC-1d': 'POC ieri', 'VAL-1d': 'VAL ieri',
  'POC-dev': 'POC di oggi', 'NAKED POC': 'POC naked',
  PWH: 'Max settimana scorsa', PWL: 'Min settimana scorsa',
};

const AMT_LABELS = new Set(['VAH-1d', 'POC-1d', 'VAL-1d', 'POC-dev', 'NAKED POC', 'IB-HIGH', 'IB-LOW']);

function familyOf(label: string): Family {
  if (AMT_LABELS.has(label)) return 'amt';
  return 'price';
}

const OPEN_TYPE_IT: Record<string, string> = {
  above_vah: 'sopra la value di ieri',
  below_val: 'sotto la value di ieri',
  inside_va: 'dentro la value di ieri',
};

export const LevelSheet: React.FC<LevelSheetProps> = ({
  playbook, walls, gexFlipEtf, spotFut, etfToFut, indexToFut, futuresSymbol,
}) => {
  const zones = useMemo(() => {
    if (!spotFut) return [];

    const candidates: Candidate[] = [];

    // 💵 Prezzo + 📐 AMT dal playbook (già in scala futures nativa)
    for (const l of (playbook?.levels ?? []) as IntradayLevel[]) {
      candidates.push({
        price: l.price,
        label: l.label,
        family: familyOf(l.label),
        isNaked: l.label === 'NAKED POC',
      });
    }

    // ⚙️ Opzioni: muri (strike ETF → futures) con meccanismo gamma
    for (const w of walls) {
      candidates.push({
        price: w.strike * etfToFut,
        label: w.type === 'support' ? 'Put Wall' : 'Call Wall',
        family: 'options',
        gammaSign: w.gammaSign,
      });
    }

    // ⚙️ Opzioni: GEX flip (strike indice → futures)
    if (gexFlipEtf) {
      candidates.push({
        price: gexFlipEtf * indexToFut,
        label: 'GEX Flip',
        family: 'options',
        isFlip: true,
      });
    }

    // Cluster: round a 5 punti (la griglia operativa di ES/NQ) e raggruppa.
    const buckets = new Map<number, Candidate[]>();
    for (const c of candidates) {
      if (!c.price || !isFinite(c.price)) continue;
      const key = Math.round(c.price / 5) * 5;
      buckets.set(key, [...(buckets.get(key) ?? []), c]);
    }

    return [...buckets.entries()]
      .map(([price, cands]) => {
        const families = new Set(cands.map(c => c.family));
        const hasPin = cands.some(c => c.gammaSign === 'pin');
        const hasTrigger = cands.some(c => c.gammaSign === 'trigger');
        const hasFlip = cands.some(c => c.isFlip);
        const hasNaked = cands.some(c => c.isNaked);
        // punteggio: +1 per famiglia, +1 flip, +1 naked (magnete)
        const score = families.size + (hasFlip ? 1 : 0) + (hasNaked ? 1 : 0);
        return {
          price,
          families,
          cands,
          score,
          isPin: hasPin,
          isTrigger: hasTrigger,
          isFlip: hasFlip,
          isNaked: hasNaked,
          confluence: families.size >= 2,
          distPct: (price - spotFut) / spotFut * 100,
        };
      })
      .filter(z => z.distPct !== 0);
  }, [playbook, walls, gexFlipEtf, spotFut, etfToFut, indexToFut]);

  if (!spotFut || zones.length === 0) return null;

  const above = zones.filter(z => z.price > spotFut).sort((a, b) => a.price - b.price).slice(0, 6);
  const below = zones.filter(z => z.price < spotFut).sort((a, b) => b.price - a.price).slice(0, 6);

  const openType = playbook?.open_type;
  const openNote = playbook?.open_note;

  const ZoneRow: React.FC<{ z: typeof zones[number] }> = ({ z }) => {
    const immediate = Math.abs(z.distPct) < 0.12;
    return (
      <div className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border ${immediate ? 'border-amber-500/40 bg-amber-500/5' : 'border-transparent hover:bg-slate-900/40'} transition-colors`}>
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-mono text-sm font-extrabold text-slate-100 tnum">
            {futuresSymbol} ${z.price}
          </span>
          {z.confluence && (
            <Badge tone="good" title={`${z.families.size} fonti indipendenti su questa zona`}>
              ★ {z.families.size} fonti
            </Badge>
          )}
          {z.isFlip && <Badge tone="violet" title="Inversione del regime di gamma">Flip</Badge>}
          {z.isNaked && <Badge tone="info" title="POC mai rivisitato: magnete">Magnete</Badge>}
          {z.isPin && !z.isTrigger && <Badge tone="info" title="Gamma lunga: il prezzo tende a respingersi">Pin</Badge>}
          {z.isTrigger && !z.isPin && <Badge tone="warn" title="Gamma corta: le rotture accelerano">Trg</Badge>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden md:flex items-center gap-1">
            {[...z.families].map(f => (
              <span key={f} className={`text-[8px] font-extrabold uppercase px-1 py-0.5 rounded border ${FAMILY_META[f].badge}`}>
                {FAMILY_META[f].icon} {FAMILY_META[f].name}
              </span>
            ))}
          </div>
          <span className={`text-[10px] font-mono tnum ${z.distPct > 0 ? 'text-red-400/80' : 'text-green-400/80'}`}>
            {z.distPct > 0 ? '+' : ''}{z.distPct.toFixed(2)}%
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-[#161b22] border border-slate-700 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-200">🎯 Livelli di oggi — Foglio operativo</h3>
        {openType && (
          <span className="text-[10px] text-gray-400">
            Apertura <b className="text-slate-300">{OPEN_TYPE_IT[openType]}</b>
          </span>
        )}
      </div>

      {openNote && (
        <p className="text-[11px] leading-relaxed text-gray-400 bg-slate-900/40 border border-slate-800 rounded-lg px-3 py-2">
          {openNote}
        </p>
      )}

      <div>
        <div className="text-[8px] font-bold tracking-widest text-red-400/80 uppercase px-1 pb-1">Sopra il prezzo — resistenze / magneti</div>
        <div className="flex flex-col gap-1">
          {above.map(z => <ZoneRow key={z.price} z={z} />)}
          {above.length === 0 && <span className="text-[10px] text-gray-600 italic px-1">nessuna zona rilevante</span>}
        </div>
      </div>

      <div className="flex items-center gap-3 px-1">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-blue-500/40 to-transparent" />
        <span className="text-[10px] font-extrabold text-blue-300 uppercase tracking-wider tnum">
          Spot {futuresSymbol} ${spotFut.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-blue-500/40 via-transparent to-transparent" />
      </div>

      <div>
        <div className="flex flex-col gap-1">
          {below.map(z => <ZoneRow key={z.price} z={z} />)}
          {below.length === 0 && <span className="text-[10px] text-gray-600 italic px-1">nessuna zona rilevante</span>}
        </div>
        <div className="text-[8px] font-bold tracking-widest text-green-400/80 uppercase px-1 pt-1">Sotto il prezzo — supporti / magneti</div>
      </div>

      <p className="text-[10px] text-gray-500 leading-relaxed">
        Zona = livello arrotondato a 5 punti dove coincidono una o più fonti.
        Più fonti indipendenti (📐 teoria dell'asta · 💵 prezzo · ⚙️ opzioni) sulla stessa zona = maggiore
        l'affidabilità della reazione. Passa il mouse sui badge per i dettagli del meccanismo.
      </p>
    </div>
  );
};
