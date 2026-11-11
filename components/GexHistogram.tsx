import React, { useMemo, useState } from 'react';

/**
 * GexHistogram — istogramma Strike Profile alla InsiderFinance:
 * una barra per strike, verde sopra lo zero = lato CALL, rossa sotto =
 * lato PUT, linea tratteggiata sullo spot. Toggle All (±10%) / Near
 * (±1,5%) e selettore METRICA: Γ GEX (gamma dollari) o OI (open interest).
 * Tutti gli strike della borsa selezionata, non solo i top-4.
 *
 * I valori GEX arrivano dal piano in Mld (miliardi $) — la stessa
 * convenzione delle etichette della scala (⧉ Call wall 15 Mld...).
 *
 * @module components/GexHistogram
 */

export interface GexProfileEntry {
  s: number;
  c: number;
  p: number;
  /** Open interest call/put dello strike (dal 05/11). */
  co?: number;
  po?: number;
}

const W = 900, H = 300;
const M = { left: 56, right: 16, top: 26, bottom: 26 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
/** Finestre di zoom: ognuna con il suo bin di aggregazione — binBase dipende
 *  dalla scala del profilo (25 pt futuri per indici/'Entrambi', 5 pt nativi
 *  SPY/QQQ per la fonte ETF) × fattore di zoom. Ogni vista resta leggibile. */
const WINDOWS = [
  { label: 'Vicine ±1,5%', pct: 0.015, k: 1 },
  { label: '±5%', pct: 0.05, k: 2 },
  { label: '±10%', pct: 0.10, k: 5 },
  { label: 'Tutte ±20%', pct: 0.20, k: 10 },
] as const;

type Metric = 'gex' | 'oi';

const fmtMld = (v: number): string =>
  `${Math.abs(v) >= 1 ? v.toFixed(Math.abs(v) >= 10 ? 0 : 1) : v.toFixed(2)} Mld`;

const fmtOi = (v: number): string => Math.round(v).toLocaleString('it-IT');

export const GexHistogram: React.FC<{
  profile: Array<GexProfileEntry> | undefined;
  spot: number;
  idxName: string;
  /** Linee di riferimento in scala NQ: max pain e flip gamma della fonte selezionata. */
  maxPain?: number;
  flip?: number;
  /** Granularità naturale del profilo (25 pt futuri per indici/'Entrambi',
   *  5 pt nativi SPY/QQQ per la fonte ETF). Moltiplicata per il fattore di
   *  zoom della finestra selezionata. Default 25. */
  binBase?: number;
}> = ({ profile, spot, idxName, maxPain, flip, binBase = 25 }) => {
  const [winIdx, setWinIdx] = useState(1); // default ±5%
  const [metric, setMetric] = useState<Metric>('gex');
  const [view, setView] = useState<'split' | 'net'>('split');

  const bars = useMemo(() => {
    const arr = profile ?? [];
    const win = WINDOWS[winIdx];
    const bin = binBase * win.k;
    const lo = spot * (1 - win.pct), hi = spot * (1 + win.pct);
    const inWin = arr.filter(d => d.s >= lo && d.s <= hi);
    const merged = new Map<number, { s: number; c: number; p: number; co: number; po: number }>();
    for (const e of inWin) {
      const z = Math.round(e.s / bin) * bin;
      const cur = merged.get(z) ?? { s: z, c: 0, p: 0, co: 0, po: 0 };
      cur.c += e.c;
      cur.p += e.p;
      cur.co += e.co ?? 0;
      cur.po += e.po ?? 0;
      merged.set(z, cur);
    }
    return [...merged.values()].sort((a, b) => a.s - b.s);
  }, [profile, winIdx, spot, binBase]);

  const hasOi = useMemo(() => bars.some(b => (b.co ?? 0) + (b.po ?? 0) > 0), [bars]);

  const geom = useMemo(() => {
    if (!bars.length) return null;
    const val = (b: GexProfileEntry): [number, number] => {
      if (metric === 'oi') {
        const co = b.co ?? 0, po = b.po ?? 0;
        return view === 'net'
          ? [Math.max(0, co - po), Math.min(0, co - po)]
          : [co, -po];
      }
      return view === 'net'
        ? [Math.max(0, b.c + b.p), Math.min(0, b.c + b.p)]
        : [b.c, b.p];
    };
    const vals = bars.map(val);
    const maxPos = Math.max(0, ...vals.map(v => v[0]));
    const maxNeg = Math.max(0, ...vals.map(v => -v[1]));
    if (maxPos + maxNeg === 0) return null;
    const yMax = Math.max(maxPos, maxNeg, metric === 'oi' ? 1 : 1e-9);
    const sMin = bars[0].s, sMax = bars[bars.length - 1].s;
    const pad = (sMax - sMin) * 0.01 || 1;
    const x0 = sMin - pad, x1 = sMax + pad;
    const half = PLOT_H / 2;
    const yZero = M.top + half;
    const x = (s: number) => M.left + ((s - x0) / (x1 - x0)) * PLOT_W;
    const bw = Math.max(1.2, (PLOT_W / bars.length) * 0.72);
    return { yMax, x, bw, yZero, half, x0, x1,
      barTop: (c: number) => yZero - (Math.min(c, yMax) / yMax) * half,
      barBottom: (p: number) => yZero + (Math.min(-p, yMax) / yMax) * half,
      val };
  }, [bars, metric, view]);

  const refLines = useMemo(() => {
    const defs = [
      { v: spot > 0 ? spot : undefined, label: 'Spot', color: '#60a5fa', dash: '4 3' },
      { v: maxPain && maxPain > 0 ? maxPain : undefined, label: 'Max Pain', color: '#fbbf24', dash: '6 3' },
      { v: flip && flip > 0 ? flip : undefined, label: 'Flip', color: '#c084fc', dash: '6 3' },
    ];
    if (!geom) return [];
    return defs.filter(l => l.v !== undefined && geom.x0 <= l.v && l.v <= geom.x1);
  }, [geom, spot, maxPain, flip]);

  if (!profile || profile.length === 0) {
    return (
      <p className="text-[11px] text-gray-500 py-3">
        Profilo non disponibile per questa borsa/fonte in questo snapshot.
      </p>
    );
  }

  const fmtY = (v: number) => (metric === 'oi' ? fmtOi(v) : fmtMld(v));
  const emptyMetric = metric === 'oi' && !hasOi;
  const ticksY = geom
    ? [0.25, 0.5, 0.75, 1].map(f => geom.yMax * f)
    : [];
  const ticksX = geom
    ? Array.from({ length: 7 }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / 6)
    : [];

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[10px] text-gray-500">
          {metric === 'gex'
            ? view === 'net'
              ? 'Net GEX per strike (call−put) · sopra zero gamma lunga, sotto gamma corta · Mld $'
              : 'GEX per strike · valori in Mld $ · verde = call (gamma lunga) · rossa = put (gamma corta)'
            : view === 'net'
              ? 'Net OI per strike (call−put) · sopra zero call-dominato, sotto put-dominato · contratti'
              : 'Open Interest per strike · contratti · verde = call · rossa = put'}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
            {(['gex', 'oi'] as const).map(m => (
              <button key={m} onClick={() => setMetric(m)}
                className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${metric === m ? 'bg-sky-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}
                title={m === 'gex' ? 'Gamma Exposure in dollari (Mld)' : 'Open Interest in contratti'}>
                {m === 'gex' ? 'Γ GEX' : 'OI'}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
            {(['split', 'net'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${view === v ? 'bg-indigo-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}
                title={v === 'split' ? 'Due barre: lato call (verde) e lato put (rosso)' : 'Una barra per strike: netto call−put (verde sopra = call-dominato, rosso sotto = put-dominato)'}>
                {v === 'split' ? 'Call/Put' : 'Net'}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
            {WINDOWS.map((w, i) => (
              <button key={w.label} onClick={() => setWinIdx(i)}
                className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${winIdx === i ? 'bg-blue-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}
                title={`Strike entro ±${(w.pct * 100).toLocaleString('it-IT')}%${binBase * w.k > 5 ? `, aggregati in bin da ${binBase * w.k} pt` : ''}`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {emptyMetric ? (
        <p className="text-[11px] text-gray-500 py-6 text-center">
          Open Interest non disponibile in questo snapshot (piano precedente al 05/11) —
          attendi il prossimo giro del pipeline o torna alla metrica Γ GEX.
        </p>
      ) : geom ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Istogramma per strike">
          {ticksY.map((v, i) => {
            const y = geom.yZero - (v / geom.yMax) * geom.half;
            return (
              <g key={i}>
                <line x1={M.left} x2={W - M.right} y1={y} y2={y} stroke="#1e293b" strokeWidth={0.6} strokeDasharray="3 4" />
                <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#64748b">{fmtY(v)}</text>
              </g>
            );
          })}
          <line x1={M.left} x2={W - M.right} y1={geom.yZero} y2={geom.yZero} stroke="#475569" strokeWidth={0.8} />
          <text x={M.left - 6} y={geom.yZero + 3} textAnchor="end" fontSize={9} fill="#94a3b8">0</text>

          {bars.map(b => {
            const [cVal, pVal] = geom.val(b);
            const x = geom.x(b.s) - geom.bw / 2;
            const yTop = geom.barTop(cVal);
            const hBot = geom.barBottom(pVal) - geom.yZero;
            const tip = metric === 'gex'
              ? `Strike ${b.s.toFixed(0)} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`
              : `Strike ${b.s.toFixed(0)} — call OI ${(b.co ?? 0).toLocaleString('it-IT')} · put OI ${(b.po ?? 0).toLocaleString('it-IT')}`;
            return (
              <g key={b.s}>
                {cVal > 0 && (
                  <rect x={x} y={yTop} width={geom.bw} height={Math.max(0.5, geom.yZero - yTop)} fill="#34d399" opacity={0.9}>
                    <title>{tip}</title>
                  </rect>
                )}
                {pVal < 0 && (
                  <rect x={x} y={geom.yZero} width={geom.bw} height={Math.max(0.5, hBot)} fill="#f87171" opacity={0.9}>
                    <title>{tip}</title>
                  </rect>
                )}
              </g>
            );
          })}

          {/* linee di riferimento: spot, max pain, flip */}
          {refLines.map((l, i) => (
            <g key={l.label}>
              <line x1={geom.x(l.v!)} x2={geom.x(l.v!)} y1={M.top - 4} y2={M.top + PLOT_H}
                    stroke={l.color} strokeWidth={1.2} strokeDasharray={l.dash} />
              <text x={geom.x(l.v!)} y={M.top - 8} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={l.color}>
                {l.label}
              </text>
            </g>
          ))}

          {ticksX.map((s, i) => (
            <text key={i} x={geom.x(s)} y={H - 8} textAnchor="middle" fontSize={9} fill="#64748b">
              {s.toFixed(0)}
            </text>
          ))}
        </svg>
      ) : (
        <p className="text-[11px] text-gray-500 py-6 text-center">Nessun dato per questo perimetro.</p>
      )}

      <div className="flex items-center gap-4 mt-1">
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-400" />
          {view === 'net' ? 'Net ≥ 0 (call-dominato)' : `Call ${metric === 'oi' ? 'OI' : 'GEX'}`}
        </span>
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400" />
          {view === 'net' ? 'Net ≤ 0 (put-dominato)' : `Put ${metric === 'oi' ? 'OI' : 'GEX'}`}
        </span>
        <span className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-400" /> Spot</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-amber-400" /> Max Pain</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-purple-400" /> Flip</span>
        </span>
        <span className="text-[10px] text-gray-500">
          strike in scala {idxName} (NQ) · passa il mouse sopra le barre per i valori
        </span>
      </div>
    </div>
  );
};
