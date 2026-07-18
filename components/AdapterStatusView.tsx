import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { UseOptionsDataReturn } from '../hooks/useOptionsData';
import { IconRefresh } from './Icons';
import type {
  AdapterTrainingStats,
  KronosForecastItem,
  KronosResolutionForecast,
} from '../types';
import { fetchAdapterStats } from '../services/adapterStatsService';

interface AdapterStatusViewProps {
  sharedState: UseOptionsDataReturn;
}

const HORIZON_ORDER = ['4h', '1d'] as const;
const RES_KEYS: { key: 'forecast_4h' | 'forecast_1d'; h: string }[] = [
  { key: 'forecast_4h', h: '4h' },
  { key: 'forecast_1d', h: '1d' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso?: string | null): string {
  if (!iso) return 'Mai';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'Ora';
  if (mins < 60) return `${mins} min fa`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h fa`;
  const d = Math.floor(h / 24);
  return `${d}g fa`;
}

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

interface Verdict {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'idle';
  detail: string;
}

function computeVerdict(stats: AdapterTrainingStats | null): Verdict {
  if (!stats) {
    return { label: 'Nessun dato', tone: 'idle', detail: 'Statistiche di addestramento non disponibili.' };
  }
  if (!stats.saved) {
    return {
      label: 'In accumulo (guard attiva)',
      tone: 'warn',
      detail: stats.reason || `Solo ${stats.real_samples_total} sample reali (< ${stats.min_real_samples_required}). L'adapter non viene sovrascritto con rumore sintetico.`,
    };
  }
  const train = stats.final_train_loss;
  const val = stats.final_val_loss;
  const overfit = train != null && val != null && val > train * 2.5;
  const imp = stats.final_improvement_pct;
  if (overfit) {
    return {
      label: 'Addestrato ma in overfit',
      tone: 'warn',
      detail: `Loss train ${fmt(train)} ma val ${fmt(val)} molto più alta — probabilmente troppo pochi sample reali per orizzonte.`,
    };
  }
  const impStr = imp != null ? ` · riduce l'errore del ${imp >= 0 ? '+' : ''}${imp.toFixed(1)}% vs Kronos puro` : '';
  return {
    label: 'Addestrato su dati reali',
    tone: imp != null && imp < 0 ? 'warn' : 'good',
    detail: `${stats.real_samples_total} sample reali · train ${fmt(train)} · val ${fmt(val)}${impStr}.`,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ControlBar({
  timeSinceUpdate,
  refreshing,
  onRefresh,
}: {
  timeSinceUpdate: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-slate-200">🧠 Adapter Covariati Kronos</span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
          Stato addestramento & applicazione live
        </span>
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

function VerdictCard({ stats, verdict }: { stats: AdapterTrainingStats | null; verdict: Verdict }) {
  const toneStyles = {
    good: 'border-green-500/30 bg-green-500/5 text-green-300',
    warn: 'border-amber-500/30 bg-amber-500/5 text-amber-300',
    bad: 'border-red-500/30 bg-red-500/5 text-red-300',
    idle: 'border-slate-700 bg-slate-800/30 text-slate-300',
  }[verdict.tone];

  return (
    <div className={`rounded-xl border p-4 ${toneStyles}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold">{verdict.label}</span>
        </div>
        {stats && (
          <span className="text-[11px] text-gray-400">
            ultimo addestramento: <span className="font-semibold text-gray-200">{timeAgo(stats.trained_at)}</span>
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-2 max-w-3xl">{verdict.detail}</p>
    </div>
  );
}

function StatCards({ stats }: { stats: AdapterTrainingStats }) {
  const cards = [
    { label: 'Sample Reali', value: String(stats.real_samples_total), sub: `min richiesti: ${stats.min_real_samples_required}` },
    { label: 'Checkpoint Salvato', value: stats.saved ? 'SÌ' : 'NO', sub: stats.saved ? 'pesi aggiornati' : 'guard bloccata' },
    { label: 'Loss Train', value: fmt(stats.final_train_loss, 5), sub: `${stats.epochs ?? 0} epoche` },
    { label: 'Loss Val', value: fmt(stats.final_val_loss, 5), sub: `${stats.val_samples ?? 0} sample val` },
    { label: 'Record Storici', value: String(Object.values(stats.history_records ?? {}).reduce((a, b) => a + b, 0)), sub: stats.symbols?.join(', ') },
    { label: 'Device', value: stats.device ?? '—', sub: timeAgo(stats.trained_at) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-[#161b22] border border-slate-800 rounded-xl p-3 flex flex-col justify-between min-h-[84px]">
          <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">{c.label}</span>
          <span className="text-lg font-bold text-slate-100 mt-1">{c.value}</span>
          <span className="text-[9px] text-gray-500">{c.sub}</span>
        </div>
      ))}
    </div>
  );
}

function improvementTone(pct: number | null | undefined): { color: string; label: string } {
  if (pct == null || Number.isNaN(pct)) return { color: 'text-slate-400', label: '—' };
  if (pct >= 25) return { color: 'text-emerald-400', label: 'Ottimo' };
  if (pct >= 10) return { color: 'text-green-400', label: 'Buono' };
  if (pct >= 3) return { color: 'text-amber-400', label: 'Modesto' };
  if (pct >= 0) return { color: 'text-orange-400', label: 'Marginale' };
  return { color: 'text-red-400', label: 'Peggiorativo' };
}

function ImprovementCard({ stats }: { stats: AdapterTrainingStats }) {
  const pct = stats.final_improvement_pct;
  const baseline = stats.final_baseline_val_loss;
  const adapter = stats.final_val_loss;
  const tone = improvementTone(pct);
  const hasData = pct != null && baseline != null && adapter != null;

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-300">🎯 Miglioramento vs Kronos puro (validation set)</h3>
        {hasData && (
          <span className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border bg-slate-800/40 border-slate-700 ${tone.color}`}>
            {tone.label}
          </span>
        )}
      </div>
      {hasData ? (
        <>
          <div className="flex items-end gap-6 flex-wrap">
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Errore ridotto</span>
              <span className={`text-4xl font-black ${tone.color}`}>{pct! >= 0 ? '+' : ''}{pct!.toFixed(1)}%</span>
              <span className="text-[10px] text-gray-500">quota dell'errore baseline spiegata dall'adapter (R²-like)</span>
            </div>
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-500" />
                <span className="text-gray-400">Baseline Kronos (MSE):</span>
                <span className="font-mono font-semibold text-slate-200">{baseline!.toFixed(4)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                <span className="text-gray-400">Con adapter (MSE):</span>
                <span className="font-mono font-semibold text-emerald-300">{adapter!.toFixed(4)}</span>
              </div>
            </div>
          </div>
          {/* Visual bar: how much of baseline error remains after adapter */}
          <div className="mt-1">
            <div className="flex items-center justify-between text-[9px] text-gray-500 mb-1">
              <span>Errore residuo</span>
              <span>{(100 - Math.max(0, pct!)).toFixed(1)}% del baseline</span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                style={{ width: `${Math.max(0, Math.min(100, 100 - Math.max(0, pct!))).toFixed(1)}%` }}
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Confronto sul validation set (dati non visti in training): MSE del Kronos da solo vs Kronos + adapter.
            Valori più alti = l'adapter corregge una quota maggiore dell'errore del modello base. Negativo = l'adapter peggiora.
          </p>
        </>
      ) : (
        <p className="text-xs text-gray-500">Metrica non ancora disponibile — compare dopo il prossimo addestramento con dati sufficienti.</p>
      )}
    </div>
  );
}

function HorizonTable({ stats }: { stats: AdapterTrainingStats }) {
  const perH = stats.per_horizon_real_samples ?? {};
  const metrics = stats.horizons ?? {};
  const rows = HORIZON_ORDER.map((h) => {
    const real = perH[h] ?? 0;
    const m = metrics[h];
    return {
      h,
      real,
      valSamples: m?.val_samples,
      valMse: m?.val_mse,
      baselineMse: m?.baseline_val_mse,
      improvementPct: m?.improvement_pct,
      predLen: m?.pred_len,
    };
  });

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-300">📊 Copertura per Orizzonte (dati reali)</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-xs text-left text-gray-300">
          <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
            <tr>
              <th className="px-4 py-2.5">Orizzonte</th>
              <th className="px-4 py-2.5">Pred Len</th>
              <th className="px-4 py-2.5">Sample Reali</th>
              <th className="px-4 py-2.5">Val Samples</th>
              <th className="px-4 py-2.5">Baseline MSE</th>
              <th className="px-4 py-2.5">Adapter MSE</th>
              <th className="px-4 py-2.5">Miglioramento</th>
              <th className="px-4 py-2.5">Stato</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => {
              const ok = r.real >= (stats.min_real_samples_required ?? 30);
              const hasMetric = r.valMse !== undefined;
              const tone = improvementTone(r.improvementPct);
              return (
                <tr key={r.h} className="hover:bg-slate-900/40">
                  <td className="px-4 py-2.5 font-semibold text-slate-200">{r.h}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">{r.predLen ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono">{r.real}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">{r.valSamples ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">{hasMetric ? fmt(r.baselineMse, 4) : '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-emerald-300/90">{hasMetric ? fmt(r.valMse, 4) : '—'}</td>
                  <td className="px-4 py-2.5 font-mono font-bold">
                    {hasMetric && r.improvementPct != null ? (
                      <span className={tone.color}>
                        {r.improvementPct >= 0 ? '+' : ''}{r.improvementPct.toFixed(1)}%
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {hasMetric ? (
                      <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-green-500/10 text-green-400 border border-green-500/20">VALUTATO</span>
                    ) : ok ? (
                      <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">PRONTO</span>
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

function RunsHistoryChart({ stats }: { stats: AdapterTrainingStats }) {
  // Longitudinal view: ONE POINT PER DAY (median of the day's runs), stable
  // across weeks. The CI trains every ~5 min during market hours, so a per-run
  // chart was dominated by a single day (300 runs => only ~3 days visible at
  // the old 60-run cap). Aggregating by day makes the time axis meaningful.
  const allRuns = stats.loss_history_runs ?? [];

  const W = 760, H = 250;
  const padL = 52, padR = 52, padT = 14, padB = 34;
  const innerW = W - padL - padR;
  const gap = 12;
  const lossTop = padT;
  const lossH = 132;
  const sampleTop = lossTop + lossH + gap;
  const sampleH = 48;

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Aggregate runs into daily buckets keyed by YYYY-MM-DD. Loss uses the MEDIAN
  // across the day's trained runs (robust to a single bad run, fairer than the
  // mean for a "typical" value). Samples use the day's MAX (peak alignable
  // snapshots, not the noisy run-to-run point value).
  type DayAgg = {
    day: string;               // YYYY-MM-DD
    label: string;             // dd/mm
    train: number | undefined; // median final_train_loss over trained runs
    val: number | undefined;   // median final_val_loss over trained runs
    samplesMax: number;        // max real_samples in the day
    nRuns: number;
    nTrained: number;          // runs that actually saved a checkpoint
  };
  const byDay = new Map<string, DayAgg>();
  for (const r of allRuns) {
    if (!r.ts) continue;
    const day = r.ts.slice(0, 10); // YYYY-MM-DD (UTC, matches the trainer's tz)
    let agg = byDay.get(day);
    if (!agg) {
      const label = new Date(day + 'T00:00:00Z').toLocaleDateString('it-IT', {
        day: '2-digit', month: '2-digit', timeZone: 'UTC',
      });
      agg = { day, label, train: undefined, val: undefined, samplesMax: 0, nRuns: 0, nTrained: 0 };
      byDay.set(day, agg);
    }
    // Entries flagged `aggregated` are already a daily mean produced by the
    // Python two-tier retention — take their values directly instead of
    // folding them into the median again (they are one-per-day by construction).
    if (r.aggregated) {
      agg.nRuns += r.n_runs ?? 1;
      agg.samplesMax = Math.max(agg.samplesMax, r.real_samples ?? 0);
      if (r.trained) agg.nTrained += r.n_runs ?? 1;
      if (r.final_train_loss != null) agg.train = r.final_train_loss;
      if (r.final_val_loss != null) agg.val = r.final_val_loss;
    } else {
      agg.nRuns += 1;
      agg.samplesMax = Math.max(agg.samplesMax, r.real_samples ?? 0);
      if (r.trained) agg.nTrained += 1;
    }
  }
  // Second pass: median loss per day from the RAW (non-aggregated) trained
  // runs of the recent window. Aggregated days already carry their mean and
  // are set above, so they are skipped here.
  const trainedByDay = new Map<string, { train: number[]; val: number[] }>();
  for (const r of allRuns) {
    if (!r.ts || !r.trained || r.aggregated) continue;
    const day = r.ts.slice(0, 10);
    const t = trainedByDay.get(day) ?? { train: [], val: [] };
    if (r.final_train_loss != null && Number.isFinite(r.final_train_loss)) t.train.push(r.final_train_loss);
    if (r.final_val_loss != null && Number.isFinite(r.final_val_loss)) t.val.push(r.final_val_loss);
    trainedByDay.set(day, t);
  }
  for (const [day, t] of trainedByDay) {
    const agg = byDay.get(day);
    if (!agg) continue;
    agg.train = t.train.length ? median(t.train) : undefined;
    agg.val = t.val.length ? median(t.val) : undefined;
  }

  const MAX_DAYS = 45;
  const allDays = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const days = allDays.slice(-MAX_DAYS);

  if (days.length < 2) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-slate-300 mb-2">📉 Storico Loss — confronto giornaliero</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Questo grafico accumula un punto al giorno (mediana delle run), così puoi confrontare l'andamento nel tempo. Sarà popolato dopo i prossimi cicli: servono ≥ 2 giorni registrati.
        </p>
      </div>
    );
  }

  const lossVals = days
    .flatMap((d) => [d.train, d.val])
    .filter((v): v is number => v != null && Number.isFinite(v));
  const maxLoss = lossVals.length ? Math.max(...lossVals) : 1;
  const minLoss = lossVals.length ? Math.min(...lossVals) : 0;
  const lspan = maxLoss - minLoss || 1;
  const yMin = Math.max(0, minLoss - lspan * 0.15);
  const yMax = maxLoss + lspan * 0.15;
  const ySpan = yMax - yMin || 1;

  const maxSamples = Math.max(1, ...days.map((d) => d.samplesMax));

  const n = days.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yLoss = (v: number) => lossTop + lossH - ((v - yMin) / ySpan) * lossH;
  const ySamp = (v: number) => sampleTop + sampleH - (v / maxSamples) * sampleH;

  const linePath = (sel: 'train' | 'val') => {
    let d = '';
    let started = false;
    days.forEach((day, i) => {
      const v = day[sel];
      if (v == null || !Number.isFinite(v)) {
        started = false; // break the line on guard-only days
        return;
      }
      d += `${started ? 'L' : 'M'} ${x(i).toFixed(1)} ${yLoss(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const lossGrid = Array.from({ length: 4 }, (_, i) => yMin + (i / 3) * ySpan);
  // X ticks: one per day when few, else evenly subsample (~8 labels max).
  const tickStep = Math.max(1, Math.ceil(n / 8));
  const tickIdx = Array.from(new Set(
    days.map((_, i) => i).filter((i) => i % tickStep === 0 || i === n - 1),
  ));

  // "Last trained" / "best val" are reported on the RAW run level (not the
  // daily median) so the numbers match what the user sees in the cards above.
  const lastTrainedRun = [...allRuns].reverse().find((r) => r.trained && r.final_val_loss != null);
  const bestValRun = allRuns.reduce<{ v: number | null; ts: string | null }>(
    (acc, r) =>
      r.final_val_loss != null && Number.isFinite(r.final_val_loss) && (acc.v == null || r.final_val_loss < acc.v)
        ? { v: r.final_val_loss, ts: r.ts }
        : acc,
    { v: null, ts: null },
  );
  const totalRuns = allRuns.length;

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-300">📉 Storico Loss — confronto giornaliero</h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1 text-blue-300"><span className="inline-block w-3 h-0.5 bg-blue-400" />train</span>
          <span className="flex items-center gap-1 text-amber-300"><span className="inline-block w-3 h-0.5 bg-amber-400" />val</span>
          <span className="flex items-center gap-1 text-slate-400"><span className="inline-block w-3 h-2 bg-slate-600/60" />sample reali</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="overflow-visible">
        {/* loss panel gridlines + labels */}
        {lossGrid.map((gv, i) => {
          const yy = lossTop + lossH - (i / 3) * lossH;
          return (
            <g key={`g${i}`}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#1e293b" strokeDasharray="3 4" />
              <text x={padL - 6} y={yy + 3} fill="#64748b" fontSize="9" textAnchor="end">{gv.toFixed(3)}</text>
            </g>
          );
        })}
        <text x={padL - 6} y={lossTop - 3} fill="#475569" fontSize="8" textAnchor="end">loss</text>

        {/* sample-count band */}
        <line x1={padL} y1={sampleTop} x2={W - padR} y2={sampleTop} stroke="#1e293b" />
        <line x1={padL} y1={sampleTop + sampleH} x2={W - padR} y2={sampleTop + sampleH} stroke="#334155" />
        {days.map((d, i) => {
          const v = d.samplesMax;
          const bw = Math.max(2, (innerW / n) * 0.6);
          const top = ySamp(v);
          return (
            <rect
              key={`s${i}`}
              x={x(i) - bw / 2}
              y={top}
              width={bw}
              height={Math.max(1, sampleTop + sampleH - top)}
              fill={d.nTrained > 0 ? 'rgba(100,116,139,0.55)' : 'rgba(100,116,139,0.22)'}
            />
          );
        })}
        <text x={padL - 6} y={sampleTop + 8} fill="#64748b" fontSize="9" textAnchor="end">{maxSamples}</text>
        <text x={padL - 6} y={sampleTop + sampleH + 3} fill="#475569" fontSize="8" textAnchor="end">0</text>
        <text x={padL - 6} y={sampleTop + sampleH / 2} fill="#475569" fontSize="8" textAnchor="end">n samp</text>

        {/* loss lines (broken on guard-only days) */}
        <path d={linePath('train')} fill="none" stroke="#60a5fa" strokeWidth="2" />
        <path d={linePath('val')} fill="none" stroke="#fbbf24" strokeWidth="2" strokeDasharray="4 3" />

        {/* hollow markers for guard-only days (no trained run that day) */}
        {days.map((d, i) =>
          d.nTrained > 0 ? null : (
            <circle key={`u${i}`} cx={x(i)} cy={sampleTop + sampleH} r="2.5" fill="#0d1117" stroke="#475569" strokeWidth="1" />
          ),
        )}

        {/* x-axis date labels (one per day, subsampled if many) */}
        {tickIdx.map((idx) => {
          const d = days[idx];
          if (!d) return null;
          return (
            <text key={`t${idx}`} x={x(idx)} y={H - 8} fill="#64748b" fontSize="9" textAnchor="middle">{d.label}</text>
          );
        })}
      </svg>
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[10px] text-gray-500">
        {lastTrainedRun && lastTrainedRun.final_val_loss != null && (
          <span>ultima run addestrata: val <span className="font-mono text-amber-300">{lastTrainedRun.final_val_loss.toFixed(4)}</span></span>
        )}
        {bestValRun.v != null && (
          <span>miglior val: <span className="font-mono text-emerald-300">{bestValRun.v.toFixed(4)}</span></span>
        )}
        <span>giorni: {n}{allDays.length > n ? ` di ${allDays.length}` : ''} · run totali: {totalRuns}</span>
        <span className="text-gray-600">·</span>
        <span>pallini vuoti = giorni senza run addestrate (guard attiva)</span>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Un punto per <b>giorno</b> (mediana delle run del giorno), non per esecuzione: il CI allena ogni ~5 minuti, quindi il grafico per-run mostrava solo mezza giornata. Le barre grigie sono il picco di sample reali allineabili quel giorno — se oscillano è normale (subsampling e budget variabili). I valori <i>ultima run</i> e <i>miglior val</i> si riferiscono alla singola esecuzione, non alla mediana giornaliera.
      </p>
    </div>
  );
}

function LossChart({ stats }: { stats: AdapterTrainingStats }) {
  const hist = stats.loss_history ?? [];
  const W = 760, H = 220, padL = 50, padR = 16, padT = 16, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const { pathTrain, pathVal, maxY, minY, points } = useMemo(() => {
    if (hist.length === 0) return { pathTrain: '', pathVal: '', maxY: 0, minY: 0, points: [] as number[] };
    const all = hist.flatMap((p) => [p.train_loss, p.val_loss]).filter((v) => Number.isFinite(v));
    const maxY = Math.max(...all);
    const minY = Math.min(...all, 0);
    const span = maxY - minY || 1;
    const x = (i: number) => padL + (i / Math.max(1, hist.length - 1)) * innerW;
    const y = (v: number) => padT + innerH - ((v - minY) / span) * innerH;
    const mk = (sel: 'train_loss' | 'val_loss') => hist.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p[sel]).toFixed(1)}`).join(' ');
    return { pathTrain: mk('train_loss'), pathVal: mk('val_loss'), maxY, minY, points: hist.map((_, i) => x(i)) };
  }, [hist]);

  if (hist.length === 0) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-slate-300 mb-2">📈 Curva di Loss</h3>
        <p className="text-xs text-gray-500">Nessuna curva disponibile — l'addestramento non è ancora andato a buon fine (guard attiva).</p>
      </div>
    );
  }

  const gridY = Array.from({ length: 4 }, (_, i) => minY + (i / 3) * (maxY - minY));

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-300">📈 Curva di Loss — ultima esecuzione (per epoca)</h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1 text-blue-300"><span className="inline-block w-3 h-0.5 bg-blue-400" />train</span>
          <span className="flex items-center gap-1 text-amber-300"><span className="inline-block w-3 h-0.5 bg-amber-400" />val</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="overflow-visible">
        {gridY.map((gv, i) => {
          const y = padT + innerH - (i / 3) * innerH;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#1e293b" strokeDasharray="3 4" />
              <text x={padL - 6} y={y + 3} fill="#64748b" fontSize="9" textAnchor="end">{gv.toFixed(3)}</text>
            </g>
          );
        })}
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#334155" />
        <path d={pathTrain} fill="none" stroke="#60a5fa" strokeWidth="2" />
        <path d={pathVal} fill="none" stroke="#fbbf24" strokeWidth="2" strokeDasharray="4 3" />
        {points.map((px, i) =>
          hist.length <= 30 || i % Math.ceil(hist.length / 12) === 0 ? (
            <text key={i} x={px} y={H - padB + 14} fill="#64748b" fontSize="9" textAnchor="middle">{hist[i].epoch}</text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function LiveStatusTable({
  item,
  label,
}: {
  item: KronosForecastItem | null | undefined;
  label: string;
}) {
  if (!item) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-slate-300">{label} — Applicazione Live</h3>
        <p className="text-xs text-gray-500 mt-2">Forecast Kronos non disponibile.</p>
      </div>
    );
  }
  const rows = RES_KEYS.map(({ key, h }) => {
    const res: KronosResolutionForecast | undefined = item[key];
    const st = res?.adapter_status;
    return { h, res, st };
  });

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-300">⚡ {label} — Applicazione Live (ultimo forecast)</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-xs text-left text-gray-300">
          <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
            <tr>
              <th className="px-4 py-2.5">Risoluzione</th>
              <th className="px-4 py-2.5">Adapter</th>
              <th className="px-4 py-2.5">Pred Len</th>
              <th className="px-4 py-2.5">|Residuo|</th>
              <th className="px-4 py-2.5">Covariati (skew / pcr / gex)</th>
              <th className="px-4 py-2.5">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map(({ h, st }) => (
              <tr key={h} className="hover:bg-slate-900/40">
                <td className="px-4 py-2.5 font-semibold text-slate-200">{h}</td>
                <td className="px-4 py-2.5">
                  {st?.applied ? (
                    <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-green-500/10 text-green-400 border border-green-500/20">APPLICATO</span>
                  ) : st?.supported ? (
                    <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">SALTATO</span>
                  ) : (
                    <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-slate-700/40 text-slate-400 border border-slate-700">NESSUN ADAPTER</span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-gray-400">{st?.pred_len ?? '—'}</td>
                <td className="px-4 py-2.5 font-mono">{st?.residual_norm != null ? fmt(st.residual_norm, 4) : '—'}</td>
                <td className="px-4 py-2.5 font-mono text-gray-400 text-[10px]">
                  {st?.covariates
                    ? `${fmt(st.covariates.skew, 2)} / ${fmt(st.covariates.pcr, 2)} / ${fmt(st.covariates.gex_b, 2)}`
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-[10px] text-gray-500">{st?.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const AdapterStatusView: React.FC<AdapterStatusViewProps> = ({ sharedState }) => {
  const { kronosForecast, handleRefresh, refreshing, timeSinceUpdate } = sharedState;
  const [stats, setStats] = useState<AdapterTrainingStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await fetchAdapterStats(true);
      setStats(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const verdict = useMemo(() => computeVerdict(stats), [stats]);

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
          <ControlBar timeSinceUpdate={timeSinceUpdate} refreshing={refreshing} onRefresh={onRefresh} />
        </div>
      </div>

      <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6 w-full">
        {loading && !stats ? (
          <div className="flex flex-col items-center justify-center min-h-[300px] bg-[#161b22] border border-slate-800 rounded-2xl">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-4" />
            <span className="text-gray-400 text-sm">Caricamento statistiche adapter…</span>
          </div>
        ) : (
          <>
            <VerdictCard stats={stats} verdict={verdict} />
            {stats && <StatCards stats={stats} />}
            {stats && <ImprovementCard stats={stats} />}
            {stats && <HorizonTable stats={stats} />}
            {stats && <RunsHistoryChart stats={stats} />}
            {stats && <LossChart stats={stats} />}
            <LiveStatusTable item={kronosForecast?.SP500_bias} label="S&P 500 (SPY)" />
            <LiveStatusTable item={kronosForecast?.NASDAQ_bias} label="Nasdaq 100 (QQQ)" />

            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-slate-300 mb-3">ℹ️ Come funziona</h3>
              <div className="text-xs text-gray-400 space-y-3 max-w-3xl">
                <div>
                  <div className="text-slate-300 font-semibold mb-1">Cosa corregge</div>
                  <p>
                    Kronos produce una previsione di prezzo; l'adapter è un piccolo rete neurale (<b>MLP</b>) che aggiunge una <b>correzione residua</b> sopra quella previsione, usando tre segnali dal mercato delle opzioni:
                    lo <i>skew di volatilità</i> (paura di crash), il rapporto <i>Put/Call OI</i> (bilancio rialzo/ribasso) e il <i>Net GEX</i> (pressione dei dealer sui prezzi).
                    Kronos non viene mai ritrattato: l'adapter lo corregge senza toccarlo, quindi se la correzione è peggiorativa basta non applicarla.
                  </p>
                </div>

                <div>
                  <div className="text-slate-300 font-semibold mb-1">Come impara</div>
                  <p>
                    Un <b>unico modello</b> copre entrambi gli orizzonti attivi (4h e 1d). Per ogni snapshot storico in <code>options_history.json</code> recuperiamo da yfinance le <b>barre di prezzo realizzate</b> nei giorni successivi, e insegniamo all'adapter a prevedere l'errore che Kronos ha effettivamente commesso. L'accumulo di esempi reali continua da solo a ogni ciclo.
                  </p>
                </div>

                <div>
                  <div className="text-slate-300 font-semibold mb-1">Quali garanzie</div>
                  <ul className="list-disc pl-4 space-y-1">
                    <li><b>Guard anti-overfit:</b> il modello viene salvato solo con ≥ 30 esempi reali; altrimenti il vecchio adapter resta intatto.</li>
                    <li><b>Early stopping:</b> il training si ferma se la validazione non migliora per 5 epoche, e viene conservato il punto migliore (non l'ultimo).</li>
                    <li><b>Validazione per orizzonte:</b> la correzione viene applicata live solo sugli orizzonti validati (≥ 5 campioni di validation <i>e</i> miglioramento positivo). Gli altri orizzonti ricevono la previsione Kronos pulita.</li>
                  </ul>
                </div>

                <div>
                  <div className="text-slate-300 font-semibold mb-1">GEX pulito</div>
                  <p>
                    Dal 2026-06-26 la volatilità implicita è calcolata via inversione di Black-Scholes dal prezzo bid/ask e con un fit della smile per scadenza. I record storici precedenti, calcolati con una formula artefatta, sono stati scartati automaticamente.
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
