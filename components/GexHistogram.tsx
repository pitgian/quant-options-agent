import React, { useMemo, useState } from 'react';

/**
 * GexHistogram — profilo GEX/OI per strike.
 *
 * DUE anime, secondo la fonte selezionata:
 *
 *  · Fonte singola (ETF o Indici): istogramma SVG, una barra per strike reale
 *    (verde = call/gamma lunga, rosso = put/gamma corta), linee Spot/MaxPain/Flip.
 *
 *  · Fonte 'Entrambi': NON si sovrappone nulla e NON si sommano due libri che
 *    presidiano prezzi diversi. Si mostra il PANNELLO MURI: una riga per muro,
 *    con la barra GEX a scala comune. Una riga è CONFLUENZA (⧉) quando un muro
 *    ETF e uno indice cadono sullo STESSO prezzo futures entro ±ZONE_TOL_PT.
 *    Con la tolleranza giusta (10 pt = due griglie da 5 della scala) di solito
 *    NON c'è confluenza: e questo è un dato, non un guasto — il pannello lo
 *    dice a parole, invece di disegnare bande a caso.
 *
 * Perché 10 pt: i muri sono livelli di prezzo del futures. SPY 750 e SPX 7500
 * NON sono lo stesso livello: in scala ES fanno 7545 e 7525, cioè 20 punti
 * diversi. Chiamarli confluenza (come faceva la vecchia tolleranza 25 pt)
 * produceva solo falsi positivi.
 *
 * I muri arrivano dai top_gamma del piano (già aggregati per strike, con
 * picchi veri), convertiti in Mld — non dai profili grezzi per strike, che
 * hanno rumore a sufficienza da inventare muri dove non ce ne sono.
 */

export interface GexProfileEntry {
  s: number;
  c: number;
  p: number;
  /** Open interest call/put dello strike. */
  co?: number;
  po?: number;
  /** Strike nativo della catena (SPY/QQQ o SPX/NDX), portato dai muri. */
  native?: number;
  /** Lato dominante dello strike: call/put (etichetta 'call wall'/'put wall'). */
  side?: 'call' | 'put';
}

const W = 960, H = 340;
const M = { left: 60, right: 16, top: 28, bottom: 28 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

/**
 * Tolleranza di confluenza in punti futures: 5 pt = la griglia operativa della
 * scala. I muri delle due catene cadono quasi sempre a ~20 pt l'uno dall'altro
 * (SPY e SPX hanno griglie di strike diverse): non sono lo stesso livello.
 * Con la tolleranza vecchia di 25 pt la UI contava 6 "confluenze" che erano
 * tutte falsi positivi (verificato 13/11 sul piano live: gap minimo reale 20 pt).
 */
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
/** Prezzo nativo: interi per gli strike indice, 1 decimale per gli ETF. */
const fmtNat = (v: number): string =>
  (Math.round(v * 10) / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });

export const GexHistogram: React.FC<{
  profile: Array<GexProfileEntry> | undefined;
  spot: number;
  idxName: string;
  /** Nome della catena ETF (SPY/QQQ): i muri del pannello 'Entrambi'. */
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

  // ============================================================== PANNELLO
  type Wall = { s: number; net: number; native: number; side: string; src: 'etf' | 'idx' };

  const walls = useMemo<Wall[]>(() => {
    if (!bothMode) return [];
    const mk = (arr: Array<GexProfileEntry>, src: 'etf' | 'idx'): Wall[] =>
      arr.map(e => ({
        s: e.s,
        net: e.c + e.p,
        native: e.native ?? e.s,
        side: e.side ?? (e.c + e.p >= 0 ? 'call' : 'put'),
        src,
      }));
    return [...mk(zoneEtf!, 'etf'), ...mk(zoneIdx!, 'idx')];
  }, [zoneEtf, zoneIdx, bothMode]);

  // Raggruppa per prezzo: un muro ETF + un muro indice entro ZONE_TOL_PT = una
  // riga sola, in confluenza. Niente fusione a catena: un cluster accetta al
  // più UN muro per fonte, così 7525/7545/7565 non diventano un'unica banda.
  type WallRow = { price: number; etf?: Wall; idx?: Wall;
                   near?: { dist: number; price: number; src: 'etf' | 'idx' } };
  const rows = useMemo<WallRow[]>(() => {
    if (!bothMode) return [];
    const win = WINDOWS[winIdx];
    const inWin = walls
      .filter(w => Math.abs(w.s - spot) / spot <= win.pct)
      .sort((a, b) => a.s - b.s);
    const out: WallRow[] = [];
    for (const w of inWin) {
      const last = out[out.length - 1];
      if (last && !last[w.src] && Math.abs(w.s - last.price) <= ZONE_TOL_PT) {
        last[w.src] = w;
        last.price = Math.round((last.price + w.s) / 5) * 5; // zona comune
      } else {
        out.push({ price: w.s, [w.src]: w } as WallRow);
      }
    }
    // sui muri solitari: quanto è lontano il muro più vicino dell'ALTRA fonte.
    // È il numero che dice se due righe vicine sono lo stesso livello o no.
    for (const r of out) {
      if (r.etf && r.idx) continue;
      const other = r.etf ? 'idx' : 'etf';
      let best: Wall | null = null;
      for (const w of walls) {
        if (w.src !== other) continue;
        if (!best || Math.abs(w.s - r.price) < Math.abs(best.s - r.price)) best = w;
      }
      if (best) r.near = { dist: Math.round(Math.abs(best.s - r.price)), price: best.s, src: other };
    }
    // la scala si legge dall'alto: prezzi decrescenti
    return out.sort((a, b) => b.price - a.price);
  }, [walls, spot, winIdx, bothMode]);

  const confN = useMemo(() => rows.filter(r => r.etf && r.idx).length, [rows]);

  // Quanto distano DAVVERO i due libri: per ogni muro indice, il muro ETF più
  // vicino. È il numero che smaschera i falsi positivi della vecchia UI.
  const minGap = useMemo(() => {
    if (!bothMode) return null;
    const e = walls.filter(w => w.src === 'etf').map(w => w.s).sort((a, b) => a - b);
    const i = walls.filter(w => w.src === 'idx').map(w => w.s).sort((a, b) => a - b);
    if (!e.length || !i.length) return null;
    let best = Infinity;
    for (const s of i) {
      let lo = 0, hi = e.length - 1, near = e[0];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (Math.abs(e[mid] - s) < Math.abs(near - s)) near = e[mid];
        if (e[mid] < s) lo = mid + 1; else hi = mid - 1;
      }
      best = Math.min(best, Math.abs(near - s));
    }
    return Math.round(best);
  }, [walls, bothMode]);

  const maxAbs = useMemo(
    () => Math.max(1e-9, ...rows.flatMap(r => [Math.abs(r.etf?.net ?? 0), Math.abs(r.idx?.net ?? 0)])),
    [rows],
  );

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

  // ============================================================ RENDER
  const winBtns = (
    <div className="inline-flex rounded-lg border border-slate-800 overflow-hidden">
      {WINDOWS.map((w, i) => (
        <button key={w.label} onClick={() => setWinIdx(i)}
          className={`px-2.5 py-1 text-[10px] font-bold transition-colors ${winIdx === i ? 'bg-blue-600/80 text-white' : 'bg-[#0d1117] text-gray-400 hover:text-slate-200'}`}
          title={`Strike entro ±${(w.pct * 100).toLocaleString('it-IT')}%`}>
          {w.label}
        </button>
      ))}
    </div>
  );

  const Bar: React.FC<{ v: number; tone: 'gex' | 'oi' }> = ({ v }) => {
    const pct = Math.min(100, Math.abs(v) / maxAbs * 100);
    return (
      <div className="h-2.5 rounded-sm bg-slate-800/50 overflow-hidden min-w-[60px] flex-1">
        <div className={`h-full ${v >= 0 ? 'bg-emerald-400/80' : 'bg-red-400/80'}`}
             style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    );
  };

  const WallCell: React.FC<{ w?: Wall; name: string }> = ({ w, name }) => {
    if (!w) return <div className="flex-1 min-w-0" aria-hidden />;
    return (
      <div className="flex items-center gap-2 flex-1 min-w-0"
           title={`${name} ${fmtNat(w.native)} · ${w.net >= 0 ? 'gamma lunga (pin)' : 'gamma corta (trigger)'} · ${fmtMld(w.net)} · ≈ ${futName ?? 'fut'} ${w.s.toFixed(0)}`}>
        <span className="text-[10px] font-bold uppercase tracking-wide whitespace-nowrap text-gray-500">{name}</span>
        <span className="text-[10px] font-mono text-gray-400 whitespace-nowrap">{fmtNat(w.native)}</span>
        <span className="text-[10px] font-mono text-gray-400 w-16 text-right whitespace-nowrap">{fmtMld(w.net)}</span>
        <Bar v={w.net} tone="gex" />
        <span className={`text-[9px] font-extrabold px-1 py-0.5 rounded border whitespace-nowrap ${
          w.net >= 0 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                     : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
          {w.net >= 0 ? '🛡' : '⚡'} {w.side}
        </span>
      </div>
    );
  };

  if (!profile || profile.length === 0) {
    return (
      <p className="text-[11px] text-gray-500 py-3">
        Profilo non disponibile per questa borsa/fonte in questo snapshot.
      </p>
    );
  }

  return (
    <div>
      {/* ------ intestazione: fonte singola = controlli istogramma, entrambi = riepilogo */}
      {!bothMode ? (
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <span className="text-[10px] text-gray-500">
            {metric === 'gex'
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
            {winBtns}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <span className="text-[11px] leading-relaxed">
            {confN > 0 ? (
              <span className="font-bold text-violet-300">⧉ {confN} confluenz{confN === 1 ? 'a' : 'e'}</span>
            ) : (
              <span className="font-bold text-gray-300">⧉ nessuna confluenza</span>
            )}
            <span className="text-gray-500">
              {' '}entro ±{ZONE_TOL_PT} pt sullo stesso prezzo {futName} — i due libri qui{' '}
              {confN > 0 ? 'confermano gli stessi livelli' : 'presidiano livelli distinti'}
              {minGap !== null && <> · distanza minima fra i muri delle due fonti: <b className="text-gray-300">{minGap} pt</b></>}
            </span>
          </span>
          {winBtns}
        </div>
      )}

      {/* =========================== PANNELLO MURI (Entrambi) =========================== */}
      {bothMode ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-gray-600 font-bold px-2">
            <span className="w-20">{futName}</span>
            <span className="flex-1">muro a confronto · barra = |GEX| a scala comune (max {fmtMld(maxAbs)})</span>
          </div>

          {rows.map((r, i) => {
            const isConf = !!(r.etf && r.idx);
            // riga spot inserita nel punto di prezzo corretto
            const prev = rows[i - 1];
            const spotHere = spot && prev && r.price < spot && prev.price > spot;
            return (
              <React.Fragment key={`${r.price}-${i}`}>
                {spotHere && (
                  <div className="flex items-center gap-2 px-2 py-1 rounded-lg border border-amber-500/50 bg-amber-500/10">
                    <span className="font-mono font-extrabold text-amber-300 text-sm tnum">
                      {futName} {Math.round(spot).toLocaleString()}
                    </span>
                    <span className="text-[9px] font-extrabold text-amber-400/80 uppercase tracking-widest">live</span>
                    <span className="text-[10px] text-gray-400 ml-2">spot — sopra e sotto i muri</span>
                  </div>
                )}
                <div className={`flex flex-col gap-1 px-2 py-1.5 rounded-lg border ${
                  isConf ? 'border-violet-500/50 bg-violet-500/10'
                         : 'border-slate-800 bg-slate-900/30'}`}>
                  <div className="flex items-center gap-2">
                    <span className="w-20 font-mono font-bold tnum text-[13px] text-slate-100 whitespace-nowrap">
                      {futName} {r.price.toLocaleString()}
                    </span>
                    {isConf ? (
                      <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded whitespace-nowrap border bg-violet-500/20 text-violet-200 border-violet-500/40"
                            title={`Un muro della catena ${etfName} e uno della catena ${idxName} cadono sullo stesso prezzo ${futName} (entro ±${ZONE_TOL_PT} pt): due libri indipendenti confermano lo stesso livello.`}>
                        ⧉ {etfName}×{idxName}
                      </span>
                    ) : (
                      <span className="text-[9px] text-gray-500 whitespace-nowrap"
                            title={r.near
                              ? `Nessuna confluenza qui: il muro ${r.near.src === 'etf' ? etfName : idxName} più vicino è a ${r.near.price} (${r.near.dist} pt da ${r.price}) — è un livello DIVERSO`
                              : "Nessun muro dell'altra fonte in questa finestra"}>
                        {r.near
                          ? <>muro {r.near.src === 'etf' ? etfName : idxName} più vicino: <b className={r.near.dist <= 25 ? 'text-gray-400' : 'text-gray-500'}>{r.near.dist} pt</b></>
                          : <>nessun muro dell'altra fonte</>}
                      </span>
                    )}
                    {isConf && (
                      <span className="text-[10px] text-gray-500 whitespace-nowrap ml-auto">conferma incrociata</span>
                    )}
                  </div>
                  {isConf ? (
                    <>
                      <WallCell w={r.etf} name={etfName} />
                      <WallCell w={r.idx} name={idxName} />
                    </>
                  ) : (
                    <WallCell w={r.etf ?? r.idx} name={r.etf ? etfName : idxName} />
                  )}
                </div>
              </React.Fragment>
            );
          })}

          {confN === 0 && (
            <p className="text-[10px] text-gray-500 leading-relaxed mt-1 px-2">
              Qui ⧉ non ce n'è, ed è un dato vero: {etfName} e {idxName} hanno griglie di strike
              diverse, quindi i loro muri più grossi cadono a {minGap ?? 'una ventina di'} pt di
              distanza sul {futName} — due livelli distinti, non uno confermato due volte. La
              confluenza viene segnalata solo entro ±{ZONE_TOL_PT} pt: capita raramente, e quando
              capita è la conferma più forte della scala.
            </p>
          )}

          <div className="flex items-center gap-4 mt-1 px-2 flex-wrap">
            <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-400/80" /> gamma lunga (pin 🛡)
            </span>
            <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400/80" /> gamma corta (trigger ⚡)
            </span>
            <span className="text-[10px] text-gray-400 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-500/40 border border-violet-500" /> ⧉ confluenza (±{ZONE_TOL_PT} pt)
            </span>
          </div>
        </div>
      ) : (
        /* =========================== ISTOGRAMMA (fonte singola) =========================== */
        <>
          {metric === 'oi' && !hasOi ? (
            <p className="text-[11px] text-gray-500 py-6 text-center">
              Open Interest non disponibile in questo snapshot — torna alla metrica Γ GEX.
            </p>
          ) : geom ? (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Istogramma per strike">
              {[0.25, 0.5, 0.75, 1].map((f, i) => {
                const v = geom.yMax * f;
                const y = geom.yZero - (v / geom.yMax) * geom.half;
                return (
                  <g key={i}>
                    <line x1={M.left} x2={W - M.right} y1={y} y2={y} stroke="#1e293b" strokeWidth={0.6} strokeDasharray="3 4" />
                    <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#64748b">
                      {metric === 'oi' ? fmtOi(v) : fmtMld(v)}
                    </text>
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

              {refLines.map(l => (
                <g key={l.label}>
                  <line x1={geom.x(l.v!)} x2={geom.x(l.v!)} y1={M.top - 4} y2={M.top + PLOT_H}
                        stroke={l.color} strokeWidth={1.2} strokeDasharray={l.dash} />
                  <text x={geom.x(l.v!)} y={M.top - 8} textAnchor="middle" fontSize={9.5} fontWeight="bold" fill={l.color}>
                    {l.label}
                  </text>
                </g>
              ))}

              {Array.from({ length: 7 }, (_, i) => geom.x0 + ((geom.x1 - geom.x0) * i) / 6).map((s, i) => (
                <text key={i} x={geom.x(s)} y={H - 8} textAnchor="middle" fontSize={9} fill="#64748b">
                  {s.toFixed(0)}
                </text>
              ))}
            </svg>
          ) : (
            <p className="text-[11px] text-gray-500 py-6 text-center">Nessun dato per questo perimetro.</p>
          )}

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
            </span>
            <span className="text-[10px] text-gray-500">
              strike in scala {strikeScale ?? idxName} · doppio prezzo nel tooltip: {futName ?? 'futures'} ↔ nativo
            </span>
          </div>
        </>
      )}
    </div>
  );
};
