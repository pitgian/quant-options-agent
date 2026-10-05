import React from 'react';
import { Card } from './ui';
import type { LevelStat } from '../services/dayPlanService';

/**
 * StatsPanel — affidabilità storica per livello, ordinata per occorrenze.
 * È il "perché fidarsi" del foglio: ogni riga è un livello con il suo
 * computo reale (rispettato X volte su N).
 */
export const StatsPanel: React.FC<{ stats: Record<string, LevelStat> }> = ({ stats }) => {
  const rows = Object.values(stats ?? {}).sort((a, b) => b.n - a.n);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        Ancora nessuna occorrenza valutata: il conteggio parte dal primo piano pubblicato
        e cresce di una osservazione per giorno di mercato.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full text-xs text-left text-gray-300">
        <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
          <tr>
            <th className="px-4 py-2.5">Livello</th>
            <th className="px-4 py-2.5">Occorrenze</th>
            <th className="px-4 py-2.5" title="Quante volte il livello ha retto (rimbalzo senza violazione)">Rispettato</th>
            <th className="px-4 py-2.5">Affidabilità</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map(r => {
            const tone = r.rate >= 0.6 ? 'text-emerald-400' : r.rate <= 0.4 ? 'text-red-400' : 'text-slate-300';
            return (
              <tr key={r.name} className="hover:bg-slate-900/40">
                <td className="px-4 py-2.5 font-semibold text-slate-200">{r.nome_it}</td>
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
  );
};
