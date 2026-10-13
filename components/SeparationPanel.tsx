import React, { useMemo } from 'react';
import type { LevelStat } from '../services/dayPlanService';

/**
 * SeparationPanel — il kill-test statistico del track record, sulla dashboard.
 *
 * Risponde alla domanda: le feature dello stato (regime, scenario, divergenza,
 * distanza) separano gli esiti? Se NON separano con n sufficiente, non ha
 * senso addestrare alcun decision model: le regole scritte a mano sono il
 * meglio disponibile. Stessa matematica di scripts/test_separation.py
 * (Fisher exact 2x2, zero dipendenze).
 *
 * @module components/SeparationPanel
 */

interface Rec {
  fut: string;
  key: string;
  kind: string;
  held: boolean;
  date: string;
  regime: string | null;
  scenario: string | null;
  divergence: boolean | null;
  near_mp: boolean | null;
  dist_bucket: string | null;
}

interface Group {
  value: string;
  held: number;
  n: number;
}
interface Table {
  label: string;
  groups: Group[];
  p: number | null;
  nTot: number;
}

const MIN_N = 30;

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Fisher exact two-sided per [[a, b], [c, d]]. */
function fisher(a: number, b: number, c: number, d: number): number | null {
  const r1 = a + b, r2 = c + d, c1 = a + c, c2 = b + d, n = r1 + r2;
  if (n === 0 || Math.min(r1, r2, c1, c2) === 0) return null;
  const prob = (x: number) => (comb(c1, x) * comb(c2, r1 - x)) / comb(n, r1);
  const pObs = prob(a);
  const lo = Math.max(0, r1 - c2), hi = Math.min(r1, c1);
  let tot = 0;
  for (let x = lo; x <= hi; x++) {
    const p = prob(x);
    if (p <= pObs * (1 + 1e-9)) tot += p;
  }
  return Math.min(1, tot);
}

function giudizio(p: number | null, nTot: number): { text: string; tone: string } {
  if (p === null) return { text: 'n/d', tone: 'text-gray-500' };
  const base = `p=${p.toFixed(3)}, n=${nTot}`;
  if (nTot < MIN_N) return { text: `dati insufficienti (${base})`, tone: 'text-gray-500' };
  if (p < 0.05) return { text: `SEPARA ✓ (${base})`, tone: 'text-emerald-400' };
  if (p < 0.10) return { text: `segnale debole (${base})`, tone: 'text-amber-300' };
  return { text: `nessuna differenza (${base})`, tone: 'text-gray-400' };
}

function analyze(stats: Record<string, LevelStat>) {
  const records: Rec[] = [];
  let senza = 0;
  for (const [key, lv] of Object.entries(stats ?? {})) {
    const fut = key.split(':')[0];
    for (const e of lv.history ?? []) {
      if (e.regime === undefined || e.regime === null || e.held === undefined) { senza++; continue; }
      const pct = e.spot ? Math.abs(e.dist_pts ?? 0) / e.spot * 100 : null;
      records.push({
        fut, key,
        kind: e.kind ?? 'pivot',
        held: !!e.held,
        date: e.date ?? '',
        regime: e.regime ?? null,
        scenario: e.scenario ?? null,
        divergence: e.divergence ?? null,
        near_mp: e.near_mp ?? null,
        dist_bucket: pct === null ? null : pct <= 0.3 ? '≤0,3%' : pct <= 1.0 ? '0,3–1%' : '>1%',
      });
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date));
  return { records, senza };
}

function makeTable(records: Rec[], label: string, pick: (r: Rec) => string | null, order?: string[]): Table {
  const groups = new Map<string, Group>();
  let nTot = 0;
  for (const r of records) {
    const v = pick(r);
    if (v === null || v === undefined) continue;
    nTot++;
    const g = groups.get(v) ?? { value: v, held: 0, n: 0 };
    g.n++;
    if (r.held) g.held++;
    groups.set(v, g);
  }
  let vals = [...groups.values()].sort((a, b) => b.n - a.n).map(g => g.value);
  if (order) vals = order.filter(v => groups.has(v)).concat(vals.filter(v => !order?.includes(v)));
  let p: number | null = null;
  if (vals.length >= 2) {
    const g1 = groups.get(vals[0])!, g2 = groups.get(vals[1])!;
    p = fisher(g1.held, g1.n - g1.held, g2.held, g2.n - g2.held);
  }
  const gs = vals.map(v => groups.get(v)!);
  return { label, groups: gs, p, nTot };
}

const rateTone = (held: number, n: number) =>
  n === 0 ? 'text-gray-500' : held / n >= 0.6 ? 'text-emerald-400' : held / n <= 0.4 ? 'text-red-400' : 'text-slate-300';

const MiniTable: React.FC<{ t: Table }> = ({ t }) => (
  <div className="text-[11px]">
    <div className="text-gray-300 font-semibold mb-1">{t.label} <span className="text-gray-600 font-normal">(n={t.nTot})</span></div>
    <div className="flex flex-col gap-0.5">
      {t.groups.map(g => (
        <div key={g.value} className="flex items-center gap-2">
          <span className="w-28 text-gray-500 truncate">{g.value}</span>
          <span className={`font-mono tnum ${rateTone(g.held, g.n)}`}>{g.held}/{g.n}</span>
          <span className="font-mono text-gray-600 tnum">({(g.held / g.n * 100).toFixed(0)}%)</span>
        </div>
      ))}
    </div>
    {t.p !== null && (() => {
      const g = giudizio(t.p, t.nTot);
      return <div className={`text-[10px] mt-1 ${g.tone}`}>→ {g.text}</div>;
    })()}
  </div>
);

export const SeparationPanel: React.FC<{ stats: Record<string, LevelStat> }> = ({ stats }) => {
  const analysis = useMemo(() => analyze(stats), [stats]);
  const { records, senza } = analysis;

  const tables: Table[] = useMemo(() => {
    if (records.length === 0) return [];
    const t: Table[] = [];
    const by = (f: (r: Rec) => string | null, order?: string[], label?: string) =>
      t.push(makeTable(records, label, f, order));
    by(r => r.kind, ['barrier', 'trigger', 'magnet', 'pivot'], 'meccanismo');
    const bar = records.filter(r => r.kind === 'barrier');
    if (bar.length) by(r => r.regime, ['long', 'short'], 'barriera: long vs short gamma');
    const trg = records.filter(r => r.kind === 'trigger');
    if (trg.length) by(r => r.regime, ['long', 'short'], 'trigger: long vs short gamma');
    by(r => r.scenario, ['compressione', 'trend', 'ibrido'], 'scenario');
    by(r => r.divergence === null ? null : (r.divergence ? 'divergenza' : 'allineati'), ['allineati', 'divergenza'], 'divergenza SPY/QQQ');
    by(r => r.near_mp === null ? null : (r.near_mp ? 'vicino' : 'lontano'), ['vicino', 'lontano'], 'vicino al max pain');
    by(r => r.dist_bucket, ['≤0,3%', '0,3–1%', '>1%'], 'distanza dallo spot');
    return t;
  }, [records]);

  const perLevel = useMemo(() => {
    const m = new Map<string, { key: string; held: number; n: number }>();
    for (const r of records) {
      const g = m.get(r.key) ?? { key: r.key, held: 0, n: 0 };
      g.n++;
      if (r.held) g.held++;
      m.set(r.key, g);
    }
    return [...m.values()].filter(v => v.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
  }, [records]);

  if (records.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        Nessun verdetto con snapshot ancora: il track record per mestiere parte
        dal primo cambio di giornata ET dopo l'ultima versione.
      </p>
    );
  }

  const nOk = records.filter(r => r.held).length;
  const sep = tables.filter(t => t.p !== null && t.p < 0.05 && t.nTot >= MIN_N);
  const weak = tables.filter(t => t.p !== null && t.p >= 0.05 && t.p < 0.10 && t.nTot >= MIN_N);
  const verdict = sep.length > 0
    ? { text: `${sep.length} feature separano significativamente (${sep.map(t => t.label).join(', ')}). C'è segnale: il dataset vale per un modello (prima boosting interpretabile, CLM solo dopo).`, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' }
    : weak.length > 0
      ? { text: `Solo segnali deboli (${weak.map(t => t.label).join(', ')}). Accumula verdetti: ripeti il confronto tra 1-2 settimane.`, tone: 'text-amber-300 border-amber-500/30 bg-amber-500/5' }
      : { text: 'Nessuna feature separa con i dati attuali: NON addestrare decision model — le regole scritte a mano sono il meglio disponibile. Ripeti ogni 1-2 settimane.', tone: 'text-gray-400 border-slate-700 bg-slate-900/40' };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] text-gray-500">
        {records.length} verdetti con snapshot · periodo {records[0].date} → {records[records.length - 1].date} ·
        esito positivo {nOk} ({(nOk / records.length * 100).toFixed(0)}%) · ES+NQ aggregati
        {senza > 0 && ` · ${senza} senza snapshot scartati`}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
        {tables.map(t => <MiniTable key={t.label} t={t} />)}
      </div>

      {perLevel.length > 0 && (
        <div className="text-[11px]">
          <div className="text-gray-300 font-semibold mb-1">Per livello (≥2 tocchi)</div>
          <div className="flex flex-col gap-0.5">
            {perLevel.map(v => (
              <div key={v.key} className="flex items-center gap-2">
                <span className="w-40 text-gray-500 truncate">{v.key}</span>
                <span className={`font-mono tnum ${rateTone(v.held, v.n)}`}>{v.held}/{v.n}</span>
                <span className="font-mono text-gray-600 tnum">({(v.held / v.n * 100).toFixed(0)}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={`text-[11px] leading-relaxed rounded-lg border px-3 py-2 ${verdict.tone}`}>
        <b>Verdetto:</b> {verdict.text}
      </div>
    </div>
  );
};
