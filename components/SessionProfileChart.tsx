import React, { useMemo } from 'react';
import { profileStats } from '../lib/auction';
import { Card } from './ui';

/**
 * SessionProfileChart — il profilo volumi della seduta CORRENTE, pulito.
 *
 * Un profilo, un grafico: istogramma orizzontale su asse prezzo, Value Area
 * ombreggiata, POC evidenziato, righe di riferimento (spot, VWAP, IB).
 * È la visione AMT essenziale: dove ha scambiato il mercato oggi e dove è
 * il "prezzo giusto".
 *
 * @module components/SessionProfileChart
 */

export interface ProfileOverlay {
  price: number;
  label: string;
  color?: string;
}

export interface SessionProfileChartProps {
  /** Profilo volumi della seduta: { prezzo: volume } in scala futures. */
  profile: Record<string, number> | undefined;
  spotFut: number;
  vwap?: number;
  ibHigh?: number;
  ibLow?: number;
  /** Livelli operativi sovrapposti alla loro altezza di prezzo. */
  overlays?: ProfileOverlay[];
  futuresSymbol: string;
  /** Altezza massima del grafico in px (scroll oltre). Default 380. */
  maxHeight?: number;
}

export const SessionProfileChart: React.FC<SessionProfileChartProps> = ({
  profile, spotFut, vwap, ibHigh, ibLow, overlays, futuresSymbol, maxHeight = 380,
}) => {
  const stats = useMemo(() => profileStats(profile ?? {}), [profile]);
  const rows = useMemo(() => {
    if (!profile || !stats) return [];
    const prices = Object.keys(profile).map(Number).filter(p => isFinite(p)).sort((a, b) => b - a);
    const maxVol = Math.max(...prices.map(p => profile[String(p)] ?? 0));
    return prices.map(p => ({ price: p, vol: profile[String(p)], w: (profile[String(p)] / maxVol) * 100 }));
  }, [profile]);

  if (!stats || rows.length === 0) {
    return (
      <Card className="!p-4">
        <h3 className="text-sm font-bold text-slate-200 mb-2">📊 Profilo di oggi</h3>
        <p className="text-xs text-gray-500">
          Il profilo della seduta corrente si popola con le transazioni reali: compare con l'apertura
          (o al prossimo aggiornamento del pipeline).
        </p>
      </Card>
    );
  }

  const inVA = (p: number) => p >= stats.val && p <= stats.vah;
  const rowH = 7;
  const chartH = Math.min(maxHeight, rows.length * rowH);

  const refLines: Array<{ price: number; color: string; label: string }> = [];
  refLines.push({ price: spotFut, color: '#facc15', label: 'Spot' });
  if (vwap) refLines.push({ price: vwap, color: '#38bdf8', label: 'VWAP' });
  if (ibHigh) refLines.push({ price: ibHigh, color: '#a5b4fc', label: 'IB max' });
  if (ibLow) refLines.push({ price: ibLow, color: '#a5b4fc', label: 'IB min' });
  for (const o of overlays ?? []) {
    if (o.price && isFinite(o.price)) {
      refLines.push({ price: o.price, color: o.color ?? '#f472b6', label: o.label });
    }
  }

  return (
    <Card className="!p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-sm font-bold text-slate-200">📊 Profilo di oggi (seduta in corso)</h3>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-2 rounded-sm bg-indigo-500/60" /> Value Area (70%)
          </span>
          <span className="flex items-center gap-1 text-indigo-300 font-bold">POC {stats.poc.toFixed(0)}</span>
        </div>
      </div>

      <div className="overflow-y-auto custom-scrollbar pr-1" style={{ maxHeight: chartH }}>
        <div className="flex flex-col gap-px">
          {rows.map(r => {
            const isPoc = r.price === stats.poc;
            const va = inVA(r.price);
            return (
              <div key={r.price} className="flex items-center gap-2" style={{ height: rowH }}>
                <span className={`w-12 text-right text-[8px] font-mono shrink-0 ${isPoc ? 'text-indigo-300 font-bold' : 'text-gray-600'}`}>
                  {r.price.toFixed(0)}
                </span>
                <div className="flex-1 relative h-full rounded-sm"
                     style={{ backgroundColor: va ? 'rgba(99,102,241,0.06)' : 'transparent' }}>
                  <div
                    className="h-full rounded-r-sm"
                    style={{
                      width: `${r.w}%`,
                      backgroundColor: isPoc ? 'rgba(129,140,248,0.85)' : va ? 'rgba(99,102,241,0.45)' : 'rgba(100,116,139,0.35)',
                    }}
                  />
                  {/* linee di riferimento + overlay operativi (etichettati) */}
                  {refLines.filter(l => Math.abs(l.price - r.price) < 0.5).map(l => {
                    const isOverlay = (overlays ?? []).some(o => o.label === l.label);
                    return (
                      <div key={l.label} className="absolute top-0 bottom-0 flex items-center" style={{ left: 0 }}>
                        <div className="w-0.5 h-full" style={{ backgroundColor: l.color }} />
                        {isOverlay && (
                          <span className="ml-1 text-[8px] font-bold whitespace-nowrap px-1 py-px rounded bg-slate-950/85"
                                style={{ color: l.color }}>
                            {l.label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between text-[10px] text-gray-500 mt-2 tnum">
        <span>VAL {stats.val.toFixed(0)}</span>
        <span>POC {stats.poc.toFixed(0)} · VA {stats.val.toFixed(0)}–{stats.vah.toFixed(0)}</span>
        <span>VAH {stats.vah.toFixed(0)}</span>
      </div>
    </Card>
  );
};
