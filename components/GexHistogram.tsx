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
/** Finestre di zoom (limitano SOLO l'asse X): il profilo pubblicato è già
 *  per-strike raw in scala nativa della fonte — nessuna aggregazione client,
 *  così ogni barra è uno strike reale e il confronto 1:1 con InsiderFinance
 *  è diretto. */
const WINDOWS = [
  { label: 'Vicine ±1,5%', pct: 0.015 },
  { label: '±5%', pct: 0.05 },
  { label: '±10%', pct: 0.10 },
  { label: 'Tutte ±20%', pct: 0.20 },
] as const;
const DEFAULT_WIN = 1; // ±5%

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
  /** DOPPIO PREZZO nel tooltip: strike della vista → segmento con le altre
   *  scale, es. "≈ ES 7670 · SPX 7646" (vista ETF, strike nativi) oppure
   *  "SPX 7646 · SPY 762" (vista indici/'Entrambi', strike in scala futures).
   *  Il padre decide le conversioni in base alla fonte; assente = nessun incrocio. */
  futEq?: (s: number) => string;
  /** Nome dei futures (ES/NQ) per i testi e la legenda. */
  futName?: string;
  /** Solo vista 'Entrambi': i due profili _binned SEPARATI, già in scala
   *  futures. Servono a rilevare le ZONE DI CONFLUENZA (muro del libro ETF +
   *  muro del libro indice entro una tolleranza). I muri delle due fonti
   *  quasi mai cadono sullo stesso strike (misurato 14/11 su NQ: 0 su 8, si
   *  alternano a 25-50 pt), quindi sommare i valori produce un profilo
   *  sfocato: la confluenza va cercata per ZONA. */
  profileEtf?: Array<GexProfileEntry>;
  profileIdx?: Array<GexProfileEntry>;
  /** Tolleranza zona in % dello spot (default 0,20%: su NQ ~57 pt). */
  zoneTolPct?: number;
  /** Muro = |net| >= wallPct% del massimo della PROPRIA fonte (default 20%). */
  wallPct?: number;
  /** Scala dello strike dell'asse X: nel profilo ETF gli strike sono nativi
   *  (SPY/QQQ), nel profilo indici e 'Entrambi' sono in punti futures (ES/NQ).
   *  Va ETICHETTATA nel tooltip e nel footer: lo stesso numero senza scala
   *  fa scambiare NQ per NDX (il libro indice è in NDX ma il profilo è
   *  già convertito). Default: idxName. */
  strikeScale?: string;
}> = ({ profile, spot, idxName, maxPain, flip, futEq, futName, strikeScale,
       profileEtf, profileIdx, zoneTolPct = 0.2, wallPct = 20 }) => {
  const [winIdx, setWinIdx] = useState(DEFAULT_WIN);
  const [metric, setMetric] = useState<Metric>('gex');
  const [view, setView] = useState<'split' | 'net'>('split');

  // ---- ZONE DI CONFLUENZA (solo quando arrivano ENTRAMBI i profili).
  // Muro = |net| >= wallPct% del massimo della PROPRIA fonte (soglia relativa:
  // le due fonti hanno scale diverse — su ES il libro indice pesa 5x l'ETF —
  // così entrambe contribuiscono con un numero confrontabile di muri).
  // Zona = muro ETF e muro indice a distanza <= zoneTolPct% dello spot,
  // con le zone sovrapposte fuse fra loro.
  type Zone = { lo: number; hi: number; a: number; b: number };
  const zones = useMemo<Zone[]>(() => {
    const A = profileEtf, B = profileIdx;
    if (!A?.length || !B?.length || !(spot > 0)) return [];
    const tol = (spot * zoneTolPct) / 100;
    const wallFrac = wallPct / 100;
    const val = (e: GexProfileEntry) =>
      metric === 'oi' ? (e.co ?? 0) - (e.po ?? 0) : e.c + e.p;
    const wallsOf = (arr: Array<GexProfileEntry>): Array<[number, number]> => {
      const m = new Map<number, number>();
      for (const e of arr) m.set(e.s, (m.get(e.s) ?? 0) + val(e));
      let mx = 0;
      for (const v of m.values()) mx = Math.max(mx, Math.abs(v));
      if (mx <= 0) return [];
      return [...m.entries()].filter(([, v]) => Math.abs(v) >= mx * wallFrac);
    };
    const wa = wallsOf(A), wb = wallsOf(B);
    if (!wa.length || !wb.length) return [];
    const iv: Zone[] = [];
    for (const [sa, va] of wa)
      for (const [sb, vb] of wb)
        if (Math.abs(sa - sb) <= tol)
          iv.push({ lo: Math.min(sa, sb), hi: Math.max(sa, sb), a: va, b: vb });
    if (!iv.length) return [];
    iv.sort((p, q) => p.lo - q.lo);
    const out: Zone[] = [];
    let cur: Zone = { ...iv[0] };
    for (let i = 1; i < iv.length; i++) {
      const z = iv[i];
      if (z.lo <= cur.hi + tol) {
        cur.hi = Math.max(cur.hi, z.hi);
        if (Math.abs(z.a) > Math.abs(cur.a)) cur.a = z.a;
        if (Math.abs(z.b) > Math.abs(cur.b)) cur.b = z.b;
      } else { out.push(cur); cur = { ...z }; }
    }
    out.push(cur);
    return out.sort((p, q) => (Math.abs(q.a) + Math.abs(q.b)) - (Math.abs(p.a) + Math.abs(p.b)));
  }, [profileEtf, profileIdx, spot, metric, zoneTolPct, wallPct]);
  const bothMode = !!profileEtf?.length && !!profileIdx?.length;

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
                title={`Strike entro ±${(w.pct * 100).toLocaleString('it-IT')}%`}>
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

          {/* ZONE DI CONFLUENZA (vista Entrambi): banda verticale sulla zona,
              colore = verso concordato dei due libri. Disegnate PRIMA delle
              barre così restano leggibili sopra. */}
          {zones.map((z, i) => {
            const x1 = geom.x(z.lo), x2 = geom.x(z.hi);
            const col = z.a < 0 && z.b < 0 ? '#f87171' : z.a > 0 && z.b > 0 ? '#34d399' : '#fbbf24';
            const lbl = z.a < 0 && z.b < 0 ? 'put condiviso' : z.a > 0 && z.b > 0 ? 'call condiviso' : 'segni discordi';
            return (
              <g key={`zona-${i}`}>
                <rect x={Math.min(x1, x2)} y={M.top} width={Math.max(2, Math.abs(x2 - x1))} height={PLOT_H}
                      fill={col} opacity={0.18}>
                  <title>{`Zona confluenza ${z.lo.toFixed(0)}–${z.hi.toFixed(0)} (${lbl}) — muro ETF ${z.a.toFixed(1)} · muro indice ${z.b.toFixed(1)}`}</title>
                </rect>
                <text x={(x1 + x2) / 2} y={M.top + 9} textAnchor="middle" fontSize={10} fontWeight="bold" fill={col}>
                  ◆
                </text>
              </g>
            );
          })}

          {bars.map(b => {
            const [cVal, pVal] = geom.val(b);
            const x = geom.x(b.s) - geom.bw / 2;
            const yTop = geom.barTop(cVal);
            const hBot = geom.barBottom(pVal) - geom.yZero;
            // DOPPIO PREZZO: il strike della vista + le scale corrispondenti
            // (futures ↔ nativo) secondo la fonte, calcolate dal padre.
            const eq = futEq?.(b.s) ?? '';
            const tip = metric === 'gex'
              ? `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`
              : `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call OI ${(b.co ?? 0).toLocaleString('it-IT')} · put OI ${(b.po ?? 0).toLocaleString('it-IT')}`;
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
        {bothMode && (
          <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400/25 border border-amber-400" />
            zona confluenza ETF+indice ({zones.length}) — muri dei due libri entro {zoneTolPct.toLocaleString('it-IT')}% dallo spot
          </span>
        )}
        <span className="text-[10px] text-gray-500">
          strike in scala {strikeScale ?? idxName} · doppio prezzo nel tooltip: {futName ?? 'futures'} ↔ nativo · passa il mouse sopra le barre per i valori
        </span>
      </div>
    </div>
  );
};
