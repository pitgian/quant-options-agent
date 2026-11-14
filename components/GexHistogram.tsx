import React, { useEffect, useMemo, useRef, useState } from 'react';

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
  /** Fonte della vista singola: governa conversioni e identità del grafico. */
  singleSrc?: 'etf' | 'index';
  strikeScale?: string;
}> = ({ profile, spot, idxName, etfName = 'ETF', maxPain, flip, futEq, futName = 'fut',
       zoneEtf, zoneIdx, twinEtf, twinIdx, etfRatio, idxRatio, twinRefs, singleSrc = 'etf', strikeScale }) => {
  const [winIdx, setWinIdx] = useState(DEFAULT_WIN);
  const [metric, setMetric] = useState<Metric>('gex');
  const [view, setView] = useState<'split' | 'net'>('split');
  const [commonScale, setCommonScale] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; price: number } | null>(null);
  const [hoverS, setHoverS] = useState<{ x: number; y: number; s: number } | null>(null);

  /* Layout RESPONSIVE: il viewBox coincide con i pixel del contenitore, così
     i testi restano da 9-10 px reali anche su telefono (con un viewBox fisso
     da 980 unità, a 350 px di larghezza il testo diventava di 3 px). */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(960);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setBoxW(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = useMemo(() => {
    const compact = boxW < 700;
    const W = boxW, SW = boxW;
    const M = { left: compact ? 44 : 74, right: compact ? 12 : 20, top: compact ? 50 : 44, bottom: compact ? 30 : 36 };
    const SM = { left: compact ? 44 : 74, right: compact ? 12 : 20, top: compact ? 62 : 58, bottom: compact ? 30 : 36 };
    const GUTTER = compact ? 66 : 46;
    const H = compact ? 430 : 474;
    const SH = compact ? 400 : 430;
    const PLOT_W = W - M.left - M.right;
    const PLOT_H = H - M.top - M.bottom;
    const HALF_H = (PLOT_H - GUTTER) / 2;
    const IDX_BASE = M.top + HALF_H;
    const SPLOT_W = SW - SM.left - SM.right;
    const SPLOT_H = SH - SM.top - SM.bottom;
    return { compact, W, H, M, PLOT_W, PLOT_H, GUTTER, HALF_H,
      IDX_BASE, GUT_TOP: IDX_BASE, GUT_BOT: IDX_BASE + GUTTER, ETF_BASE: IDX_BASE + GUTTER,
      SW, SH, SM, SPLOT_W, SPLOT_H, S_ZERO: SM.top + SPLOT_H / 2, S_HALF: SPLOT_H / 2 - 6,
      tickN: compact ? 5 : 9, chipRows: compact ? 3 : 2, font: compact ? 9 : 9.5 };
  }, [boxW]);

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
    const x = (s: number) => L.M.left + ((s - x0) / (x1 - x0)) * L.PLOT_W;
    const bwOf = (arr: Array<GexProfileEntry>) => {
      const st = medianStep(arr) || (x1 - x0) / 60;
      return Math.max(1.1, Math.min(18, (st / (x1 - x0)) * L.PLOT_W * 0.74));
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
    const pct = WINDOWS[winIdx].pct;
    const x0 = spot * (1 - pct), x1 = spot * (1 + pct);
    const x = (s: number) => L.SM.left + ((s - x0) / (x1 - x0)) * L.SPLOT_W;
    const st = medianStep(bars) || (x1 - x0) / 60;
    const bw = Math.max(1.1, Math.min(18, (st / (x1 - x0)) * L.SPLOT_W * 0.74));
    return { yMax, x, bw, yZero: L.S_ZERO, half: L.S_HALF, x0, x1, val: v,
      barTop: (c: number) => L.S_ZERO - (Math.min(c, yMax) / yMax) * L.S_HALF,
      barBottom: (p: number) => L.S_ZERO + (Math.min(-p, yMax) / yMax) * L.S_HALF };
  }, [bars, metric, view, winIdx, spot]);

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
      <div ref={wrapRef}>
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
        <div ref={wrapRef}>
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
    const ticks = Array.from({ length: L.tickN }, (_, i) => x0 + ((x1 - x0) * i) / (L.tickN - 1));

    /* livelli di riferimento: ogni riga dice DA QUALE catena arriva (▲ indici,
       ▼ ETF, ● futures) e la sua linea vive nella METÀ di quella catena. */
    const kindColor = (k: TwinRef['kind']) => k === 'spot' ? C.spot : k === 'mp' ? C.mp : C.flip;
    const srcColor = (v: TwinRef['src']) => v === 'idx' ? C.idx : v === 'etf' ? C.etf : C.soft;
    const srcArrow = (v: TwinRef['src']) => v === 'idx' ? '▲' : v === 'etf' ? '▼' : '●';
    const rowY = Array.from({ length: L.chipRows }, (_, i) => L.GUT_TOP + 12 + i * 21);
    const chips = (twinRefs ?? [])
      .filter(r => r.price >= x0 && r.price <= x1)
      .map(r => {
        const txt = `${L.compact ? r.label.split(' ')[0] : r.label} ${fmtPrice(r.price)}`;
        return { r, txt, w: txt.length * 5.35 + 22, cx: x(r.price), cx0: x(r.price), row: 0 };
      })
      .sort((a, b) => a.cx - b.cx);
    const endAt = new Array(L.chipRows).fill(-Infinity);
    for (const c of chips) {
      c.cx = Math.min(Math.max(c.cx, L.M.left + c.w / 2), L.W - L.M.right - c.w / 2);
      let row = -1;
      for (let k = 0; k < L.chipRows; k++) if (c.cx - c.w / 2 >= endAt[k] + 6) { row = k; break; }
      if (row < 0) {
        row = endAt.indexOf(Math.min(...endAt));
        c.cx = endAt[row] + 6 + c.w / 2;
      }
      c.row = row;
      endAt[row] = c.cx + c.w / 2;
    }
    const tipW = Math.min(250, L.PLOT_W - 8), tipH = 92;
    const tipX = hover ? Math.min(Math.max(hover.x + 14, L.M.left), L.W - L.M.right - tipW) : 0;
    const tipY = hover ? Math.min(Math.max(hover.y - tipH / 2, L.M.top), L.H - L.M.bottom - tipH) : 0;

    return (
      <div ref={wrapRef}>
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

        <svg viewBox={`0 0 ${L.W} ${L.H}`} className="w-full select-none" role="img"
          aria-label={`Profilo speculare ${idxName} sopra e ${etfName} sotto, asse in punti ${futName}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * L.W;
            const py = ((e.clientY - r.top) / r.height) * L.H;
            if (px < L.M.left || px > L.W - L.M.right) { setHover(null); return; }
            setHover({ x: px, y: py, price: x0 + ((px - L.M.left) / L.PLOT_W) * (x1 - x0) });
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
          <rect x={L.M.left} y={L.M.top} width={L.PLOT_W} height={L.HALF_H} fill="url(#gIdxField)" />
          <rect x={L.M.left} y={L.ETF_BASE} width={L.PLOT_W} height={L.HALF_H} fill="url(#gEtfField)" />

          {/* griglia prezzi */}
          {ticks.map((s, i) => (
            <line key={i} x1={x(s)} x2={x(s)} y1={L.M.top} y2={L.H - L.M.bottom}
              stroke={C.grid} strokeWidth={0.6} strokeDasharray="2 5" opacity={0.7} />
          ))}
          {/* tacche di scala per metà */}
          {[0.5, 1].map(f => (
            <g key={`si${f}`}>
              <line x1={L.M.left} x2={L.W - L.M.right} y1={L.IDX_BASE - L.HALF_H * f} y2={L.IDX_BASE - L.HALF_H * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={L.M.left - 8} y={L.IDX_BASE - L.HALF_H * f + 3} textAnchor="end" fontSize={8.5} fill={C.idx} opacity={0.85}>
                {fmtVal(scaleI * f, metric)}
              </text>
              <line x1={L.M.left} x2={L.W - L.M.right} y1={L.ETF_BASE + L.HALF_H * f} y2={L.ETF_BASE + L.HALF_H * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={L.M.left - 8} y={L.ETF_BASE + L.HALF_H * f + 3} textAnchor="end" fontSize={8.5} fill={C.etf} opacity={0.85}>
                {fmtVal(scaleE * f, metric)}
              </text>
            </g>
          ))}

          {/* bande di confluenza: attraversano ENTRAMBE le metà */}
          {zones.map((z, i) => {
            const zx1 = x(z.lo - ZONE_TOL_PT / 2), zx2 = x(z.hi + ZONE_TOL_PT / 2);
            if (zx2 < L.M.left || zx1 > L.W - L.M.right) return null;
            const cx1 = Math.max(L.M.left, zx1), cx2 = Math.min(L.W - L.M.right, zx2);
            const w = Math.max(4, cx2 - cx1), mid = (cx1 + cx2) / 2;
            const both = z.a > 0 && z.b > 0 ? 'call' : z.a < 0 && z.b < 0 ? 'put' : 'misti';
            return (
              <g key={`z${i}`}>
                <rect x={cx1} y={L.M.top} width={w} height={L.PLOT_H} fill="url(#gConf)" />
                <line x1={cx1} x2={cx1} y1={L.M.top} y2={L.H - L.M.bottom} stroke={C.conf} strokeWidth={1} opacity={0.6} strokeDasharray="3 3" />
                <line x1={cx2} x2={cx2} y1={L.M.top} y2={L.H - L.M.bottom} stroke={C.conf} strokeWidth={1} opacity={0.6} strokeDasharray="3 3" />
                <rect x={mid - 26} y={L.M.top - 17} width={52} height={15} rx={4} fill={C.panel} stroke={C.conf} strokeWidth={1} />
                <text x={mid} y={L.M.top - 6} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={C.conf}>
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
            const h = Math.max(0.8, (Math.abs(v) / scaleI) * L.HALF_H);
            return (
              <rect key={`i${e.s}`} x={x(e.s) - bwI / 2} y={L.IDX_BASE - h} width={bwI} height={h}
                fill={v >= 0 ? 'url(#gCallUp)' : 'url(#gPutUp)'} opacity={0.92} rx={0.6} />
            );
          })}
          {/* ETF: barre verso il BASSO (speculari) */}
          {E.map(e => {
            const v = val(e);
            if (!v) return null;
            const h = Math.max(0.8, (Math.abs(v) / scaleE) * L.HALF_H);
            return (
              <rect key={`e${e.s}`} x={x(e.s) - bwE / 2} y={L.ETF_BASE} width={bwE} height={h}
                fill={v >= 0 ? 'url(#gCallDn)' : 'url(#gPutDn)'} opacity={0.92} rx={0.6} />
            );
          })}

          {/* FASCIA CENTRALE: separa le due metà e ospita le etichette dei livelli */}
          <rect x={L.M.left} y={L.GUT_TOP} width={L.PLOT_W} height={L.GUTTER} fill="url(#gGutter)" />
          <line x1={L.M.left} x2={L.W - L.M.right} y1={L.IDX_BASE} y2={L.IDX_BASE} stroke="url(#gSpine)" strokeWidth={1.4} />
          <line x1={L.M.left} x2={L.W - L.M.right} y1={L.ETF_BASE} y2={L.ETF_BASE} stroke="url(#gSpine)" strokeWidth={1.4} />
          <text x={L.M.left - 8} y={L.IDX_BASE + 3} textAnchor="end" fontSize={9} fill={C.idx} opacity={0.9}>0</text>
          <text x={L.M.left - 8} y={L.ETF_BASE + 3} textAnchor="end" fontSize={9} fill={C.etf} opacity={0.9}>0</text>

          {/* identità delle due metà */}
          <g>
            <rect x={L.M.left + 6} y={L.M.top + 4} width={104} height={17} rx={4} fill={C.panel} stroke={`${C.idx}66`} />
            <text x={L.M.left + 12} y={L.M.top + 16} fontSize={9.5} fontWeight="bold" fill={C.idx}>▲ INDICI · {idxName}</text>
            <rect x={L.M.left + 6} y={L.H - L.M.bottom - 21} width={92} height={17} rx={4} fill={C.panel} stroke={`${C.etf}66`} />
            <text x={L.M.left + 12} y={L.H - L.M.bottom - 9} fontSize={9.5} fontWeight="bold" fill={C.etf}>▼ ETF · {etfName}</text>
          </g>

          {/* livelli di riferimento: linea nella METÀ della propria catena +
              etichetta nella fascia centrale che dice fonte e prezzo */}
          {chips.map((c, i) => {
            const kc = kindColor(c.r.kind), sc = srcColor(c.r.src);
            const lx = c.cx0, cy = rowY[c.row];
            const y1 = c.r.src === 'etf' ? cy + 9 : L.M.top - 2;
            const y2 = c.r.src === 'idx' ? cy - 9 : L.H - L.M.bottom + 2;
            return (
              <g key={`r${i}`}>
                <line x1={lx} x2={lx} y1={y1} y2={y2} stroke={kc} strokeWidth={1.2}
                  strokeDasharray={c.r.kind === 'spot' ? '4 3' : '6 3'} opacity={0.85} />
                <circle cx={lx} cy={c.r.src === 'idx' ? L.IDX_BASE : c.r.src === 'etf' ? L.ETF_BASE : cy}
                  r={2.6} fill={kc} opacity={0.95} />
                {Math.abs(c.cx - lx) > 3 && (
                  <line x1={c.cx} x2={lx} y1={cy} y2={c.r.src === 'idx' ? L.IDX_BASE : L.ETF_BASE}
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
            <text key={`t${i}`} x={x(s)} y={L.H - 6} textAnchor="middle" fontSize={9} fill={C.mute}>
              {fmtPrice(s)}
            </text>
          ))}
          <text x={L.W - L.M.right} y={L.M.top - 24} textAnchor="end" fontSize={9} fill={C.mute}>
            asse: punti {futName}
          </text>

          {/* crosshair + tooltip comparativo */}
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={L.M.top} y2={L.H - L.M.bottom}
                stroke="#e6edf3" strokeWidth={0.8} strokeDasharray="2 3" opacity={0.55} />
              {hI && Math.abs(hI.s - hover.price) < (x1 - x0) * 0.06 && (
                <circle cx={x(hI.s)} cy={L.IDX_BASE - Math.max(0.8, (Math.abs(val(hI)) / scaleI) * L.HALF_H)}
                  r={3} fill={val(hI) >= 0 ? C.call : C.put} stroke={C.panel} strokeWidth={1} />
              )}
              {hE && Math.abs(hE.s - hover.price) < (x1 - x0) * 0.06 && (
                <circle cx={x(hE.s)} cy={L.ETF_BASE + Math.max(0.8, (Math.abs(val(hE)) / scaleE) * L.HALF_H)}
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
  const srcName = singleSrc === 'etf' ? etfName : idxName;
  const srcCol = singleSrc === 'etf' ? C.etf : C.idx;
  const srcArrow = singleSrc === 'etf' ? '▼' : '▲';
  const fmtY = (v: number) => (metric === 'oi' ? Math.round(v).toLocaleString('it-IT') : `${fmtMld(v)} Mld`);
  const natOf = (v: number) => singleSrc === 'etf' ? v : (idxRatio ? v / idxRatio : v);
  const futOf = (v: number) => singleSrc === 'etf' ? (etfRatio ? v * etfRatio : v) : v;

  /* corsia dei livelli: Spot / Max Pain / Flip della fonte attiva */
  const sRefs = geom ? ([
    { price: spot, kind: 'spot' as const, label: `Spot ${srcName}` },
    { price: maxPain ?? 0, kind: 'mp' as const, label: `MP ${srcName}` },
    { price: flip ?? 0, kind: 'flip' as const, label: `Flip ${srcName}` },
  ]).filter(r => r.price > 0 && r.price >= geom.x0 && r.price <= geom.x1)
    .map(r => {
      const txt = `${L.compact ? r.label.split(' ')[0] : r.label} ${singleSrc === 'etf' ? fmtNat(r.price) : fmtPrice(r.price)}`;
      return { ...r, txt, w: txt.length * 5.35 + 22, cx: geom.x(r.price), cx0: geom.x(r.price), row: 0 };
    }).sort((p, q) => p.cx - q.cx) : [];
  {
    const endAt = new Array(L.chipRows).fill(-Infinity);
    for (const c of sRefs) {
      c.cx = Math.min(Math.max(c.cx, L.SM.left + c.w / 2), L.SW - L.SM.right - c.w / 2);
      let row = -1;
      for (let k = 0; k < L.chipRows; k++) if (c.cx - c.w / 2 >= endAt[k] + 6) { row = k; break; }
      if (row < 0) {
        row = endAt.indexOf(Math.min(...endAt));
        c.cx = endAt[row] + 6 + c.w / 2;
      }
      c.row = row;
      endAt[row] = c.cx + c.w / 2;
    }
  }
  const sRowY = Array.from({ length: L.chipRows }, (_, i) => 16 + i * 21);
  const hBar = hoverS && geom ? bars.reduce<null | GexProfileEntry>((best, b) =>
    !best || Math.abs(b.s - hoverS.s) < Math.abs(best.s - hoverS.s) ? b : best, null) : null;
  const sTipW = Math.min(236, L.SPLOT_W - 8), sTipH = 104;
  const sTipX = hoverS ? Math.min(Math.max(hoverS.x + 14, L.SM.left), L.SW - L.SM.right - sTipW) : 0;
  const sTipY = hoverS ? Math.min(Math.max(hoverS.y - sTipH / 2, L.SM.top), L.SH - L.SM.bottom - sTipH) : 0;
  const sTicks = geom ? Array.from({ length: L.tickN }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / (L.tickN - 1)) : [];

  return (
    <div ref={wrapRef}>
      <div className="flex items-start justify-between flex-wrap gap-2 mb-2">
        <div className="text-[10px] leading-relaxed max-w-[430px]">
          <span className="font-bold" style={{ color: srcCol }}>{srcArrow} {srcName}</span>
          <span className="text-gray-500">
            {' '}— {metric === 'gex' ? 'GEX' : 'Open Interest'} per strike
            {view === 'net' ? ', netto call−put' : ': call sopra lo zero, put sotto'}.
            {' '}Asse in {singleSrc === 'etf' ? `prezzi ${etfName}` : `punti ${futName}`}
            {singleSrc === 'etf' ? ' (equivalente futures nel tooltip)' : ' (strike nativo nel tooltip)'}.
          </span>
        </div>
        {controls}
      </div>

      {metric === 'oi' && !hasOi ? (
        <p className="text-[11px] text-gray-500 py-6 text-center">
          Open Interest non disponibile in questo snapshot — torna alla metrica Γ GEX.
        </p>
      ) : geom ? (
        <svg viewBox={`0 0 ${L.SW} ${L.SH}`} className="w-full select-none" role="img"
          aria-label={`Istogramma ${metric === 'gex' ? 'GEX' : 'OI'} per strike, catena ${srcName}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * L.SW;
            const py = ((e.clientY - r.top) / r.height) * L.SH;
            if (px < L.SM.left || px > L.SW - L.SM.right || py < L.SM.top) { setHoverS(null); return; }
            setHoverS({ x: px, y: py, s: geom.x0 + ((px - L.SM.left) / L.SPLOT_W) * (geom.x1 - geom.x0) });
          }}
          onPointerLeave={() => setHoverS(null)}>
          <defs>
            <linearGradient id="sCallUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={C.callDeep} /><stop offset="100%" stopColor={C.call} />
            </linearGradient>
            <linearGradient id="sPutDn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.putDeep} /><stop offset="100%" stopColor={C.put} />
            </linearGradient>
            <linearGradient id="sFieldUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={C.call} stopOpacity="0" /><stop offset="100%" stopColor={C.call} stopOpacity="0.07" />
            </linearGradient>
            <linearGradient id="sFieldDn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.put} stopOpacity="0" /><stop offset="100%" stopColor={C.put} stopOpacity="0.07" />
            </linearGradient>
            <linearGradient id="sLane" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b1220" stopOpacity="0.95" /><stop offset="100%" stopColor="#111a2b" stopOpacity="0.98" />
            </linearGradient>
            <linearGradient id="sZero" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={srcCol} stopOpacity="0.45" />
              <stop offset="50%" stopColor="#94a3b8" stopOpacity="0.85" />
              <stop offset="100%" stopColor={srcCol} stopOpacity="0.45" />
            </linearGradient>
          </defs>

          {/* corsia dei livelli (stessa lingua della fascia centrale in Entrambi) */}
          <rect x={L.SM.left} y={4} width={L.SPLOT_W} height={L.chipRows * 21 + 12} rx={7} fill="url(#sLane)" />
          <line x1={L.SM.left} x2={L.SW - L.SM.right} y1={L.chipRows * 21 + 16} y2={L.chipRows * 21 + 16} stroke={srcCol} strokeWidth={1} opacity={0.35} />

          {/* campi call / put */}
          <rect x={L.SM.left} y={L.SM.top} width={L.SPLOT_W} height={L.SPLOT_H / 2} fill="url(#sFieldUp)" />
          <rect x={L.SM.left} y={L.S_ZERO} width={L.SPLOT_W} height={L.SPLOT_H / 2} fill="url(#sFieldDn)" />

          {/* griglia prezzi + tacche di valore */}
          {sTicks.map((v, i) => (
            <line key={`gx${i}`} x1={geom.x(v)} x2={geom.x(v)} y1={L.SM.top} y2={L.SH - L.SM.bottom}
              stroke={C.grid} strokeWidth={0.6} strokeDasharray="2 5" opacity={0.7} />
          ))}
          {[0.5, 1].map(f => (
            <g key={`gy${f}`}>
              <line x1={L.SM.left} x2={L.SW - L.SM.right} y1={L.S_ZERO - L.S_HALF * f} y2={L.S_ZERO - L.S_HALF * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={L.SM.left - 8} y={L.S_ZERO - L.S_HALF * f + 3} textAnchor="end" fontSize={8.5} fill={C.call} opacity={0.85}>
                {fmtY(geom.yMax * f)}
              </text>
              <line x1={L.SM.left} x2={L.SW - L.SM.right} y1={L.S_ZERO + L.S_HALF * f} y2={L.S_ZERO + L.S_HALF * f}
                stroke={C.grid} strokeWidth={0.6} strokeDasharray="3 4" />
              <text x={L.SM.left - 8} y={L.S_ZERO + L.S_HALF * f + 3} textAnchor="end" fontSize={8.5} fill={C.put} opacity={0.85}>
                {fmtY(geom.yMax * f)}
              </text>
            </g>
          ))}

          {/* barre in gradiente */}
          {bars.map(b => {
            const [cVal, pVal] = geom.val(b);
            const bx = geom.x(b.s) - geom.bw / 2;
            const yTop = geom.barTop(cVal);
            const hBot = geom.barBottom(pVal) - L.S_ZERO;
            return (
              <g key={b.s}>
                {cVal > 0 && <rect x={bx} y={yTop} width={geom.bw} height={Math.max(0.8, L.S_ZERO - yTop)}
                  fill="url(#sCallUp)" opacity={0.93} rx={0.6} />}
                {pVal < 0 && <rect x={bx} y={L.S_ZERO} width={geom.bw} height={Math.max(0.8, hBot)}
                  fill="url(#sPutDn)" opacity={0.93} rx={0.6} />}
              </g>
            );
          })}

          {/* asse zero */}
          <line x1={L.SM.left} x2={L.SW - L.SM.right} y1={L.S_ZERO} y2={L.S_ZERO} stroke="url(#sZero)" strokeWidth={1.5} />
          <text x={L.SM.left - 8} y={L.S_ZERO + 3} textAnchor="end" fontSize={9} fill={C.soft}>0</text>

          {/* identità della fonte + semantica delle due metà */}
          <g>
            <rect x={L.SM.left + 6} y={L.SM.top + 4} width={112} height={17} rx={4} fill={C.panel} stroke={`${srcCol}66`} />
            <text x={L.SM.left + 12} y={L.SM.top + 16} fontSize={9.5} fontWeight="bold" fill={srcCol}>
              {srcArrow} {singleSrc === 'etf' ? 'ETF' : 'INDICI'} · {srcName}
            </text>
            <text x={L.SM.left + 8} y={L.S_ZERO - 6} fontSize={8.5} fontWeight="bold" fill={C.call} opacity={0.75}>
              {view === 'net' ? 'net ≥ 0 · call dominate' : 'CALL · gamma lunga'}
            </text>
            <text x={L.SM.left + 8} y={L.S_ZERO + 13} fontSize={8.5} fontWeight="bold" fill={C.put} opacity={0.75}>
              {view === 'net' ? 'net < 0 · put dominate' : 'PUT · gamma corta'}
            </text>
          </g>

          {/* livelli: linea + chip nella corsia, con la fonte dichiarata */}
          {sRefs.map((c, i) => {
            const kc = c.kind === 'spot' ? C.spot : c.kind === 'mp' ? C.mp : C.flip;
            const cy = sRowY[c.row];
            return (
              <g key={`sr${i}`}>
                <line x1={c.cx0} x2={c.cx0} y1={cy + 9} y2={L.SH - L.SM.bottom + 2} stroke={kc}
                  strokeWidth={1.2} strokeDasharray={c.kind === 'spot' ? '4 3' : '6 3'} opacity={0.85} />
                <circle cx={c.cx0} cy={L.S_ZERO} r={2.6} fill={kc} opacity={0.95} />
                {Math.abs(c.cx - c.cx0) > 3 && (
                  <line x1={c.cx} x2={c.cx0} y1={cy + 8} y2={L.SM.top} stroke={kc} strokeWidth={0.8}
                    strokeDasharray="2 2" opacity={0.6} />
                )}
                <rect x={c.cx - c.w / 2} y={cy - 8.5} width={c.w} height={17} rx={5}
                  fill={C.panel} fillOpacity={0.98} stroke={kc} strokeWidth={1} strokeOpacity={0.85} />
                <text x={c.cx - c.w / 2 + 7} y={cy + 3.5} fontSize={9.5} fontWeight="bold">
                  <tspan fill={srcCol}>{srcArrow} </tspan>
                  <tspan fill={kc}>{c.txt}</tspan>
                </text>
                <title>{`${c.label} — catena ${srcName}. ${singleSrc === 'etf'
                  ? `Prezzo ${etfName} ${fmtNat(c.price)} ≈ ${futName} ${fmtPrice(futOf(c.price))}`
                  : `${futName} ${fmtPrice(c.price)} ≈ ${idxName} ${fmtNat(natOf(c.price))}`}`}</title>
              </g>
            );
          })}

          {/* asse X */}
          {sTicks.map((v, i) => (
            <text key={`tx${i}`} x={geom.x(v)} y={L.SH - 8} textAnchor="middle" fontSize={9} fill={C.mute}>
              {singleSrc === 'etf' ? fmtNat(v) : fmtPrice(v)}
            </text>
          ))}
          <text x={L.SW - L.SM.right} y={L.SH - L.SM.bottom + 14} textAnchor="end" fontSize={9} fill={C.mute}>
            asse: {singleSrc === 'etf' ? `prezzi ${etfName}` : `punti ${futName}`}
          </text>

          {/* crosshair + tooltip */}
          {hoverS && hBar && (
            <g pointerEvents="none">
              <line x1={geom.x(hBar.s)} x2={geom.x(hBar.s)} y1={L.SM.top} y2={L.SH - L.SM.bottom}
                stroke="#e6edf3" strokeWidth={0.8} strokeDasharray="2 3" opacity={0.5} />
              <rect x={sTipX} y={sTipY} width={sTipW} height={sTipH} rx={7}
                fill={C.panel} fillOpacity={0.97} stroke="#334155" />
              <text x={sTipX + 12} y={sTipY + 19} fontSize={11} fontWeight="bold" fill={C.ink}>
                {srcName} {singleSrc === 'etf' ? fmtNat(hBar.s) : fmtPrice(hBar.s)}
              </text>
              <text x={sTipX + sTipW - 12} y={sTipY + 19} textAnchor="end" fontSize={9.5} fill={C.soft}>
                {singleSrc === 'etf'
                  ? `≈ ${futName} ${fmtPrice(futOf(hBar.s))}`
                  : `≈ ${idxName} ${fmtNat(natOf(hBar.s))}`}
              </text>
              <line x1={sTipX + 12} x2={sTipX + sTipW - 12} y1={sTipY + 27} y2={sTipY + 27} stroke="#1e293b" />
              <text x={sTipX + 12} y={sTipY + 45} fontSize={9.5} fontWeight="bold" fill={C.call}>
                {metric === 'gex' ? 'call GEX' : 'call OI'}
              </text>
              <text x={sTipX + sTipW - 12} y={sTipY + 45} textAnchor="end" fontSize={10} fontWeight="bold" fill={C.call}>
                {metric === 'gex' ? `${fmtMld(hBar.c)} Mld` : (hBar.co ?? 0).toLocaleString('it-IT')}
              </text>
              <text x={sTipX + 12} y={sTipY + 64} fontSize={9.5} fontWeight="bold" fill={C.put}>
                {metric === 'gex' ? 'put GEX' : 'put OI'}
              </text>
              <text x={sTipX + sTipW - 12} y={sTipY + 64} textAnchor="end" fontSize={10} fontWeight="bold" fill={C.put}>
                {metric === 'gex' ? `${fmtMld(hBar.p)} Mld` : (-(hBar.po ?? 0)).toLocaleString('it-IT')}
              </text>
              <line x1={sTipX + 12} x2={sTipX + sTipW - 12} y1={sTipY + 73} y2={sTipY + 73} stroke="#1e293b" />
              <text x={sTipX + 12} y={sTipY + 90} fontSize={9.5} fill={C.soft}>netto</text>
              <text x={sTipX + sTipW - 12} y={sTipY + 90} textAnchor="end" fontSize={10.5} fontWeight="bold"
                fill={val(hBar) >= 0 ? C.call : C.put}>
                {fmtVal(val(hBar), metric)} · {val(hBar) >= 0 ? 'pin 🛡' : 'trigger ⚡'}
              </text>
            </g>
          )}
        </svg>
      ) : (
        <p className="text-[11px] text-gray-500 py-6 text-center">Nessun dato per questo perimetro.</p>
      )}

      <div className="flex items-center gap-4 mt-1.5 flex-wrap text-[10px]">
        <span className="flex items-center gap-1.5 text-gray-400">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.call }} />
          {view === 'net' ? 'net ≥ 0 (call-dominato)' : `call ${metric === 'oi' ? 'OI' : 'GEX'} · gamma lunga`}
        </span>
        <span className="flex items-center gap-1.5 text-gray-400">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C.put }} />
          {view === 'net' ? 'net < 0 (put-dominato)' : `put ${metric === 'oi' ? 'OI' : 'GEX'} · gamma corta`}
        </span>
        <span className="flex items-center gap-2 text-gray-500">
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.spot }} /> Spot</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.mp }} /> Max Pain</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: C.flip }} /> Flip</span>
        </span>
        <span className="text-gray-500">
          nella corsia in alto: <b style={{ color: srcCol }}>{srcArrow}</b> livelli della catena {srcName}
        </span>
        <span className="text-gray-600 ml-auto">passa il mouse: valori dello strike e conversione di scala</span>
      </div>
    </div>
  );
};
