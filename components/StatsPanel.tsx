import React from 'react';
import type { LevelStat } from '../services/dayPlanService';

/**
 * StatsPanel — affidabilità storica per livello, ordinata per occorrenze.
 * È il "perché fidarsi" del foglio: ogni riga è un livello con il suo
 * computo reale (rispettato X volte su N).
 *
 * In cima: il head-to-head ⚖️ ETF vs INDICI — le due fonti hanno track
 * record SEPARATO (chiave con suffisso -IDX = catena indici) e qui viene
 * confrontato: quale fonte fa il suo mestiere più spesso.
 */

interface ChainAgg { n: number; held: number; levels: number }

const chainOf = (name: string): 'index' | 'etf' => {
  const levelName = name.includes(':') ? name.split(':')[1] : name;
  return levelName.endsWith('-IDX') ? 'index' : 'etf';
};

const KIND_LABEL: Record<string, string> = {
  magnet: '🧲 Magnete',
  barrier: '🛡 Barriera/Pin',
  trigger: '⚡ Trigger',
  pivot: 'Pivot',
  reference: 'Riferimento',
};

const MIN_N_VERDICT = 15;  // sotto questa soglia il verdetto è prematuro

const RateRow: React.FC<{
  label: string; agg: ChainAgg; rate: number | null; accent: string;
}> = ({ label, agg, rate, accent }) => (
  <div className="flex items-center gap-2.5">
    <span className={`text-[10px] font-bold w-24 shrink-0 ${accent}`}>{label}</span>
    <div className="flex-1 h-2.5 rounded-full bg-slate-800 overflow-hidden min-w-[80px]">
      {rate !== null && (
        <div className={`h-full rounded-full ${accent === 'text-violet-300' ? 'bg-violet-400' : 'bg-emerald-400'}`}
             style={{ width: `${Math.round(rate * 100)}%` }} />
      )}
    </div>
    <span className="text-[11px] font-mono font-bold tnum w-12 text-right text-slate-200">
      {rate !== null ? `${(rate * 100).toFixed(0)}%` : '—'}
    </span>
    <span className="text-[9px] font-mono text-gray-500 w-20 text-right tnum">
      {agg.n > 0 ? `${agg.held}/${agg.n} · ${agg.levels} liv.` : '—'}
    </span>
  </div>
);

export const StatsPanel: React.FC<{ stats: Record<string, LevelStat> }> = ({ stats }) => {
  const rows = Object.values(stats ?? {}).sort((a, b) => b.n - a.n);

  // --- aggregazione per fonte (etf = chiave senza -IDX, index = con -IDX) ---
  const etf: ChainAgg = { n: 0, held: 0, levels: 0 };
  const idx: ChainAgg = { n: 0, held: 0, levels: 0 };
  const perInst: Record<string, { etf: ChainAgg; idx: ChainAgg }> = {};
  const kindAgg: Record<string, { etf: ChainAgg; idx: ChainAgg }> = {};
  for (const s of rows) {
    const c = chainOf(s.name);
    const inst = s.name.includes(':') ? s.name.split(':')[0] : '—';
    perInst[inst] ??= { etf: { n: 0, held: 0, levels: 0 }, idx: { n: 0, held: 0, levels: 0 } };
    const t = c === 'index' ? idx : etf;
    const ti = c === 'index' ? perInst[inst].idx : perInst[inst].etf;
    t.n += s.n; t.held += s.held; t.levels += 1;
    ti.n += s.n; ti.held += s.held; ti.levels += 1;
    // per meccanismo: i verdetti giornalieri nella history
    for (const h of s.history ?? []) {
      const k = h.kind ?? '?';
      kindAgg[k] ??= { etf: { n: 0, held: 0, levels: 0 }, idx: { n: 0, held: 0, levels: 0 } };
      const tk = c === 'index' ? kindAgg[k].idx : kindAgg[k].etf;
      tk.n += 1;
      if (h.held) tk.held += 1;
    }
  }

  const etfRate = etf.n > 0 ? etf.held / etf.n : null;
  const idxRate = idx.n > 0 ? idx.held / idx.n : null;
  const bothHaveData = etf.n > 0 && idx.n > 0;
  const enoughSample = Math.min(etf.n, idx.n) >= MIN_N_VERDICT;
  let verdict: React.ReactNode = null;
  if (bothHaveData) {
    const diff = Math.round((idxRate! - etfRate!) * 100);
    if (!enoughSample) {
      verdict = (
        <span className="text-slate-400">
          {diff > 0 ? `gli indici stanno tenendo meglio (+${diff} pt)` : diff < 0 ? `gli ETF stanno tenendo meglio (+${-diff} pt)` : 'pari merito'}
          {' — '}<span className="text-amber-400/80">campione ancora piccolo: serve almeno ~15 tocchi per fonte</span>
        </span>
      );
    } else if (diff > 2) {
      verdict = <span className="text-violet-300 font-semibold">gli INDICI tengono meglio (+{diff} pt sull'ETF)</span>;
    } else if (diff < -2) {
      verdict = <span className="text-emerald-300 font-semibold">gli ETF tengono meglio (+{-diff} pt sugli indici)</span>;
    } else {
      verdict = <span className="text-slate-300">pari merito (±{Math.abs(diff)} pt)</span>;
    }
  } else if (idx.n === 0 && etf.n > 0) {
    verdict = (
      <span className="text-slate-400">
        i livelli indici non sono stati ancora toccati: sono <b className="text-slate-300">muri strutturali</b> a
        ±3-4% dallo spot — il campione cresce solo nei giorni di grandi movimenti. Gli ETF, vicini allo spot,
        vengono toccati quasi ogni giorno.
      </span>
    );
  }

  const kinds = Object.keys(kindAgg)
    .filter(k => kindAgg[k].etf.n + kindAgg[k].idx.n >= 3)
    .sort((a, b) => (kindAgg[b].etf.n + kindAgg[b].idx.n) - (kindAgg[a].etf.n + kindAgg[a].idx.n));

  return (
    <div className="flex flex-col gap-4">
      {/* ⚖️ HEAD-TO-HEAD: ETF vs INDICI */}
      {(etf.n > 0 || idx.n > 0) && (
        <div className="rounded-lg border border-slate-800 bg-[#0d1117] p-3.5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <h4 className="text-xs font-bold text-slate-200">⚖️ ETF vs Indici — quale fonte tiene meglio?</h4>
            <span className="text-[9px] text-gray-500">track record separato per fonte · aggiornato a ogni giornata completata</span>
          </div>
          <div className="flex flex-col gap-2">
            <RateRow label={`📊 ETF (SPY/QQQ)`} agg={etf} rate={etfRate} accent="text-emerald-300" />
            <RateRow label={`🏛 Indici (SPX/NDX)`} agg={idx} rate={idxRate} accent="text-violet-300" />
          </div>
          {verdict && (
            <p className="text-[11px] leading-relaxed mt-3 pt-2.5 border-t border-slate-800/70">
              <span className="font-bold text-slate-200">Verdetto: </span>{verdict}
            </p>
          )}
          {/* per strumento */}
          {Object.keys(perInst).length > 1 && (etf.n > 0 || idx.n > 0) && (
            <div className="mt-3 pt-2.5 border-t border-slate-800/70 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {Object.entries(perInst).map(([inst, p]) => (
                <div key={inst} className="text-[10px] text-gray-400 flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-slate-300">{inst}</span>
                  <span className="text-emerald-400/90">ETF {(p.etf.n > 0 ? `${Math.round(p.etf.held / p.etf.n * 100)}% (${p.etf.n})` : '—')}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-violet-400/90">Indici {(p.idx.n > 0 ? `${Math.round(p.idx.held / p.idx.n * 100)}% (${p.idx.n})` : '—')}</span>
                </div>
              ))}
            </div>
          )}
          {/* per meccanismo */}
          {kinds.length > 0 && (
            <div className="mt-3 pt-2.5 border-t border-slate-800/70">
              <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold mb-1.5">Per meccanismo (verdetto giornaliero)</div>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-semibold py-0.5">Meccanismo</th>
                    <th className="text-right font-semibold py-0.5">ETF</th>
                    <th className="text-right font-semibold py-0.5">Indici</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300 font-mono">
                  {kinds.map(k => {
                    const a = kindAgg[k];
                    return (
                      <tr key={k}>
                        <td className="py-0.5 text-left font-sans">{KIND_LABEL[k] ?? k}</td>
                        <td className="py-0.5 text-right text-emerald-400/90 tnum">
                          {a.etf.n > 0 ? `${Math.round(a.etf.held / a.etf.n * 100)}% (${a.etf.n})` : '—'}
                        </td>
                        <td className="py-0.5 text-right text-violet-400/90 tnum">
                          {a.idx.n > 0 ? `${Math.round(a.idx.held / a.idx.n * 100)}% (${a.idx.n})` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* tabella per livello */}
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500">
          Ancora nessuna occorrenza valutata: il conteggio parte dal primo piano pubblicato
          e cresce di una osservazione per giorno di mercato.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full text-xs text-left text-gray-300">
            <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Livello</th>
                <th className="px-4 py-2.5">Occorrenze</th>
                <th className="px-4 py-2.5" title="Quante volte il livello ha fatto il suo mestiere: barriera = non ceduta o respinta · trigger = rottura con follow-through · magnete = la giornata ha chiuso sul livello">Ha funzionato</th>
                <th className="px-4 py-2.5">Affidabilità</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map(r => {
                const tone = r.rate >= 0.6 ? 'text-emerald-400' : r.rate <= 0.4 ? 'text-red-400' : 'text-slate-300';
                const isIdx = chainOf(r.name) === 'index';
                return (
                  <tr key={r.name} className="hover:bg-slate-900/40">
                    <td className="px-4 py-2.5 font-semibold text-slate-200">
                      {r.name.includes(':') && (
                        <span className="mr-1.5 text-[9px] font-mono font-bold text-slate-500">{r.name.split(':')[0]}</span>
                      )}
                      {r.nome_it}
                      <span className={`ml-1.5 text-[8px] font-extrabold uppercase px-1 py-0.5 rounded border whitespace-nowrap ${isIdx
                        ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                        : 'bg-emerald-500/10 text-emerald-400/80 border-emerald-500/20'}`}>
                        {isIdx ? 'indice' : 'ETF'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-400">{r.n}</td>
                    <td className="px-4 py-2.5 font-mono tnum">
                      <span className="text-emerald-400/90">{r.held}</span>
                      <span className="text-gray-600"> / {r.n}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`font-mono font-bold tnum ${tone}`}>{(r.rate * 100).toFixed(0)}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
