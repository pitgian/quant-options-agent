import React, { useCallback, useEffect, useState } from 'react';
import {
  fetchSkillReport,
  fetchAlphaLab,
  type SkillReport,
  type AlphaLab,
  type SkillVerdict,
} from '../services/skillReportService';

/**
 * Alpha Lab banner — the honest scoreboard of the self-improvement loop.
 *
 * Shows, per (symbol, horizon): the DEDUPED skill vs the naive "price does
 * not move" baseline, the ALPHA/NO_ALPHA/ANTI verdict, and which correction
 * the walk-forward champion is currently applying (model / dampen /
 * passthrough / observe). Data comes from the CI-run skill_evaluator +
 * alpha_lab on the data branch.
 */

const GROUPS = ['SPY|4h', 'SPY|1d', 'QQQ|4h', 'QQQ|1d'] as const;

const VERDICT_STYLE: Record<SkillVerdict, { badge: string; icon: string; label: string }> = {
  ALPHA: { badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', icon: '🟢', label: 'ALFA' },
  NO_ALPHA: { badge: 'border-slate-600/40 bg-slate-700/20 text-slate-400', icon: '⚪', label: 'Nessun alfa' },
  ANTI: { badge: 'border-red-500/30 bg-red-500/10 text-red-400', icon: '🔴', label: 'Anti-predittivo' },
};

const MODE_LABEL: Record<string, { text: string; hint: string }> = {
  model: { text: 'Modello attivo', hint: 'il campione walk-forward corregge il forecast' },
  dampen: { text: 'Smorzato ×0.15', hint: 'il forecast è peggio del caso: ampiezza ridotta' },
  passthrough: { text: 'Già valido', hint: 'il forecast emesso batte il naive: nessuna correzione' },
  observe: { text: 'Osservazione', hint: 'dati insufficienti: nessuna correzione' },
};

function skillTone(skill: number | null): string {
  if (skill === null) return 'text-slate-400';
  if (skill >= 5) return 'text-emerald-400';
  if (skill >= -5) return 'text-amber-400';
  return 'text-red-400';
}

export const AlphaLabView: React.FC = () => {
  const [report, setReport] = useState<SkillReport | null>(null);
  const [lab, setLab] = useState<AlphaLab | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (force = false) => {
    try {
      const [r, l] = await Promise.all([fetchSkillReport(force), fetchAlphaLab(force)]);
      setReport(r);
      setLab(l);
    } catch (err) {
      console.error('[AlphaLabView] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 120000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !report) {
    return (
      <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-slate-300">🧪 Alpha Lab</h3>
        <p className="text-xs text-gray-500 mt-2">Caricamento valutazione skill…</p>
      </div>
    );
  }

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-300">🧪 Alpha Lab — il sistema trova un alfa?</h3>
        {report && (
          <span className="text-[10px] text-gray-500">
            {report.total_distinct_targets} target distinti valutati
            {report.duplication_factor > 1 && <> · deduplicati da {report.total_scored_snapshots} snapshot</>}
            {' · '}aggiornato {new Date(report.generated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {GROUPS.map((key) => {
          const g = report?.groups?.[key];
          const l = lab?.groups?.[key];
          const verdict: SkillVerdict = g?.verdict ?? 'NO_ALPHA';
          const vs = VERDICT_STYLE[verdict];
          const mode = MODE_LABEL[l?.mode ?? 'observe'] ?? MODE_LABEL.observe;
          return (
            <div key={key} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">{key.replace('|', ' · ')}</span>
                <span className={`px-2 py-0.5 text-[9px] font-bold rounded border ${vs.badge}`}>{vs.icon} {vs.label}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-black ${skillTone(g?.skill_vs_naive_pct ?? null)}`}>
                  {g ? `${g.skill_vs_naive_pct > 0 ? '+' : ''}${g.skill_vs_naive_pct.toFixed(1)}%` : '—'}
                </span>
                <span className="text-[9px] text-gray-500">skill vs naive</span>
              </div>
              <div className="text-[10px] text-gray-500 flex flex-col gap-0.5">
                <span>n={g?.n_targets ?? 0} target · MAE {g ? `${g.mae_model_pct.toFixed(2)}%` : '—'} vs naive {g ? `${g.mae_naive_pct.toFixed(2)}%` : '—'}</span>
                <span>
                  Correzione: <b className="text-slate-300">{mode.text}</b>
                  {l?.champion && l.champion !== 'naive_zero' && <> <span className="text-gray-600">({l.champion})</span></>}
                </span>
                {g?.direction?.accuracy_pct != null && (
                  <span>dir {g.direction.accuracy_pct.toFixed(0)}%{g.direction.p_value != null && g.direction.p_value < 0.05 ? ' ✱sign.' : ''}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        <b className="text-slate-400">Come si legge:</b> lo skill è confrontato con la previsione banale «il prezzo non si muove» —
        positiva significa che il sistema batte il caso, negativa che lo peggiora. Ogni run CI ripete il torneo walk-forward
        sui target <i>deduplicati</i> (una valutazione per scadenza, non per snapshot) e promuove un modello correttore
        solo se batte il naive in modo statisticamente significativo (test dei segni appaiato p&lt;0.05).
        Con il tempo, man mano che il track record cresce, si sbloccano modelli più ricchi (ricalibrazione lineare →
        regressione su feature tecniche/opzioni). Nessuna correzione viene applicata senza superare i gate anti-peeggioramento.
      </p>
    </div>
  );
};
