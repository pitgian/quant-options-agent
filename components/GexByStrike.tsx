import React from 'react';

/**
 * GexByStrike — il profilo gamma per strike (dealer positioning).
 *
 * Barre orizzontali: gamma lunga (verde, i dealer respingono il prezzo =
 * pin/barriera) vs gamma corta (rossa, le coperture amplificano = trigger).
 * Linee di riferimento: prezzo live e GEX flip.
 *
 * @module components/GexByStrike
 */

export interface GammaStrike {
  strike_fut: number;
  net_gex: number;
  sign: 'long' | 'short';
}

export const GexByStrike: React.FC<{
  strikes: GammaStrike[];
  spot: number;
  flip?: number;
  futures: string;
}> = ({ strikes, spot, flip, futures }) => {
  if (strikes.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        Dati gamma non disponibili in questo snapshot.
      </p>
    );
  }

  // ordina per strike e normalizza le barre sul |gex| massimo
  const sorted = [...strikes].sort((a, b) => a.strike_fut - b.strike_fut);
  const maxAbs = Math.max(...sorted.map(s => Math.abs(s.net_gex)), 1);
  const minP = Math.min(...sorted.map(s => s.strike_fut));
  const maxP = Math.max(...sorted.map(s => s.strike_fut));
  const span = maxP - minP || 1;

  return (
    <div>
      <div className="flex flex-col gap-1">
        {sorted.map(s => {
          const w = (Math.abs(s.net_gex) / maxAbs) * 100;
          const long = s.sign === 'long';
          const nearSpot = Math.abs(s.strike_fut - spot) < span * 0.04;
          return (
            <div key={s.strike_fut} className="flex items-center gap-2" title={`${futures} ${s.strike_fut.toFixed(0)} — ${long ? 'gamma lunga: respinge (pin)' : 'gamma corta: accelera (trigger)'}`}>
              <span className={`w-14 text-right text-[10px] font-mono shrink-0 ${nearSpot ? 'text-amber-300 font-bold' : 'text-gray-500'}`}>
                {s.strike_fut.toFixed(0)}
              </span>
              <div className="flex-1 h-4 rounded-sm bg-slate-900/50 relative overflow-hidden">
                <div
                  className={`h-full rounded-sm ${long ? 'bg-emerald-500/50' : 'bg-red-500/45'}`}
                  style={{ width: `${w}%` }}
                />
              </div>
              <span className={`w-12 text-[9px] font-extrabold uppercase text-right ${long ? 'text-emerald-400' : 'text-red-400'}`}>
                {long ? 'pin' : 'trg'}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-[10px] text-gray-500 mt-2 tnum">
        <span>{futures} {minP.toFixed(0)}</span>
        {flip && <span className="text-violet-300 font-semibold">Flip {flip.toFixed(0)}</span>}
        <span>{futures} {maxP.toFixed(0)}</span>
      </div>
      <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
        Barre <b className="text-emerald-400">verdi</b> = strike dove i dealer sono <b>long gamma</b>: fanno trading
        contro il movimento, il prezzo tende a fermarsi/rispingere (pin). Barre <b className="text-red-400">rosse</b> =
        <b> short gamma</b>: le coperture amplificano il movimento, la rottura accelera. Più la barra è lunga, più forte l'effetto.
      </p>
    </div>
  );
};
