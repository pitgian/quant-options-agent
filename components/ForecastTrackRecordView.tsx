import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { UseOptionsDataReturn } from '../hooks/useOptionsData';
import { IconRefresh } from './Icons';
import type { ForecastSnapshot } from '../types';
import {
  fetchTrackRecord,
  computeMetrics,
  formatCi95,
  type TrackSymbol,
  type Horizon,
  type TrackRecordMetrics,
  type MetricSet,
} from '../services/forecastScoreService';

interface ForecastTrackRecordViewProps {
  sharedState: UseOptionsDataReturn;
}

type SymbolFilter = 'ALL' | TrackSymbol;
type HorizonFilter = 'ALL' | Horizon;
type WindowDays = 7 | 14 | 30;

// ---------------------------------------------------------------------------
// Tone helpers (mirror AdapterStatusView's colour language)
// ---------------------------------------------------------------------------

/** Colour tone for a directional-accuracy proportion. */
function accuracyTone(acc: number | null): { color: string; label: string; badge: string } {
  if (acc === null) return { color: 'text-slate-400', label: '—', badge: 'border-slate-700 bg-slate-800/40 text-slate-400' };
  // 50% is a coin flip (random). >60% is genuinely useful. <50% is worse than random.
  if (acc >= 0.6) return { color: 'text-emerald-400', label: 'Sopra il caso', badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' };
  if (acc >= 0.5) return { color: 'text-amber-400', label: 'Livello casuale', badge: 'border-amber-500/30 bg-amber-500/10 text-amber-400' };
  return { color: 'text-red-400', label: 'Sotto il caso', badge: 'border-red-500/30 bg-red-500/10 text-red-400' };
}

/** Colour tone for a coverage proportion (range_hit). */
function coverageTone(cov: number | null): { color: string; label: string } {
  if (cov === null) return { color: 'text-slate-400', label: '—' };
  if (cov >= 0.8) return { color: 'text-emerald-400', label: 'Ben calibrato' };
  if (cov >= 0.6) return { color: 'text-amber-400', label: 'Sotto-calibrato' };
  return { color: 'text-red-400', label: 'Troppo stretto' };
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------

function ControlBar({
  windowDays, setWindowDays,
  symbolFilter, setSymbolFilter,
  horizonFilter, setHorizonFilter,
  refreshing, onRefresh, timeSinceUpdate,
}: {
  windowDays: WindowDays;
  setWindowDays: (w: WindowDays) => void;
  symbolFilter: SymbolFilter;
  setSymbolFilter: (s: SymbolFilter) => void;
  horizonFilter: HorizonFilter;
  setHorizonFilter: (h: HorizonFilter) => void;
  refreshing: boolean;
  onRefresh: () => void;
  timeSinceUpdate: string;
}) {
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-bold text-slate-200">📊 Track Record Kronos</span>

        {/* Window selector */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Finestra:</span>
          <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            {([7, 14, 30] as WindowDays[]).map((w) => (
              <button
                key={w}
                onClick={() => setWindowDays(w)}
                className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
                style={{
                  backgroundColor: windowDays === w ? '#1e293b' : 'transparent',
                  color: windowDays === w ? '#e2e8f0' : '#64748b',
                }}
              >
                {w}g
              </button>
            ))}
          </div>
        </div>

        {/* Symbol filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Simbolo:</span>
          <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            {(['ALL', 'SPY', 'QQQ'] as SymbolFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setSymbolFilter(s)}
                className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
                style={{
                  backgroundColor: symbolFilter === s ? '#1e293b' : 'transparent',
                  color: symbolFilter === s ? '#e2e8f0' : '#64748b',
                }}
              >
                {s === 'ALL' ? 'Tutti' : s}
              </button>
            ))}
          </div>
        </div>

        {/* Horizon filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Orizzonte:</span>
          <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            {(['ALL', '4h', '1d'] as HorizonFilter[]).map((h) => (
              <button
                key={h}
                onClick={() => setHorizonFilter(h)}
                className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
                style={{
                  backgroundColor: horizonFilter === h ? '#1e293b' : 'transparent',
                  color: horizonFilter === h ? '#e2e8f0' : '#64748b',
                }}
              >
                {h === 'ALL' ? 'Tutti' : h}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
        title={timeSinceUpdate ? `Aggiornato: ${timeSinceUpdate}` : 'Aggiorna'}
      >
        <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        {timeSinceUpdate && <span className="text-[11px] text-gray-500">Aggiornato: {timeSinceUpdate}</span>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({ metrics }: { metrics: TrackRecordMetrics }) {
  const o = metrics.overall;
  const accTone = accuracyTone(o.directionalAccuracy);
  const covTone = coverageTone(o.rangeCoverage);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Directional accuracy */}
      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[120px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Accuratezza Direzionale</span>
        <div className="flex items-end justify-between mt-2">
          <span className={`text-3xl font-black ${accTone.color}`}>{fmtPct(o.directionalAccuracy, 0)}</span>
          <span className={`px-2 py-0.5 text-[9px] font-bold rounded border ${accTone.badge}`}>{accTone.label}</span>
        </div>
        <span className="text-[10px] text-gray-500 mt-1">
          n={o.directionalN} · IC 95% {formatCi95(o.directionalCi95)}
          <span className="block text-gray-600">i forecast NEUTRAL/FLAT sono esclusi</span>
        </span>
      </div>

      {/* MAPE */}
      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[120px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Errore Medio (MAPE)</span>
        <div className="flex items-end justify-between mt-2">
          <span className="text-3xl font-black text-slate-100">{fmtNum(o.mape)}%</span>
          {o.mapeStd !== null && (
            <span className="text-[10px] text-gray-500 font-mono">±{fmtNum(o.mapeStd)}%</span>
          )}
        </div>
        <span className="text-[10px] text-gray-500 mt-1">
          n={o.mapeN} · |target previsto − prezzo reale| / reale
          <span className="block text-gray-600">errore sul prezzo target finale</span>
        </span>
      </div>

      {/* Range coverage */}
      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[120px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Copertura del Range</span>
        <div className="flex items-end justify-between mt-2">
          <span className={`text-3xl font-black ${covTone.color}`}>{fmtPct(o.rangeCoverage, 0)}</span>
          <span className="text-[9px] font-bold text-gray-500">{covTone.label}</span>
        </div>
        <span className="text-[10px] text-gray-500 mt-1">
          n={o.rangeN} · prezzo reale dentro [min, max] previsto
          <span className="block text-gray-600">misura se la volatilità stimata è affidabile</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rolling accuracy chart (SVG, per-horizon daily buckets)
// ---------------------------------------------------------------------------

function RollingChart({ metrics }: { metrics: TrackRecordMetrics }) {
  const points = metrics.rolling;

  if (points.length === 0) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-slate-300 mb-2">📈 Accuratezza Direzionale nel Tempo</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Servono forecast directional già maturati (almeno un giorno con esito registrato) per tracciare il trend.
          La curva si popola automaticamente man mano che i forecast scadono e vengono valutati.
        </p>
      </div>
    );
  }

  const W = 800, H = 280;
  const padL = 44, padR = 16, padT = 18, padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Unique sorted days across all points
  const days = useMemo(() => {
    const set = new Set(points.map((p) => p.day));
    return [...set].sort();
  }, [points]);
  const nDays = days.length;

  const xFor = (day: string) => {
    const idx = days.indexOf(day);
    return padL + (nDays <= 1 ? innerW / 2 : (idx / (nDays - 1)) * innerW);
  };
  const yFor = (acc: number) => padT + innerH - acc * innerH; // 0..1 → bottom..top

  // Build per-horizon polyline paths (only connecting days that have that horizon)
  const horizonColor: Record<Horizon, string> = { '4h': '#60a5fa', '1d': '#fbbf24' };
  const horizonPaths: Record<Horizon, string> = { '4h': '', '1d': '' };
  for (const h of ['4h', '1d'] as Horizon[]) {
    let d = '';
    let started = false;
    for (const day of days) {
      const pt = points.find((p) => p.day === day && p.horizon === h);
      if (!pt || pt.accuracy === null) {
        started = false;
        continue;
      }
      d += `${started ? 'L' : 'M'} ${xFor(day).toFixed(1)} ${yFor(pt.accuracy).toFixed(1)} `;
      started = true;
    }
    horizonPaths[h] = d.trim();
  }

  // 50% reference line (random-chance baseline)
  const y50 = yFor(0.5);

  // X-axis labels: subsample to ~8 max
  const tickStep = Math.max(1, Math.ceil(nDays / 8));

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-300">📈 Accuratezza Direzionale nel Tempo</h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1 text-blue-300"><span className="inline-block w-3 h-0.5 bg-blue-400" />4h</span>
          <span className="flex items-center gap-1 text-amber-300"><span className="inline-block w-3 h-0.5 bg-amber-400" />1d</span>
          <span className="flex items-center gap-1 text-slate-500"><span className="inline-block w-3 h-0.5 border-t border-dashed border-slate-500" />caso (50%)</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="overflow-visible">
        {/* Y gridlines at 0,25,50,75,100% */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} y1={yFor(g)} x2={W - padR} y2={yFor(g)} stroke={g === 0.5 ? '#475569' : '#1e293b'} strokeDasharray={g === 0.5 ? '4 4' : '3 4'} />
            <text x={padL - 6} y={yFor(g) + 3} fill="#64748b" fontSize="9" textAnchor="end">{(g * 100).toFixed(0)}%</text>
          </g>
        ))}
        {/* bottom axis */}
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#334155" />

        {/* Lines */}
        {(['1d', '4h'] as Horizon[]).map((h) => (
          <path key={h} d={horizonPaths[h]} fill="none" stroke={horizonColor[h]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* X labels */}
        {days.map((day, i) =>
          i % tickStep === 0 || i === nDays - 1 ? (
            <text key={day} x={xFor(day)} y={H - padB + 14} fill="#64748b" fontSize="9" textAnchor="middle">
              {new Date(day + 'T00:00:00Z').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })}
            </text>
          ) : null,
        )}
      </svg>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Ogni punto è un giorno: frazione di forecast con la direzione giusta. La linea tratteggiata al 50% è il caso (lancio di monetA):
        stare sopra significa davvero prevedere la direzione, sotto significa fare peggio del random. I gap nei giorni senza forecast maturati sono normali.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail table (per symbol × horizon)
// ---------------------------------------------------------------------------

const ALL_GROUPS: { symbol: TrackSymbol; horizon: Horizon }[] = [
  { symbol: 'SPY', horizon: '4h' },
  { symbol: 'SPY', horizon: '1d' },
  { symbol: 'QQQ', horizon: '4h' },
  { symbol: 'QQQ', horizon: '1d' },
];

function GroupTable({ metrics }: { metrics: TrackRecordMetrics }) {
  const rows = ALL_GROUPS.map(({ symbol, horizon }) => {
    const key = `${symbol}|${horizon}`;
    const m: MetricSet | undefined = metrics.byGroup[key];
    return { symbol, horizon, m };
  });

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-300">📋 Dettaglio per Simbolo × Orizzonte</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-xs text-left text-gray-300">
          <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
            <tr>
              <th className="px-4 py-2.5">Simbolo</th>
              <th className="px-4 py-2.5">Orizzonte</th>
              <th className="px-4 py-2.5">N valutati</th>
              <th className="px-4 py-2.5">Acc. Direzionale</th>
              <th className="px-4 py-2.5">MAPE</th>
              <th className="px-4 py-2.5">Copertura Range</th>
              <th className="px-4 py-2.5">Stato</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map(({ symbol, horizon, m }) => {
              const accTone = accuracyTone(m?.directionalAccuracy ?? null);
              const covTone = coverageTone(m?.rangeCoverage ?? null);
              const hasData = m && m.totalScored > 0;
              return (
                <tr key={`${symbol}-${horizon}`} className="hover:bg-slate-900/40">
                  <td className="px-4 py-2.5 font-semibold text-slate-200">{symbol}</td>
                  <td className="px-4 py-2.5 font-semibold text-slate-200">{horizon}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">{m?.totalScored ?? 0}</td>
                  <td className="px-4 py-2.5 font-mono font-bold">
                    {m && m.directionalAccuracy !== null ? (
                      <span className={accTone.color}>{fmtPct(m.directionalAccuracy, 0)} <span className="text-[9px] text-gray-500">(n={m.directionalN})</span></span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">
                    {m && m.mape !== null ? `${fmtNum(m.mape)}%` : '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {m && m.rangeCoverage !== null ? (
                      <span className={covTone.color}>{fmtPct(m.rangeCoverage, 0)}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {hasData ? (
                      <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-green-500/10 text-green-400 border border-green-500/20">VALUTATO</span>
                    ) : (
                      <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">IN ATTESA</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const ForecastTrackRecordView: React.FC<ForecastTrackRecordViewProps> = ({ sharedState }) => {
  const { handleRefresh, refreshing, timeSinceUpdate } = sharedState;
  const [snapshots, setSnapshots] = useState<ForecastSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [symbolFilter, setSymbolFilter] = useState<SymbolFilter>('ALL');
  const [horizonFilter, setHorizonFilter] = useState<HorizonFilter>('ALL');

  const load = useCallback(async () => {
    try {
      const data = await fetchTrackRecord();
      setSnapshots(data?.snapshots ?? []);
    } catch (err) {
      console.error('Failed to load track record:', err);
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const metrics = useMemo<TrackRecordMetrics | null>(() => {
    if (!snapshots) return null;
    return computeMetrics(snapshots, {
      windowDays,
      symbol: symbolFilter === 'ALL' ? undefined : symbolFilter,
      horizon: horizonFilter === 'ALL' ? undefined : horizonFilter,
    });
  }, [snapshots, windowDays, symbolFilter, horizonFilter]);

  const onRefresh = async () => {
    await Promise.all([load(), handleRefresh()]);
  };

  return (
    <div className="flex-1 flex flex-col">
      <div
        className="sticky z-40 bg-[#161b22]/95 backdrop-blur border-b border-slate-800"
        style={{ top: 'var(--app-nav-h, 0px)' }}
      >
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <ControlBar
            windowDays={windowDays}
            setWindowDays={setWindowDays}
            symbolFilter={symbolFilter}
            setSymbolFilter={setSymbolFilter}
            horizonFilter={horizonFilter}
            setHorizonFilter={setHorizonFilter}
            refreshing={refreshing}
            onRefresh={onRefresh}
            timeSinceUpdate={timeSinceUpdate}
          />
        </div>
      </div>

      <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6 w-full">
        {loading && !snapshots ? (
          <div className="flex flex-col items-center justify-center min-h-[300px] bg-[#161b22] border border-slate-800 rounded-2xl">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-4" />
            <span className="text-gray-400 text-sm">Caricamento track record…</span>
          </div>
        ) : !metrics || metrics.totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[300px] bg-[#161b22] border border-slate-800 rounded-2xl p-6 text-center">
            <span className="text-3xl mb-3">📊</span>
            <span className="text-gray-300 text-sm font-semibold mb-2">Nessun forecast registrato in questa finestra</span>
            <span className="text-gray-500 text-xs max-w-md">
              Il track record si accumula automaticamente: ogni run di Kronos registra una snapshot, e la valuta quando il suo orizzonte scade.
              Torna tra qualche giorno per le prime statistiche (servono forecast 4h/1d maturati).
            </span>
          </div>
        ) : (
          <>
            {/* Pending / sample-size banner */}
            {metrics.pendingCount > 0 && (
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-3 flex items-center gap-3">
                <span className="text-blue-400 text-sm">⏳</span>
                <span className="text-[11px] text-blue-300/90">
                  <b>{metrics.pendingCount}</b> forecast in attesa di scadenza (su {metrics.totalCount} totali nella finestra).
                  Le statistiche si aggiornano da sole quando i loro orizzonti maturano e il prezzo reale diventa disponibile.
                </span>
              </div>
            )}

            <SummaryCards metrics={metrics} />
            <RollingChart metrics={metrics} />
            <GroupTable metrics={metrics} />

            {/* Explainer */}
            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-slate-300 mb-3">ℹ️ Come leggere il track record</h3>
              <div className="text-xs text-gray-400 space-y-3 max-w-3xl">
                <div>
                  <div className="text-slate-300 font-semibold mb-1">Cosa misura</div>
                  <p>
                    Ogni run di Kronos produce una proiezione (4h e 1d) che viene <b>registrata</b> prima di essere sovrascritta.
                    Quando l'orizzonte della proiezione scade, lo scaricamento del prezzo reale ci permette di confrontare previsione e realtà:
                    questa pagina aggrega quei confronti nelle tre metriche mostrate sopra.
                  </p>
                </div>
                <div>
                  <div className="text-slate-300 font-semibold mb-1">Le tre metriche</div>
                  <ul className="list-disc pl-4 space-y-1">
                    <li><b>Accuratezza direzionale</b> — quante volte il verso (su/giù) era giusto. Il 50% è il puro caso: sopra il 60% il modello ha davvero un margine.</li>
                    <li><b>MAPE</b> — errore medio % tra il prezzo target previsto e quello realizzato. Più basso = più preciso in valore assoluto.</li>
                    <li><b>Copertura del range</b> — quante volte il prezzo reale è caduto dentro il corridoio [min, max] previsto. Verifica se la stima di volatilità è ben calibrata.</li>
                  </ul>
                </div>
                <div>
                  <div className="text-slate-300 font-semibold mb-1">Esclusioni e caveat</div>
                  <p>
                    I forecast emessi con bias <b>NEUTRAL</b> (mossa prevista sotto soglia) non hanno una direzione dichiarata e sono esclusi dall'accuratezza direzionale: contarli come errore sarebbe ingiusto.
                    L'intervallo di confidenza (IC 95%) riflette l'incertezza da sample size: con pochi forecast è largo, e va letto come "il vero valore sta in questo intorno", non come un punteggio definitivo.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
