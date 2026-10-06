import React, { useMemo } from 'react';
import { buildLadder, type LadderLevel } from '../lib/auction';
import type { DayPlanLevel } from '../services/dayPlanService';

/**
 * Ladder — la scala verticale dei livelli di oggi.
 *
 * Una riga per livello, ordinate per prezzo (resistenze sopra, supporti
 * sotto), il prezzo live al centro. Ogni riga: prezzo (grosso), nome,
 * distanza in PUNTI, chip meccanismo e affidabilità storica.
 *
 * @module components/Ladder
 */

interface Row {
  name: string;
  nome_it: string;
  price: number;
  kind: string;
  source: string;
  distPts: number;
  gamma?: string;
  merged?: number;
  members?: Array<{ nome_it: string; gammaSign?: string }>;
  importance?: 'alta' | 'media' | 'bassa';
  score?: number;
  held?: number;
  n?: number;
  /** GEX netto aggregato sugli strike caduti in questa zona (dal profilo gamma). */
  gex?: { net: number; parts: string[] };
}

const fmtGex = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });

/** Colonna GEX della scala: barra orizzontale ancorata a destra, lunghezza
 *  = |gex netto| della zona sul muro più grande di TUTTI gli strike.
 *  Verde = gamma lunga (pin, respinge) · rossa = gamma corta (trigger, amplifica). */
const GexBar: React.FC<{ g?: { net: number; parts: string[] }; max: number }> = ({ g, max }) => {
  if (!g) return <div className="w-14 shrink-0 ml-auto" aria-hidden />;
  const w = Math.max(8, Math.round(Math.abs(g.net) / max * 100));
  const long = g.net >= 0;
  return (
    <div className="w-14 shrink-0 ml-auto flex items-center justify-end"
         title={`GEX netto ${fmtGex.format(g.net)} · strike ${g.parts.join(' + ')} — ${long ? 'gamma lunga: respinge (pin)' : 'gamma corta: amplifica (trigger)'}`}>
      <div className={`h-1.5 rounded-full ${long ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
           style={{ width: `${w}%` }} />
    </div>
  );
};

const KIND_META: Record<string, { chip: string; title: string }> = {
  magnet: { chip: 'bg-violet-500/15 text-violet-300 border-violet-500/30', title: 'Magnete: il prezzo tende a tornarci' },
  barrier: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', title: 'Barriera: il prezzo tende a respingersi' },
  trigger: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30', title: 'Trigger: superato il livello, il movimento accelera' },
  pivot: { chip: 'bg-blue-500/10 text-blue-300 border-blue-500/20', title: 'Riferimento pivot della giornata' },
  reference: { chip: 'bg-slate-700/40 text-slate-300 border-slate-600/40', title: 'Riferimento di contesto' },
};

export const Ladder: React.FC<{
  levels: DayPlanLevel[];
  spot: number;
  futures: string;
  stats: Record<string, { n: number; held: number; rate: number }>;
  maxPerSide?: number;
  /** Profilo gamma per strike (plan.top_gamma): ripescato sulla griglia della scala. */
  topGamma?: Array<{ strike_fut: number; net_gex: number; sign: 'long' | 'short' }>;
}> = ({ levels, spot, futures, stats, maxPerSide = 6, topGamma }) => {
  // Clustering: livelli che cadono nella stessa zona a 5 punti si fondono
  // (merged = quante fonti), rank = confluenza + magneti + flip + prossimità.
  const { above: zonesAbove, below: zonesBelow } = useMemo(
    () => buildLadder(
      levels.map(l => ({
        name: l.name,
        label: l.name,
        nome_it: l.nome_it,
        price: l.price,
        family: l.source === 'options' ? 'options' as const
              : l.source === 'amt' ? 'amt' as const
              : 'price' as const,
        kind: l.kind,
        gammaSign: l.gamma === 'pin' ? 'pin' as const : l.gamma === 'trigger' ? 'trigger' as const : undefined,
        isFlip: l.name === 'GEX-FLIP',
        isNaked: l.name.startsWith('NAKED'),
      })),
      spot, 5, maxPerSide, 0.05,
    ),
    [levels, spot, maxPerSide],
  );

  // GEX per zona: gli strike del profilo gamma riportati sulla STESSA griglia
  // a 5 punti della scala (Math.round(p/5)*5, come buildLadder). Le barre
  // sono normalizzate sul muro più grande di tutti gli strike, anche quelli
  // fuori scala: così il confronto tra zone resta onesto.
  const gammaByZone = useMemo(() => {
    const m = new Map<number, { net: number; parts: string[] }>();
    for (const t of topGamma ?? []) {
      if (!isFinite(t.strike_fut) || !t.net_gex) continue;
      const z = Math.round(t.strike_fut / 5) * 5;
      const cur = m.get(z) ?? { net: 0, parts: [] };
      cur.net += t.net_gex;
      cur.parts.push(`${t.strike_fut.toFixed(0)} ${t.sign === 'long' ? 'pin' : 'trg'}`);
      m.set(z, cur);
    }
    return m;
  }, [topGamma]);
  const maxAbsGex = useMemo(
    () => Math.max(1, ...[...gammaByZone.values()].map(v => Math.abs(v.net))),
    [gammaByZone],
  );

  const mkRow = (z: LadderLevel): Row => {
    const statsKey = `${futures}:${z.statsKey}`;
    return {
      name: z.statsKey,
      nome_it: z.label,
      price: z.price,
      kind: z.kind ?? 'pivot',
      source: z.family,
      distPts: Math.round(z.price - spot),
      gamma: z.gammaSign,
      merged: z.merged,
      members: z.members,
      importance: z.importance,
      score: z.score,
      held: stats[statsKey]?.held,
      n: stats[statsKey]?.n,
      gex: gammaByZone.get(z.price),
    };
  };

  // Ordine a scala: sopra lo spot il PIÙ LONTANO in alto (prezzi decrescenti
  // scendendo verso lo spot), sotto lo spot il più vicino prima.
  const aboveRows = [...zonesAbove].sort((a, b) => b.price - a.price).map(mkRow);
  const belowRows = zonesBelow.map(mkRow);

  const spotRow: Row | null = spot ? {
    name: 'SPOT', nome_it: 'Spot', price: Math.round(spot), kind: 'reference',
    source: 'price', distPts: 0,
  } : null;
  const aboveShown = zonesAbove.map(mkRow);
  const belowShown = zonesBelow.map(mkRow);

  const RowView: React.FC<{ r: Row; isSpot?: boolean }> = ({ r, isSpot }) => {
    const meta = KIND_META[r.kind] ?? KIND_META.pivot;
    const conf = r.n && r.n >= 5 ? { text: `${r.held}/${r.n}`, tone: r.held / r.n >= 0.6 ? 'text-emerald-400' : r.held / r.n <= 0.4 ? 'text-red-400' : 'text-slate-300' } : null;
    return (
      <div className={`flex flex-col px-3 py-2.5 rounded-xl border transition-colors ${
        isSpot
          ? 'border-amber-500/50 bg-amber-500/10'
          : r.distPts >= 0 && r.distPts <= 15 || (r.distPts < 0 && r.distPts >= -15)
            ? 'border-slate-700/70 bg-slate-900/40'
            : 'border-transparent hover:bg-slate-900/40'
      }`}>
        <div className="flex items-center gap-3 min-w-0">
          <span className={`font-mono font-extrabold tnum ${isSpot ? 'text-xl text-amber-300' : 'text-base text-slate-100'}`}>
            {futures} {r.price.toLocaleString()}
          </span>
          {isSpot && <span className="text-[9px] font-extrabold text-amber-400/80 uppercase tracking-widest">live</span>}
          {!isSpot && (r.merged ?? 0) > 1 && (
            <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap"
                  title={`${r.merged} livelli distinti confluiscono su questa zona: confluenza alta`}>
              ★ {r.merged} in confluenza
            </span>
          )}
          <span className="text-[11px] text-gray-400 truncate">{r.nome_it}</span>
          {r.importance && (
            <span className={`text-[8px] font-extrabold uppercase px-1 py-0.5 rounded whitespace-nowrap ${
              r.importance === 'alta' ? 'bg-emerald-500/15 text-emerald-400'
              : r.importance === 'media' ? 'bg-sky-500/15 text-sky-400'
              : 'bg-slate-700/40 text-slate-500'
            }`}
            title={`Importanza (punteggio ${r.score ?? '—'}): confluenza di fonti, magneti, flip, pin e prossimità allo spot`}>
              {r.importance === 'alta' ? '★★★' : r.importance === 'media' ? '★★' : '★'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {conf && (
            <span className={`text-[10px] font-mono font-bold tnum ${conf.tone}`}
                  title={`Su ${r.n} occorrenze, il livello è stato rispettato ${r.held} volte`}>
              {conf.text}
            </span>
          )}
          <span className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded border ${meta.chip}`} title={meta.title}>
            {r.kind === 'magnet' ? '🧲 magnete' : r.kind === 'barrier' ? '🛡 barriera' : r.kind === 'trigger' ? '⚡ trigger' : 'pivot'}
          </span>
          {!isSpot && (
            <span className={`text-[11px] font-mono font-semibold tnum w-16 text-right ${r.distPts > 0 ? 'text-red-400/80' : 'text-green-400/80'}`}
                  title={`Distanza dal prezzo live: ${r.distPts > 0 ? '+' : ''}${r.distPts} punti`}>
              {r.distPts > 0 ? '+' : ''}{r.distPts} pt
            </span>
          )}
          <GexBar g={isSpot ? undefined : r.gex} max={maxAbsGex} />
        </div>
        {(r.merged ?? 0) > 1 && r.members && r.members.length > 0 && (
          <div className="text-[10px] text-gray-500 truncate" title="I livelli che compongono la confluenza">
            = {r.members.map(m => m.nome_it).join('  +  ')}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0.5">
      {aboveRows.map(r => <RowView key={r.price} r={r} />)}
      {spotRow && <RowView r={spotRow} isSpot />}
      {!spotRow && (
        <div className="flex items-center gap-3 px-3 py-3">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
          <span className="text-xs font-extrabold text-amber-300 uppercase tracking-wider tnum">
            ⚡ Spot {futures} {spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <div className="h-px flex-1 bg-gradient-to-r from-amber-500/40 via-transparent to-transparent" />
        </div>
      )}
      {belowRows.map(r => <RowView key={r.price} r={r} />)}
    </div>
  );
};
