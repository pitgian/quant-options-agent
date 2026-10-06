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
  held?: number;
  n?: number;
}

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
}> = ({ levels, spot, futures, stats, maxPerSide = 6 }) => {
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
      spot, 5, maxPerSide,
    ),
    [levels, spot, maxPerSide],
  );

  const mkRow = (z: LadderLevel): Row => ({
    name: z.statsKey,
    nome_it: z.label,
    price: z.price,
    kind: z.kind ?? 'pivot',
    source: z.family,
    distPts: Math.round(z.price - spot),
    gamma: z.gammaSign,
    held: stats[z.statsKey]?.held,
    n: stats[z.statsKey]?.n,
    merged: z.merged,
  });

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
      <div className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
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
            <span className={`text-[11px] font-mono font-semibold tnum w-14 text-right ${r.distPts > 0 ? 'text-red-400/80' : 'text-green-400/80'}`}>
              {r.distPts > 0 ? '+' : ''}{r.distPts}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0.5">
      {aboveShown.map(r => <RowView key={r.name + r.price} r={r} />)}
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
      {belowShown.map(r => <RowView key={r.name + r.price} r={r} />)}
    </div>
  );
};
