import React, { useMemo, useState } from 'react';

/**
 * GexHistogram — istogramma Strike Profile alla InsiderFinance:
 * una barra per strike, verde sopra lo zero = GEX lato CALL, rossa sotto =
 * GEX lato PUT, linea tratteggiata sullo spot. Toggle All (±10%) / Near
 * (±1,5%). Tutti gli strike della borsa selezionata, non solo i top-4.
 *
 * I valori arrivano dal piano in Mld (miliardi $) — la stessa convenzione
 * delle etichette della scala (⧉ Call wall 15 Mld...).
 *
 * @module components/GexHistogram
 */

export interface GexProfileEntry { s: number; c: number; p: number }

const W = 900, H = 300;
const M = { left: 56, right: 16, top: 26, bottom: 26 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const NEAR_PCT = 0.015;

const fmtMld = (v: number): string =>
  `${Math.abs(v) >= 1 ? v.toFixed(Math.abs(v) >= 10 ? 0 : 1) : v.toFixed(2)} Mld`;

export const GexHistogram: React.FC<{
  profile: Array<GexProfileEntry> | undefined;
  spot: number;
  idxName: string;
}> = ({ profile, spot, idxName }) => {
  const [mode, setMode] = useState<'all' | 'near'>('all');

  const bars = useMemo(() => {
    const arr = profile ?? [];
    const lo = spot * (1 - NEAR_PCT), hi = spot * (1 + NEAR_PCT);
    return (mode === 'near' ? arr.filter(d => d.s >= lo && d.s <= hi) : arr).slice().sort((a, b) => a.s - b.s);
  }, [profile, mode, spot]);

  const geom = useMemo(() => {
    if (!bars.length) return null;
    const maxPos = Math.max(0, ...bars.map(b => b.c));
    const maxNeg = Math.max(0, ...bars.map(b => -b.p));
    const yMax = Math.max(maxPos, maxNeg, 1e-9);
    const sMin = bars[0].s, sMax = bars[bars.length - 1].s;
    const pad = (sMax - sMin) * 0.01 || 1;
    const x0 = sMin - pad, x1 = sMax + pad;
    const x = (s: number) => M.left + ((s - x0) / (x1 - x0)) * PLOT_W;
    const bw = Math.max(1.2, (PLOT_W / bars.length) * 0.72);
    const half = PLOT_H / 2;
    const yZero = M.top + half;
    const yOf = (v: number) => yZero - (Math.min(Math.abs(v), yMax) / yMax) * half * Math.sign(1);
    return { yMax, x, bw, yZero, half, sMin, sMax, x0, x1,
      barTop: (c: number) => yZero - (Math.min(c, yMax) / yMax) * half,
      barBottom: (p: number) => yZero + (Math.min(-p, yMax) / yMax) * half };
  }, [bars]);

  if (!profile || profile.length === 0) {
    return (
      <p className="text-[11px] text-gray-500 py-3">
        Profilo GEX non disponibile per questa borsa/fonte in questo snapshot.
      </p>
    );
  }

  const ticksY = [0.25, 0.5, 0.75, 1].map(f => geom!.yMax * f);
  const ticksX = (() => {
    if (!geom) return [];
    const n = 7;
    return Array.from({ length: n }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / (n - 1));
  })();

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[10px] text-gray-500">
          GEX per strike · valori in Mld $ · verde = call (gamma lunga) · rossa = put (gamma corta)
        </span>
        <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
          {(['all', 'near'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${mode === m ? 'bg-blue-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}>
              {m === 'all' ? ' Tutte (±10%)' : ' Vicine (±1,5%)'}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Istogramma GEX per strike">
        {/* griglia + etichette Y */}
        {ticksY.map((v, i) => {
          const y = geom!.yZero - (v / geom!.yMax) * geom!.half;
          return (
            <g key={i}>
              <line x1={M.left} x2={W - M.right} y1={y} y2={y} stroke="#1e293b" strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#64748b">{fmtMld(v)}</text>
            </g>
          );
        })}
        <line x1={M.left} x2={W - M.right} y1={geom!.yZero} y2={geom!.yZero} stroke="#475569" strokeWidth={0.8} />
        <text x={M.left - 6} y={geom!.yZero + 3} textAnchor="end" fontSize={9} fill="#94a3b8">0</text>

        {/* barre */}
        {bars.map(b => {
          const x = geom!.x(b.s) - geom!.bw / 2;
          const hPos = geom!.barTop(b.c);
          const yNeg = geom!.yZero;
          const hNeg = geom!.barBottom(b.p) - yNeg;
          return (
            <g key={b.s}>
              {b.c > 0 && (
                <rect x={x} y={hPos} width={geom!.bw} height={Math.max(0.5, geom!.yZero - hPos)} fill="#34d399" opacity={0.9}>
                  <title>{`Strike ${b.s.toFixed(0)} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`}</title>
                </rect>
              )}
              {b.p < 0 && (
                <rect x={x} y={yNeg} width={geom!.bw} height={Math.max(0.5, hNeg)} fill="#f87171" opacity={0.9}>
                  <title>{`Strike ${b.s.toFixed(0)} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`}</title>
                </rect>
              )}
            </g>
          );
        })}

        {/* linea spot */}
        {spot > 0 && geom!.x0 <= spot && spot <= geom!.x1 && (
          <g>
            <line x1={geom!.x(spot)} x2={geom!.x(spot)} y1={M.top - 4} y2={M.top + PLOT_H}
                  stroke="#60a5fa" strokeWidth={1.2} strokeDasharray="4 3" />
            <text x={geom!.x(spot)} y={M.top - 8} textAnchor="middle" fontSize={10} fontWeight="bold" fill="#60a5fa">Spot</text>
          </g>
        )}

        {/* etichette X */}
        {ticksX.map((s, i) => (
          <text key={i} x={geom!.x(s)} y={H - 8} textAnchor="middle" fontSize={9} fill="#64748b">
            {s.toFixed(0)}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-4 mt-1">
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-400" /> Call GEX
        </span>
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400" /> Put GEX
        </span>
        <span className="text-[10px] text-gray-500">
          strike in scala {idxName} (NQ) · passa il mouse sopra le barre per i valori
        </span>
      </div>
    </div>
  );
};
