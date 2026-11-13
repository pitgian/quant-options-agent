import React, { useMemo, useState } from 'react';

/**
 * GexHistogram — istogramma Strike Profile alla InsiderFinance: una barra
 * verticale per strike, verde sopra lo zero = lato CALL (gamma lunga), rossa
 * sotto = lato PUT (gamma corta), linee Spot/MaxPain/Flip.
 *
 * MODALITÀ 'Entrambi': le barre sono la SOMMA dei due libri per strike sulla
 * griglia bin 25pt in scala futures (l'unica griglia su cui ETF e indice
 * condividono gli strike — la prepara DayView in profileSel). SOPRA le barre
 * vengono disegnate le BANDE DI CONFLUENZA: un muro della catena ETF e uno
 * della catena indice entro ±ZONE_TOL_PT sullo stesso prezzo futures.
 *
 * Le confluenze si calcolano sui top_gamma del piano (GEX aggregato per
 * strike, picchi veri), NON sui profili per strike: il rumore dei profili
 * grezzi inventava muri. E la tolleranza è 5 pt, la griglia operativa: con
 * 25 pt (valore vecchio) SPY 750→ES 7545 e SPX 7500→ES 7525 — due livelli
 * DISTINTI a 20 pt — venivano spacciati per confluenza.
 */

export interface GexProfileEntry {
  s: number;
  c: number;
  p: number;
  co?: number;
  po?: number;
}

const W = 960, H = 340;
const M = { left: 60, right: 16, top: 28, bottom: 28 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

/** Confluenza = muro ETF e muro indice entro questa distanza (pt futures). */
const ZONE_TOL_PT = 5;

const WINDOWS = [
  { label: 'Vicine ±1,5%', pct: 0.015 },
  { label: '±5%', pct: 0.05 },
  { label: '±10%', pct: 0.10 },
  { label: 'Tutte ±20%', pct: 0.20 },
] as const;
const DEFAULT_WIN = 1;

type Metric = 'gex' | 'oi';

const fmtMld = (v: number): string =>
  `${Math.abs(v) >= 1 ? v.toFixed(Math.abs(v) >= 10 ? 0 : 1) : v.toFixed(2)} Mld`;
const fmtOi = (v: number): string => Math.round(v).toLocaleString('it-IT');

export const GexHistogram: React.FC<{
  profile: Array<GexProfileEntry> | undefined;
  spot: number;
  idxName: string;
  etfName?: string;
  maxPain?: number;
  flip?: number;
  futEq?: (s: number) => string;
  futName?: string;
  /** Vista 'Entrambi': i MURI delle due fonti in scala futures (top_gamma). */
  zoneEtf?: Array<GexProfileEntry>;
  zoneIdx?: Array<GexProfileEntry>;
  strikeScale?: string;
}> = ({ profile, spot, idxName, etfName = 'ETF', maxPain, flip, futEq, futName,
       zoneEtf, zoneIdx, strikeScale }) => {
  const [winIdx, setWinIdx] = useState(DEFAULT_WIN);
  const [metric, setMetric] = useState<Metric>('gex');
  const [view, setView] = useState<'split' | 'net'>('split');

  const bothMode = !!zoneEtf?.length && !!zoneIdx?.length;

  // =========================================================== CONFLUENZE
  type Zone = { lo: number; hi: number; a: number; b: number; aS: number; bS: number };

  const zones = useMemo<Zone[]>(() => {
    if (!bothMode) return [];
    const gex = (e: GexProfileEntry) => e.c + e.p;
    const walls = (arr: Array<GexProfileEntry>) => arr.map(e => [e.s, gex(e)] as [number, number]);
    const wa = walls(zoneEtf!), wb = walls(zoneIdx!);
    const out: Zone[] = [];
    for (const [sa, va] of wa)
      for (const [sb, vb] of wb)
        if (Math.abs(sa - sb) <= ZONE_TOL_PT)
          out.push({ lo: Math.min(sa, sb), hi: Math.max(sa, sb), a: va, b: vb, aS: sa, bS: sb });
    // coppie che condividono lo stesso muro (7665↔7660 e 7665↔7670): una banda sola
    const fused: Zone[] = [];
    for (const z of out.sort((p, q) => p.lo - q.lo)) {
      const cur = fused[fused.length - 1];
      if (cur && z.lo <= cur.hi) {
        cur.hi = Math.max(cur.hi, z.hi);
        if (Math.abs(z.a) > Math.abs(cur.a)) { cur.a = z.a; cur.aS = z.aS; }
        if (Math.abs(z.b) > Math.abs(cur.b)) { cur.b = z.b; cur.bS = z.bS; }
      } else fused.push({ ...z });
    }
    return fused.sort((p, q) => (Math.abs(q.a) + Math.abs(q.b)) - (Math.abs(p.a) + Math.abs(p.b)));
  }, [zoneEtf, zoneIdx, bothMode]);

  // Quanto distano DAVVERO i due libri: il numero da mostrare quando le
  // confluenze sono zero (è un dato, non un guasto).
  const minGap = useMemo(() => {
    if (!bothMode) return null;
    const e = zoneEtf!.map(w => w.s), i = zoneIdx!.map(w => w.s);
    let best = Infinity;
    for (const s of i) for (const t of e) best = Math.min(best, Math.abs(s - t));
    return best === Infinity ? null : Math.round(best);
  }, [zoneEtf, zoneIdx, bothMode]);

  // ============================================================== ISTOGRAMMA
  const bars = useMemo(() => {
    const arr = profile ?? [];
    const win = WINDOWS[winIdx];
    const lo = spot * (1 - win.pct), hi = spot * (1 + win.pct);
    return arr.filter(d => d.s >= lo && d.s <= hi).slice().sort((a, b) => a.s - b.s);
  }, [profile, winIdx, spot]);

  const hasOi = useMemo(() => bars.some(b => (b.co ?? 0) + (b.po ?? 0) > 0), [bars]);

  const geom = useMemo(() => {
    if (!bars.length) return null;
    const val = (b: GexProfileEntry): [number, number] => {
      if (metric === 'oi') {
        const co = b.co ?? 0, po = b.po ?? 0;
        return view === 'net' ? [Math.max(0, co - po), Math.min(0, co - po)] : [co, -po];
      }
      return view === 'net' ? [Math.max(0, b.c + b.p), Math.min(0, b.c + b.p)] : [b.c, b.p];
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
    return { yMax, x, bw, yZero, half, x0, x1, val,
      barTop: (c: number) => yZero - (Math.min(c, yMax) / yMax) * half,
      barBottom: (p: number) => yZero + (Math.min(-p, yMax) / yMax) * half };
  }, [bars, metric, view]);

  const refLines = useMemo(() => {
    if (!geom) return [];
    return [
      { v: spot > 0 ? spot : undefined, label: 'Spot', color: '#60a5fa', dash: '4 3' },
      { v: maxPain && maxPain > 0 ? maxPain : undefined, label: 'Max Pain', color: '#fbbf24', dash: '6 3' },
      { v: flip && flip > 0 ? flip : undefined, label: 'Flip', color: '#c084fc', dash: '6 3' },
    ].filter(l => l.v !== undefined && geom.x0 <= l.v! && l.v! <= geom.x1);
  }, [geom, spot, maxPain, flip]);

  if (!profile || profile.length === 0) {
    return (
      <p className="text-[11px] text-gray-500 py-3">
        Profilo non disponibile per questa borsa/fonte in questo snapshot.
      </p>
    );
  }

  const fmtY = (v: number) => (metric === 'oi' ? fmtOi(v) : fmtMld(v));

  return (
    <div>
      {/* ---------------------------------------------------------- header */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[10px] text-gray-500 leading-relaxed">
          {bothMode
            ? <>barre = <b className="text-gray-400">somma ETF+indice</b> per strike (griglia 25pt scala futures)
                {' '}· bande viola = <b className="text-gray-400">confluenza ⧉</b>: muro {etfName} e muro {idxName} entro ±{ZONE_TOL_PT} pt</>
            : metric === 'gex'
              ? view === 'net'
                ? 'Net GEX per strike (call−put) · sopra zero gamma lunga, sotto gamma corta · Mld $'
                : 'GEX per strike · Mld $ · verde = call (gamma lunga) · rosso = put (gamma corta)'
              : view === 'net'
                ? 'Net OI per strike (call−put) · contratti'
                : 'Open Interest per strike · contratti · verde = call · rosso = put'}
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
                title={v === 'split' ? 'Due barre per strike: call (verde) e put (rosso)' : 'Una barra per strike: netto call−put'}>
                {v === 'split' ? 'Call/Put' : 'Net'}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
            {WINDOWS.map((w, i) => (
              <button key={w.label} onClick={() => setWinIdx(i)}
                className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${winIdx === i ? 'bg-blue-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}
                title={`Strike entro ±${(w.pct * 100).toLocaleString('it-IT')}%`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* riepilogo confluenze (solo Entrambi) */}
      {bothMode && (
        <p className="text-[10px] mb-1 leading-relaxed">
          {zones.length > 0 ? (
            <span className="font-bold text-violet-300">⧉ {zones.length} confluenz{zones.length === 1 ? 'a' : 'e'}</span>
          ) : (
            <span className="font-bold text-gray-300">⧉ nessuna confluenza</span>
          )}
          <span className="text-gray-500">
            {' '}fra i muri {etfName} e {idxName} in questa finestra
            {minGap !== null && <> · i muri più vicini fra le due fonti distano <b className="text-gray-300">{minGap} pt</b></>}
            {zones.length === 0 && <> — sono due livelli distinti, non uno confermato due volte</>}
          </span>
        </p>
      )}

      {metric === 'oi' && !hasOi ? (
        <p className="text-[11px] text-gray-500 py-6 text-center">
          Open Interest non disponibile in questo snapshot — torna alla metrica Γ GEX.
        </p>
      ) : geom ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Istogramma per strike">
          {/* griglia Y */}
          {[0.25, 0.5, 0.75, 1].map((f, i) => {
            const v = geom.yMax * f;
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

          {/* bande di confluenza SOTTO le barre: si leggono entrambe */}
          {bothMode && zones.map((z, i) => {
            const x1 = geom.x(z.lo - ZONE_TOL_PT / 2), x2 = geom.x(z.hi + ZONE_TOL_PT / 2);
            const w = Math.max(5, x2 - x1);
            const cx = (x1 + x2) / 2;
            const tipo = z.a > 0 && z.b > 0 ? 'call' : z.a < 0 && z.b < 0 ? 'put' : 'misti';
            return (
              <g key={`z${i}`}>
                <rect x={x1} y={M.top - 2} width={w} height={PLOT_H + 4} fill="#8b5cf6" opacity={0.13}>
                  <title>{`Confluenza ⧉ ${Math.round(z.lo)}–${Math.round(z.hi)} ${futName}\n` +
                    `${etfName} ${Math.round(z.aS)}: ${fmtMld(z.a)}\n` +
                    `${idxName} ${Math.round(z.bS)}: ${fmtMld(z.b)}\n` +
                    `entrambi lato ${tipo} — due libri indipendenti sullo stesso livello`}</title>
                </rect>
                <line x1={x1} x2={x1} y1={M.top - 2} y2={M.top + PLOT_H + 2} stroke="#8b5cf6" strokeWidth={1} opacity={0.55} strokeDasharray="3 3" />
                <line x1={x2} x2={x2} y1={M.top - 2} y2={M.top + PLOT_H + 2} stroke="#8b5cf6" strokeWidth={1} opacity={0.55} strokeDasharray="3 3" />
                <text x={cx} y={M.top + 10} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#c4b5fd">
                  ⧉ {Math.round((z.lo + z.hi) / 2)}
                </text>
              </g>
            );
          })}

          {/* barre per strike */}
          {bars.map(b => {
            const [cVal, pVal] = geom.val(b);
            const x = geom.x(b.s) - geom.bw / 2;
            const yTop = geom.barTop(cVal);
            const hBot = geom.barBottom(pVal) - geom.yZero;
            const eq = futEq?.(b.s) ?? '';
            const tip = metric === 'gex'
              ? `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`
              : `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call OI ${(b.co ?? 0).toLocaleString('it-IT')} · put OI ${(b.po ?? 0).toLocaleString('it-IT')}`;
            return (
              <g key={b.s}>
                {cVal > 0 && (
                  <rect x={x} y={yTop} width={geom.bw} height={Math.max(0.5, geom.yZero - yTop)}
                        fill="#34d399" opacity={0.9}><title>{tip}</title></rect>
                )}
                {pVal < 0 && (
                  <rect x={x} y={geom.yZero} width={geom.bw} height={Math.max(0.5, hBot)}
                        fill="#f87171" opacity={0.9}><title>{tip}</title></rect>
                )}
              </g>
            );
          })}

          {/* linee di riferimento */}
          {refLines.map(l => (
            <g key={l.label}>
              <line x1={geom.x(l.v!)} x2={geom.x(l.v!)} y1={M.top - 4} y2={M.top + PLOT_H}
                    stroke={l.color} strokeWidth={1.2} strokeDasharray={l.dash} />
              <text x={geom.x(l.v!)} y={M.top - 8} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={l.color}>
                {l.label}
              </text>
            </g>
          ))}

          {/* asse X */}
          {Array.from({ length: 7 }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / 6).map((s, i) => (
            <text key={i} x={geom.x(s)} y={H - 8} textAnchor="middle" fontSize={9} fill="#64748b">
              {s.toFixed(0)}
            </text>
          ))}
        </svg>
      ) : (
        <p className="text-[11px] text-gray-500 py-6 text-center">Nessun dato per questo perimetro.</p>
      )}

      {/* --------------------------------------------------------- legenda */}
      <div className="flex items-center gap-4 mt-1 flex-wrap">
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
          {bothMode && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-2.5 rounded-sm bg-violet-500/25 border border-violet-500/60" /> confluenza ⧉ (±{ZONE_TOL_PT} pt)
            </span>
          )}
        </span>
        <span className="text-[10px] text-gray-500">
          strike in scala {strikeScale ?? idxName} · doppio prezzo nel tooltip: {futName ?? 'futures'} ↔ nativo
        </span>
      </div>
    </div>
  );
};
