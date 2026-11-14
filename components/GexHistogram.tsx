import React, { useMemo, useState } from 'react';

/**
 * GexHistogram — profilo GEX/OI per strike.
 *
 * FONTE SINGOLA (ETF o Indici): istogramma classico, una barra per strike,
 * verde = call (gamma lunga) / rosso = put (gamma corta), linee Spot/MP/Flip.
 *
 * FONTE 'ENTRAMBI': UN SOLO grafico SPECULARE sull'asse prezzi in scala
 * FUTURES — INDICI sopra l'asse, ETF sotto. I due libri NON si sommano: hanno
 * griglie di strike diverse (SPX ~5 pt, SPY $1 ≈ 10 pt su ES) e la somma su bin
 * comuni sfocava entrambi. Specchiati sullo stesso asse si confrontano a colpo
 * d'occhio: dove le due sagome si allineano, i due libri presidiano lo stesso
 * livello. Le bande viola ⧉ marcano le confluenze vere (muro ETF e muro indice
 * entro ±5 pt, dai top_gamma presi separatamente).
 *
 * Scala: ogni metà è normalizzata al PROPRIO massimo (il libro indice pesa ~5x
 * l'ETF: in scala comune l'ETF sarebbe invisibile). Il toggle "scala comune"
 * mostra le grandezze reali quando serve il confronto assoluto.
 */

/** Livello di riferimento della vista speculare: `src` dice a QUALE catena
 *  appartiene (idx = indici, etf = ETF, fut = prezzo del futures, comune). */
export interface TwinRef {
  price: number;
  kind: 'spot' | 'mp' | 'flip';
  src: 'fut' | 'etf' | 'idx';
  label: string;
}

export interface GexProfileEntry {
  s: number;
  c: number;
  p: number;
  co?: number;
  po?: number;
  native?: number;
  side?: 'call' | 'put';
}

/* ------------------------------------------------------------------ palette */
const C = {
  call: '#34d399', callDeep: '#059669',
  put: '#fb7185', putDeep: '#e11d48',
  idx: '#22d3ee', idxDeep: '#0891b2',      // metà INDICI
  etf: '#fbbf24', etfDeep: '#d97706',      // metà ETF
  conf: '#a78bfa', confDeep: '#7c3aed',    // confluenza
  spot: '#60a5fa', mp: '#fbbf24', flip: '#c084fc',
  grid: '#1e293b', axis: '#475569',
  ink: '#e6edf3', mute: '#64748b', soft: '#94a3b8',
  surface: '#0d1117', panel: '#0a0d12',
};

const WINDOWS = [
  { label: '±1,5%', pct: 0.015 },
  { label: '±5%', pct: 0.05 },
  { label: '±10%', pct: 0.10 },
  { label: '±20%', pct: 0.20 },
] as const;
const DEFAULT_WIN = 1;
const ZONE_TOL_PT = 5;

type Metric = 'gex' | 'oi';

const fmtMld = (v: number): string =>
  `${Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)}`;
const fmtVal = (v: number, m: Metric): string =>
  m === 'oi' ? Math.round(v).toLocaleString('it-IT') : `${fmtMld(v)} Mld`;
const fmtNat = (v: number): string =>
  (Math.round(v * 10) / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });
const fmtPrice = (v: number): string => Math.round(v).toLocaleString('it-IT');

/* --------------------------------------------------------------- geometry */
const W = 980, H = 474;
const M = { left: 74, right: 20, top: 44, bottom: 36 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
/** Fascia centrale che SEPARA le due metà: ospita le etichette dei livelli
 *  (Spot / Max Pain / Flip) con la fonte a cui appartengono. */
const GUTTER = 46;
const HALF_H = (PLOT_H - GUTTER) / 2;
const IDX_BASE = M.top + HALF_H;        // gli indici crescono verso l'alto da qui
const GUT_TOP = IDX_BASE;
const GUT_BOT = IDX_BASE + GUTTER;
const ETF_BASE = GUT_BOT;               // l'ETF cresce verso il basso da qui

/* single-source */
const SW = 960, SH = 340;
const SM = { left: 62, right: 18, top: 28, bottom: 28 };
const SPLOT_W = SW - SM.left - SM.right;
const SPLOT_H = SH - SM.top - SM.bottom;

const medianStep = (arr: Array<GexProfileEntry>): number => {
  const ss = [...new Set(arr.map(e => e.s))].sort((a, b) => a - b);
  const d: number[] = [];
  for (let i = 1; i < ss.length; i++) if (ss[i] - ss[i - 1] > 0.01) d.push(ss[i] - ss[i - 1]);
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
};

export const GexHistogram: React.FC<{
  profile: Array<GexProfileEntry> | undefined;
  spot: number;
  idxName: string;
  etfName?: string;
  maxPain?: number;
  flip?: number;
  futEq?: (s: number) => string;
  futName?: string;
  zoneEtf?: Array<GexProfileEntry>;
  zoneIdx?: Array<GexProfileEntry>;
  /** Vista 'Entrambi': profili GREZZI delle due fonti, già in scala futures. */
  twinEtf?: Array<GexProfileEntry>;
  twinIdx?: Array<GexProfileEntry>;
  etfRatio?: number;
  idxRatio?: number;
  /** Vista 'Entrambi': livelli di riferimento con la fonte esplicita. */
  twinRefs?: TwinRef[];
  strikeScale?: string;
}> = ({ profile, spot, idxName, etfName = 'ETF', maxPain, flip, futEq, futName = 'fut',
       zoneEtf, zoneIdx, twinEtf, twinIdx, etfRatio, idxRatio, twinRefs, strikeScale }) => {
  const [winIdx, setWinIdx] = useState(DEFAULT_WIN);
  const [metric, setMetric] = useState<Metric>('gex');
  const [view, setView] = useState<'split' | 'net'>('split');
  const [commonScale, setCommonScale] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; price: number } | null>(null);

  const mirror = !!(twinEtf?.length && twinIdx?.length);
  const val = (e: GexProfileEntry) => metric === 'gex' ? e.c + e.p : (e.co ?? 0) - (e.po ?? 0);

  /* ------------------------------------------------------- confluenze ⧉ */
  type Zone = { lo: number; hi: number; a: number; b: number; aS: number; bS: number };
  const zones = useMemo<Zone[]>(() => {
    if (!zoneEtf?.length || !zoneIdx?.length) return [];
    const raw: Zone[] = [];
    for (const e of zoneEtf) for (const i of zoneIdx) {
      const a = e.c + e.p, b = i.c + i.p;
      if (Math.abs(e.s - i.s) <= ZONE_TOL_PT)
        raw.push({ lo: Math.min(e.s, i.s), hi: Math.max(e.s, i.s), a, b, aS: e.s, bS: i.s });
    }
    const out: Zone[] = [];
    for (const z of raw.sort((p, q) => p.lo - q.lo)) {
      const cur = out[out.length - 1];
      if (cur && z.lo <= cur.hi) {
        cur.hi = Math.max(cur.hi, z.hi);
        if (Math.abs(z.a) > Math.abs(cur.a)) { cur.a = z.a; cur.aS = z.aS; }
        if (Math.abs(z.b) > Math.abs(cur.b)) { cur.b = z.b; cur.bS = z.bS; }
      } else out.push({ ...z });
    }
    return out.sort((p, q) => (Math.abs(q.a) + Math.abs(q.b)) - (Math.abs(p.a) + Math.abs(p.b)));
  }, [zoneEtf, zoneIdx]);

  const minGap = useMemo(() => {
    if (!zoneEtf?.length || !zoneIdx?.length) return null;
    let best = Infinity;
    for (const i of zoneIdx) for (const e of zoneEtf) best = Math.min(best, Math.abs(e.s - i.s));
    return best === Infinity ? null : Math.round(best);
  }, [zoneEtf, zoneIdx]);

  /* ------------------------------------------------- grafico speculare */
  const twin = useMemo(() => {
    if (!mirror || !(spot > 0)) return null;
    const pct = WINDOWS[winIdx].pct;
    const x0 = spot * (1 - pct), x1 = spot * (1 + pct);
    const inWin = (arr: Array<GexProfileEntry>) =>
      arr.filter(e => e.s >= x0 && e.s <= x1).sort((a, b) => a.s - b.s);
    const I = inWin(twinIdx!), E = inWin(twinEtf!);
    if (!I.length && !E.length) return null;
    const maxI = Math.max(1e-9, ...I.map(e => Math.abs(val(e))));
    const maxE = Math.max(1e-9, ...E.map(e => Math.abs(val(e))));
    const shared = Math.max(maxI, maxE);
    const scaleI = commonScale ? shared : maxI;
    const scaleE = commonScale ? shared : maxE;
    const x = (s: number) => M.left + ((s - x0) / (x1 - x0)) * PLOT_W;
    const bwOf = (arr: Array<GexProfileEntry>) => {
      const st = medianStep(arr) || (x1 - x0) / 60;
      return Math.max(1.1, Math.min(18, (st / (x1 - x0)) * PLOT_W * 0.74));
    };
    return { x0, x1, I, E, maxI, maxE, scaleI, scaleE, x, bwI: bwOf(I), bwE: bwOf(E) };
  }, [mirror, twinIdx, twinEtf, spot, winIdx, metric, commonScale]);

  const nearest = (arr: Array<GexProfileEntry>, price: number): GexProfileEntry | null => {
    if (!arr.length) return null;
    let best = arr[0];
    for (const e of arr) if (Math.abs(e.s - price) < Math.abs(best.s - price)) best = e;
    return best;
  };

  /* ------------------------------------------------- istogramma singolo */
  const bars = useMemo(() => {
    const arr = profile ?? [];
    const pct = WINDOWS[winIdx].pct;
    const lo = spot * (1 - pct), hi = spot * (1 + pct);
    return arr.filter(d => d.s >= lo && d.s <= hi).slice().sort((a, b) => a.s - b.s);
  }, [profile, winIdx, spot]);

  const hasOi = useMemo(() => bars.some(b => (b.co ?? 0) + (b.po ?? 0) > 0), [bars]);

  const geom = useMemo(() => {
    if (!bars.length) return null;
    const v = (b: GexProfileEntry): [number, number] => {
      if (metric === 'oi') {
        const co = b.co ?? 0, po = b.po ?? 0;
        return view === 'net' ? [Math.max(0, co - po), Math.min(0, co - po)] : [co, -po];
      }
      return view === 'net' ? [Math.max(0, b.c + b.p), Math.min(0, b.c + b.p)] : [b.c, b.p];
    };
    const vals = bars.map(v);
    const maxPos = Math.max(0, ...vals.map(t => t[0]));
    const maxNeg = Math.max(0, ...vals.map(t => -t[1]));
    if (maxPos + maxNeg === 0) return null;
    const yMax = Math.max(maxPos, maxNeg, metric === 'oi' ? 1 : 1e-9);
    const sMin = bars[0].s, sMax = bars[bars.length - 1].s;
    const pad = (sMax - sMin) * 0.01 || 1;
    const x0 = sMin - pad, x1 = sMax + pad;
    const half = SPLOT_H / 2, yZero = SM.top + half;
    const x = (s: number) => SM.left + ((s - x0) / (x1 - x0)) * SPLOT_W;
    const bw = Math.max(1.2, (SPLOT_W / bars.length) * 0.72);
    return { yMax, x, bw, yZero, half, x0, x1, val: v,
      barTop: (c: number) => yZero - (Math.min(c, yMax) / yMax) * half,
      barBottom: (p: number) => yZero + (Math.min(-p, yMax) / yMax) * half };
  }, [bars, metric, view]);

  const refLines = useMemo(() => {
    const defs = [
      { v: spot > 0 ? spot : undefined, label: 'Spot', color: C.spot, dash: '4 3' },
      { v: maxPain && maxPain > 0 ? maxPain : undefined, label: 'Max Pain', color: C.mp, dash: '6 3' },
      { v: flip && flip > 0 ? flip : undefined, label: 'Flip', color: C.flip, dash: '6 3' },
    ];
    if (mirror) {
      if (!twin) return [];
      return defs.filter(l => l.v !== undefined && twin.x0 <= l.v! && l.v! <= twin.x1);
    }
    if (!geom) return [];
    return defs.filter(l => l.v !== undefined && geom.x0 <= l.v! && l.v! <= geom.x1);
  }, [mirror, twin, geom, spot, maxPain, flip]);

  /* ------------------------------------------------------------- render */
  const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode; title?: string; accent?: string }> =
    ({ on, onClick, children, title, accent = '#0284c7' }) => (
      <button onClick={onClick} title={title}
        className="px-2.5 py-1 text-[10px] font-bold transition-all duration-150"
        style={on
          ? { background: accent, color: '#fff', boxShadow: `0 0 0 1px ${accent}, 0 2px 10px -2px ${accent}` }
          : { background: C.surface, color: C.soft }}>
        {children}
      </button>
    );

  const controls = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
        {(['gex', 'oi'] as const).map(m => (
          <Chip key={m} on={metric === m} onClick={() => setMetric(m)} accent="#0284c7"
            title={m === 'gex' ? 'Gamma Exposure in dollari (Mld)' : 'Open Interest in contratti'}>
            {m === 'gex' ? 'Γ GEX' : 'OI'}
          </Chip>
        ))}
      </div>
      {!mirror && (
        <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
          {(['split', 'net'] as const).map(v => (
            <Chip key={v} on={view === v} onClick={() => setView(v)} accent="#4f46e5"
              title={v === 'split' ? 'Call sopra / put sotto' : 'Una barra: netto call−put'}>
              {v === 'split' ? 'Call/Put' : 'Net'}
            </Chip>
          ))}
        </div>
      )}
      {mirror && (
        <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
          <Chip on={!commonScale} onClick={() => setCommonScale(false)} accent="#7c3aed"
            title="Ogni metà normalizzata al proprio massimo: le due sagome sono confrontabili nella forma">
            Scala propria
          </Chip>
          <Chip on={commonScale} onClick={() => setCommonScale(true)} accent="#7c3aed"
            title="Stessa scala per le due metà: mostra le grandezze reali (il libro indice pesa molto di più)">
            Scala comune
          </Chip>
        </div>
      )}
      <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
        {WINDOWS.map((w, i) => (
          <Chip key={w.label} on={winIdx === i} onClick={() => setWinIdx(i)} accent="#2563eb"
            title={`Strike entro ±${(w.pct * 100).toLocaleString('it-IT')}% dallo spot`}>
            {w.label}
          </Chip>
        ))}
      </div>
    </div>
  );

  if (!mirror && (!profile || profile.length === 0)) {
    return (
      <div>
        <div className="flex items-center justify-end mb-2">{controls}</div>
        <p className="text-[11px] text-gray-500 py-6 text-center">
          Profilo non disponibile per questa borsa/fonte in questo snapshot.
        </p>
      </div>
    );
  }

  /* ==================================================== MIRROR (Entrambi) */
  if (mirror) {
    if (!twin) {
      return (
        <div>
          <div className="flex items-center justify-end mb-2">{controls}</div>
          <p className="text-[11px] text-gray-500 py-6 text-center">
            Nessun profilo per questa finestra — allarga lo zoom o cambia borsa di scadenza.
          </p>
        </div>
      );
    }
    const { x0, x1, I, E, maxI, maxE, scaleI, scaleE, x, bwI, bwE } = twin;
    const hI = hover ? nearest(I, hover.price) : null;
    const hE = hover ? nearest(E, hover.price) : null;
    const ticks = Array.from({ length: 9 }, (_, i) => x0 + ((x1 - x0) * i) / 8);

    /* livelli di riferimento: ogni riga dice DA QUALE catena arriva (▲ indici,
       ▼ ETF, ● futures) e la sua linea vive nella METÀ di quella catena. */
    const kindColor = (k: TwinRef['kind']) => k === 'spot' ? C.spot : k === 'mp' ? C.mp : C.flip;
    const srcColor = (v: TwinRef['src']) => v === 'idx' ? C.idx : v === 'etf' ? C.etf : C.soft;
    const srcArrow = (v: TwinRef['src']) => v === 'idx' ? '▲' : v === 'etf' ? '▼' : '●';
    const rowY = [GUT_TOP + 12, GUT_TOP + 33];
    const chips = (twinRefs ?? [])
      .filter(r => r.price >= x0 && r.price <= x1)
      .map(r => {
        const txt = `${r.label} ${fmtPrice(r.price)}`;
        return { r, txt, w: txt.length * 5.35 + 24, cx: x(r.price), cx0: x(r.price), row: 0 };
      })
      .sort((a, b) => a.cx - b.cx);
    const endAt = [-Infinity, -Infinity];
    for (const c of chips) {
      let row = 0;
      if (c.cx - c.w / 2 < endAt[0] + 6) {
        row = 1;
        if (c.cx - c.w / 2 < endAt[1] + 6) c.cx = endAt[1] + 6 + c.w / 2;
      }
      c.row = row;
      c.cx = Math.min(Math.max(c.cx, M.left + c.w / 2), W - M.right - c.w / 2);
      endAt[row] = c.cx + c.w / 2;
    }
    const tipW = 250, tipH = 92;
    const tipX = hover ? Math.min(Math.max(hover.x + 14, M.left), W - M.right - tipW) : 0;
    const tipY = hover ? Math.min(Math.max(hover.y - tipH / 2, M.top), H - M.bottom - tipH) : 0;

    return (
      <div>
        <div className="flex items-start justify-between flex-wrap gap-2 mb-2">
          <div className="text-[10px] leading-relaxed max-w-[420px]">
            <span className="font-bold" style={{ color: C.idx }}>▲ {idxName}</span>
            <span className="text-gray-500"> sopra · </span>
            <span className="font-bold" style={{ color: C.etf }}>▼ {etfName}</span>
            <span className="text-gray-500">
              {' '}sotto — asse unico in punti {futName}, netto {metric === 'gex' ? 'GEX' : 'OI'} per strike.
              Dove le due sagome si allineano, i due libri presidiano lo stesso livello.
            </span>
          </div>
          {controls}
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-1.5 text-[10px]">
          {zones.length > 0 ? (
            <span className="font-extrabold px-2 py-0.5 rounded-md border"
              style={{ color: C.conf, borderColor: `${C.conf}55`, background: `${C.conf}14` }}>
              ⧉ {zones.length} confluenz{zones.length === 1 ? 'a' : 'e'}
            </span>
          ) : (
            <span className="font-bold text-gray-400 px-2 py-0.5 rounded-md border border-slate-800 bg-slate-900/40">
              ⧉ nessuna confluenza
            </span>
          )}
          <span className="text-gray-500">
            muro {etfName} e muro {idxName} entro ±{ZONE_TOL_PT} pt
            {minGap !== null && <> · distanza minima reale <b className="text-gray-300">{minGap} pt</b></>}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span style={{ color: C.idx }}>max {fmtVal(maxI, metric)}</span>
            <span style={{ color: C.etf }}>max {fmtVal(maxE, metric)}</span>
            {commonScale && <span className="text-gray-500">scala comune</span>}
          </span>
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img"
          aria-label={`Profilo speculare ${idxName} sopra e ${etfName} sotto, asse in punti ${futName}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const py = ((e.clientY - r.top) / r.height) * H;
            if (px < M.left || px > W - M.right) { setHover(null); return; }
            setHover({ x: px, y: py, price: x0 + ((px - M.left) / PLOT_W) * (x1 - x0) });
          }}
          onPointerLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="gCallUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={C.callDeep} /><stop offset="100%" stopColor={C.call} />
            </linearGradient>
            <linearGradient id="gPutUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={C.putDeep} /><stop offset="100%" stopColor={C.put} />
            </linearGradient>
            <linearGradient id="gCallDn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.callDeep} /><stop offset="100%" stopColor={C.call} />
            </linearGradient>
            <linearGradient id="gPutDn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.putDeep} /><stop offset="100%" stopColor={C.put} />
            </linearGradient>
            <linearGradient id="gIdxField" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.idx} stopOpacity="0.07" /><stop offset="100%" stopColor={C.idx} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gEtfField" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={C.etf} stopOpacity="0.07" /><stop offset="100%" stopColor={C.etf} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gSpine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={C.idx} stopOpacity="0.5" />
              <stop offset="50%" stopColor="#94a3b8" stopOpacity="0.85" />
              <stop offset="100%" stopColor={C.etf} stopOpacity="0.5" />
            </linearGradient>
            <linearGradient id="gGutter" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b1220" stopOpacity="0.95" />
              <stop offset="50%" stopColor="#111a2b" stopOpacity="0.98" />
              <stop offset="100%" stopColor="#0b1220" stopOpacity="0.95" />
            </linearGradient>
            <linearGradient id="gConf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.conf} stopOpacity="0.20" />
              <stop offset="50%" stopColor={C.confDeep} stopOpacity="0.10" />
              <stop offset="100%" stopColor={C.conf} stopOpacity="0.20" />
            </linearGradient>
          </defs>

          {/* campi delle due metà */}
          <rect x={M.left} y={M.top} width={PLOT_W} height={HALF_H} fill="url(#gIdxField)" />
          <rect x={M.left} y={ETF_BASE} width={PLOT_W} height={HALF_H} fill="url(#gEtfField)" />

          {/* griglia prezzi */}
          {ticks.map((s, i) => (
            <line key={i} x1={x(s)} x2={x(s)} y1={M.top} y2={H - M.bottom}
              stroke={C.grid} strokeWidth={0.6} strokeDasharray="2 5" opacity={0.7} />
          ))}
          {/* tacche di scala per metà */}
          {[0.5, 1].map(f => (
            <g key={`si${f}`}>
              <line x1={M.left} x2={W - M.right} y1={IDX_BASE - HALF_H * f} y2={IDX_BASE - HALF_H * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={M.left - 8} y={IDX_BASE - HALF_H * f + 3} textAnchor="end" fontSize={8.5} fill={C.idx} opacity={0.85}>
                {fmtVal(scaleI * f, metric)}
              </text>
              <line x1={M.left} x2={W - M.right} y1={ETF_BASE + HALF_H * f} y2={ETF_BASE + HALF_H * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={M.left - 8} y={ETF_BASE + HALF_H * f + 3} textAnchor="end" fontSize={8.5} fill={C.etf} opacity={0.85}>
                {fmtVal(scaleE * f, metric)}
              </text>
            </g>
          ))}

          {/* bande di confluenza: attraversano ENTRAMBE le metà */}
          {zones.map((z, i) => {
            const zx1 = x(z.lo - ZONE_TOL_PT / 2), zx2 = x(z.hi + ZONE_TOL_PT / 2);
            if (zx2 < M.left || zx1 > W - M.right) return null;
            const cx1 = Math.max(M.left, zx1), cx2 = Math.min(W - M.right, zx2);
            const w = Math.max(4, cx2 - cx1), mid = (cx1 + cx2) / 2;
            const both = z.a > 0 && z.b > 0 ? 'call' : z.a < 0 && z.b < 0 ? 'put' : 'misti';
            return (
              <g key={`z${i}`}>
                <rect x={cx1} y={M.top} width={w} height={PLOT_H} fill="url(#gConf)" />
                <line x1={cx1} x2={cx1} y1={M.top} y2={H - M.bottom} stroke={C.conf} strokeWidth={1} opacity={0.6} strokeDasharray="3 3" />
                <line x1={cx2} x2={cx2} y1={M.top} y2={H - M.bottom} stroke={C.conf} strokeWidth={1} opacity={0.6} strokeDasharray="3 3" />
                <rect x={mid - 26} y={M.top - 17} width={52} height={15} rx={4} fill={C.panel} stroke={C.conf} strokeWidth={1} />
                <text x={mid} y={M.top - 6} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={C.conf}>
                  ⧉ {fmtPrice((z.lo + z.hi) / 2)}
                </text>
                <title>{`Confluenza ⧉ ${fmtPrice(z.lo)}–${fmtPrice(z.hi)} ${futName} · lato ${both}\n${idxName} ${fmtPrice(z.bS)}: ${fmtVal(z.b, metric)}\n${etfName} ${fmtPrice(z.aS)}: ${fmtVal(z.a, metric)}`}</title>
              </g>
            );
          })}

          {/* INDICI: barre verso l'ALTO */}
          {I.map(e => {
            const v = val(e);
            if (!v) return null;
            const h = Math.max(0.8, (Math.abs(v) / scaleI) * HALF_H);
            return (
              <rect key={`i${e.s}`} x={x(e.s) - bwI / 2} y={IDX_BASE - h} width={bwI} height={h}
                fill={v >= 0 ? 'url(#gCallUp)' : 'url(#gPutUp)'} opacity={0.92} rx={0.6} />
            );
          })}
          {/* ETF: barre verso il BASSO (speculari) */}
          {E.map(e => {
            const v = val(e);
            if (!v) return null;
            const h = Math.max(0.8, (Math.abs(v) / scaleE) * HALF_H);
            return (
              <rect key={`e${e.s}`} x={x(e.s) - bwE / 2} y={ETF_BASE} width={bwE} height={h}
                fill={v >= 0 ? 'url(#gCallDn)' : 'url(#gPutDn)'} opacity={0.92} rx={0.6} />
            );
          })}

          {/* FASCIA CENTRALE: separa le due metà e ospita le etichette dei livelli */}
          <rect x={M.left} y={GUT_TOP} width={PLOT_W} height={GUTTER} fill="url(#gGutter)" />
          <line x1={M.left} x2={W - M.right} y1={IDX_BASE} y2={IDX_BASE} stroke="url(#gSpine)" strokeWidth={1.4} />
          <line x1={M.left} x2={W - M.right} y1={ETF_BASE} y2={ETF_BASE} stroke="url(#gSpine)" strokeWidth={1.4} />
          <text x={M.left - 8} y={IDX_BASE + 3} textAnchor="end" fontSize={9} fill={C.idx} opacity={0.9}>0</text>
          <text x={M.left - 8} y={ETF_BASE + 3} textAnchor="end" fontSize={9} fill={C.etf} opacity={0.9}>0</text>

          {/* identità delle due metà */}
          <g>
            <rect x={M.left + 6} y={M.top + 4} width={104} height={17} rx={4} fill={C.panel} stroke={`${C.idx}66`} />
            <text x={M.left + 12} y={M.top + 16} fontSize={9.5} fontWeight="bold" fill={C.idx}>▲ INDICI · {idxName}</text>
            <rect x={M.left + 6} y={H - M.bottom - 21} width={92} height={17} rx={4} fill={C.panel} stroke={`${C.etf}66`} />
            <text x={M.left + 12} y={H - M.bottom - 9} fontSize={9.5} fontWeight="bold" fill={C.etf}>▼ ETF · {etfName}</text>
          </g>

          {/* livelli di riferimento: linea nella METÀ della propria catena +
              etichetta nella fascia centrale che dice fonte e prezzo */}
          {chips.map((c, i) => {
            const kc = kindColor(c.r.kind), sc = srcColor(c.r.src);
            const lx = c.cx0, cy = rowY[c.row];
            const y1 = c.r.src === 'etf' ? cy + 9 : M.top - 2;
            const y2 = c.r.src === 'idx' ? cy - 9 : H - M.bottom + 2;
            return (
              <g key={`r${i}`}>
                <line x1={lx} x2={lx} y1={y1} y2={y2} stroke={kc} strokeWidth={1.2}
                  strokeDasharray={c.r.kind === 'spot' ? '4 3' : '6 3'} opacity={0.85} />
                <circle cx={lx} cy={c.r.src === 'idx' ? IDX_BASE : c.r.src === 'etf' ? ETF_BASE : cy}
                  r={2.6} fill={kc} opacity={0.95} />
                {Math.abs(c.cx - lx) > 3 && (
                  <line x1={c.cx} x2={lx} y1={cy} y2={c.r.src === 'idx' ? IDX_BASE : ETF_BASE}
                    stroke={kc} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.6} />
                )}
                <rect x={c.cx - c.w / 2} y={cy - 8.5} width={c.w} height={17} rx={5}
                  fill={C.panel} fillOpacity={0.98} stroke={kc} strokeWidth={1} strokeOpacity={0.85} />
                <text x={c.cx - c.w / 2 + 7} y={cy + 3.5} fontSize={9.5} fontWeight="bold">
                  <tspan fill={sc}>{srcArrow(c.r.src)} </tspan>
                  <tspan fill={kc}>{c.txt}</tspan>
                </text>
                <title>{`${c.r.label} ${fmtPrice(c.r.price)} ${futName} — ${
                  c.r.src === 'idx' ? `catena INDICI (${idxName}), metà superiore`
                  : c.r.src === 'etf' ? `catena ETF (${etfName}), metà inferiore`
                  : `prezzo live del futures ${futName}, comune alle due metà`}`}</title>
              </g>
            );
          })}

          {/* asse X: prezzi in punti futures */}
          {ticks.map((s, i) => (
            <text key={`t${i}`} x={x(s)} y={H - 6} textAnchor="middle" fontSize={9} fill={C.mute}>
              {fmtPrice(s)}
            </text>
          ))}
          <text x={W - M.right} y={M.top - 24} textAnchor="end" fontSize={9} fill={C.mute}>
            asse: punti {futName}
          </text>

          {/* crosshair + tooltip comparativo */}
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={M.top} y2={H - M.bottom}
                stroke="#e6edf3" strokeWidth={0.8} strokeDasharray="2 3" opacity={0.55} />
              {hI && Math.abs(hI.s - hover.price) < (x1 - x0) * 0.06 && (
                <circle cx={x(hI.s)} cy={IDX_BASE - Math.max(0.8, (Math.abs(val(hI)) / scaleI) * HALF_H)}
                  r={3} fill={val(hI) >= 0 ? C.call : C.put} stroke={C.panel} strokeWidth={1} />
              )}
              {hE && Math.abs(hE.s - hover.price) < (x1 - x0) * 0.06 && (
                <circle cx={x(hE.s)} cy={ETF_BASE + Math.max(0.8, (Math.abs(val(hE)) / scaleE) * HALF_H)}
                  r={3} fill={val(hE) >= 0 ? C.call : C.put} stroke={C.panel} strokeWidth={1} />
              )}
              <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={7}
                fill={C.panel} fillOpacity={0.97} stroke="#334155" />
              <text x={tipX + 12} y={tipY + 19} fontSize={11} fontWeight="bold" fill={C.ink}>
                {futName} {fmtPrice(hover.price)}
              </text>
              <line x1={tipX + 12} x2={tipX + tipW - 12} y1={tipY + 27} y2={tipY + 27} stroke="#1e293b" />
              <text x={tipX + 12} y={tipY + 44} fontSize={9.5} fontWeight="bold" fill={C.idx}>▲ {idxName}</text>
              <text x={tipX + 62} y={tipY + 44} fontSize={9.5} fill={C.soft}>
                {hI ? `${idxRatio ? fmtNat(hI.s / idxRatio) : fmtPrice(hI.s)} → ${futName} ${fmtPrice(hI.s)}` : '—'}
              </text>
              <text x={tipX + tipW - 12} y={tipY + 44} textAnchor="end" fontSize={10} fontWeight="bold"
                fill={hI ? (val(hI) >= 0 ? C.call : C.put) : C.mute}>
                {hI ? fmtVal(val(hI), metric) : '—'}
              </text>
              <text x={tipX + 12} y={tipY + 66} fontSize={9.5} fontWeight="bold" fill={C.etf}>▼ {etfName}</text>
              <text x={tipX + 62} y={tipY + 66} fontSize={9.5} fill={C.soft}>
                {hE ? `${etfRatio ? fmtNat(hE.s / etfRatio) : fmtPrice(hE.s)} → ${futName} ${fmtPrice(hE.s)}` : '—'}
              </text>
              <text x={tipX + tipW - 12} y={tipY + 66} textAnchor="end" fontSize={10} fontWeight="bold"
                fill={hE ? (val(hE) >= 0 ? C.call : C.put) : C.mute}>
                {hE ? fmtVal(val(hE), metric) : '—'}
              </text>
              <text x={tipX + 12} y={tipY + 84} fontSize={8.5} fill={C.mute}>
                {hI && hE
                  ? `distanza fra i due strike: ${Math.round(Math.abs(hI.s - hE.s))} pt${Math.abs(hI.s - hE.s) <= ZONE_TOL_PT ? ' · ⧉ stesso livello' : ''}`
                  : 'strike più vicino per ciascuna fonte'}
              </text>
            </g>
          )}
        </svg>

        <div className="flex items-center gap-4 mt-1.5 flex-wrap text-[10px]">
          <span className="flex items-center gap-1.5 text-gray-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.call }} /> call · gamma lunga (pin)
          </span>
          <span className="flex items-center gap-1.5 text-gray-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.put }} /> put · gamma corta (trigger)
          </span>
          <span className="flex items-center gap-1.5 text-gray-400">
            <span className="inline-block w-3 h-2.5 rounded-sm border" style={{ background: `${C.conf}30`, borderColor: C.conf }} /> confluenza ⧉
          </span>
          <span className="flex items-center gap-2 text-gray-500">
            <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.spot }} /> ● Spot futures</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.mp }} /> Max Pain</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.flip }} /> Flip</span>
          </span>
          <span className="text-gray-500">
            nella fascia centrale: <b style={{ color: C.idx }}>▲</b> livello della catena {idxName} ·{' '}
            <b style={{ color: C.etf }}>▼</b> livello della catena {etfName}
          </span>
          <span className="text-gray-600 ml-auto">passa il mouse: valori delle due fonti a confronto</span>
        </div>
      </div>
    );
  }

  /* ================================================= FONTE SINGOLA */
  const fmtY = (v: number) => (metric === 'oi' ? Math.round(v).toLocaleString('it-IT') : `${fmtMld(v)} Mld`);
  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[10px] text-gray-500">
          {metric === 'gex'
            ? view === 'net'
              ? 'Net GEX per strike (call−put) · sopra zero gamma lunga, sotto gamma corta · Mld $'
              : 'GEX per strike · Mld $ · verde = call (gamma lunga) · rosso = put (gamma corta)'
            : view === 'net' ? 'Net OI per strike (call−put) · contratti'
              : 'Open Interest per strike · contratti · verde = call · rosso = put'}
        </span>
        {controls}
      </div>

      {metric === 'oi' && !hasOi ? (
        <p className="text-[11px] text-gray-500 py-6 text-center">
          Open Interest non disponibile in questo snapshot — torna alla metrica Γ GEX.
        </p>
      ) : geom ? (
        <svg viewBox={`0 0 ${SW} ${SH}`} className="w-full" role="img" aria-label="Istogramma per strike">
          {[0.25, 0.5, 0.75, 1].map((f, i) => {
            const v = geom.yMax * f, y = geom.yZero - (v / geom.yMax) * geom.half;
            return (
              <g key={i}>
                <line x1={SM.left} x2={SW - SM.right} y1={y} y2={y} stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
                <text x={SM.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill={C.mute}>{fmtY(v)}</text>
              </g>
            );
          })}
          <line x1={SM.left} x2={SW - SM.right} y1={geom.yZero} y2={geom.yZero} stroke={C.axis} strokeWidth={0.8} />
          <text x={SM.left - 6} y={geom.yZero + 3} textAnchor="end" fontSize={9} fill={C.soft}>0</text>

          {bars.map(b => {
            const [cVal, pVal] = geom.val(b);
            const bx = geom.x(b.s) - geom.bw / 2;
            const yTop = geom.barTop(cVal);
            const hBot = geom.barBottom(pVal) - geom.yZero;
            const eq = futEq?.(b.s) ?? '';
            const tip = metric === 'gex'
              ? `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call ${b.c.toFixed(2)} Mld · put ${b.p.toFixed(2)} Mld`
              : `Strike ${strikeScale ?? idxName} ${b.s.toFixed(0)}${eq ? ` · ${eq}` : ''} — call OI ${(b.co ?? 0).toLocaleString('it-IT')} · put OI ${(b.po ?? 0).toLocaleString('it-IT')}`;
            return (
              <g key={b.s}>
                {cVal > 0 && <rect x={bx} y={yTop} width={geom.bw} height={Math.max(0.5, geom.yZero - yTop)} fill={C.call} opacity={0.9}><title>{tip}</title></rect>}
                {pVal < 0 && <rect x={bx} y={geom.yZero} width={geom.bw} height={Math.max(0.5, hBot)} fill={C.put} opacity={0.9}><title>{tip}</title></rect>}
              </g>
            );
          })}

          {refLines.map(l => (
            <g key={l.label}>
              <line x1={geom.x(l.v!)} x2={geom.x(l.v!)} y1={SM.top - 4} y2={SM.top + SPLOT_H}
                stroke={l.color} strokeWidth={1.2} strokeDasharray={l.dash} />
              <text x={geom.x(l.v!)} y={SM.top - 8} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={l.color}>{l.label}</text>
            </g>
          ))}
          {Array.from({ length: 7 }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / 6).map((s, i) => (
            <text key={i} x={geom.x(s)} y={SH - 8} textAnchor="middle" fontSize={9} fill={C.mute}>{s.toFixed(0)}</text>
          ))}
        </svg>
      ) : (
        <p className="text-[11px] text-gray-500 py-6 text-center">Nessun dato per questo perimetro.</p>
      )}

      <div className="flex items-center gap-4 mt-1 flex-wrap">
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.call }} />
          {view === 'net' ? 'Net ≥ 0 (call-dominato)' : `Call ${metric === 'oi' ? 'OI' : 'GEX'}`}
        </span>
        <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.put }} />
          {view === 'net' ? 'Net ≤ 0 (put-dominato)' : `Put ${metric === 'oi' ? 'OI' : 'GEX'}`}
        </span>
        <span className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.spot }} /> Spot</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.mp }} /> Max Pain</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.flip }} /> Flip</span>
        </span>
        <span className="text-[10px] text-gray-500">
          strike in scala {strikeScale ?? idxName} · doppio prezzo nel tooltip: {futName} ↔ nativo
        </span>
      </div>
    </div>
  );
};
