import React, { useCallback, useEffect, useState } from 'react';
import { UseOptionsDataReturn } from '../hooks/useOptionsData';
import { ControlBar, Labeled, Freshness, Card, Collapsible, Badge, Segmented } from './ui';
import { fetchLevelReport, type LevelReport, type LevelReportKind, type LevelVerdict } from '../services/levelReportService';

/**
 * LevelTrackView — il registro di verità dei livelli operativi.
 *
 * Mostra il track record per famiglia (simbolo × lato × meccanismo gamma):
 * di quante volte il prezzo ha toccato il livello e quante volte l'ha
 * rispettato (bounce) vs violato (break). È il motore di evidenza che dice
 * quali famiglie di livelli funzionano davvero.
 *
 * @module components/LevelTrackView
 */

interface LevelTrackViewProps {
  sharedState: UseOptionsDataReturn;
}

const KIND_ORDER = [
  'SPY|support|pin', 'SPY|support|trigger', 'SPY|resistance|pin', 'SPY|resistance|trigger',
  'QQQ|support|pin', 'QQQ|support|trigger', 'QQQ|resistance|pin', 'QQQ|resistance|trigger',
];

const VERDICT_STYLE: Record<LevelVerdict, { badge: string; icon: string; label: string }> = {
  BOUNCE_EDGE: { badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', icon: '🟢', label: 'Respinge il prezzo' },
  BREAK_EDGE: { badge: 'border-red-500/30 bg-red-500/10 text-red-400', icon: '🔴', label: 'Viene violato' },
  NO_DATA: { badge: 'border-slate-600/40 bg-slate-700/20 text-slate-400', icon: '⚪', label: 'Dati insufficienti' },
};

function fmtRate(r: number | null): string {
  return r != null ? `${(r * 100).toFixed(0)}%` : '—';
}

function WindowFilter({ windowLabel }: { windowLabel: string }) {
  return <span className="text-[10px] text-gray-500">{windowLabel}</span>;
}

export const LevelTrackView: React.FC<LevelTrackViewProps> = ({ sharedState }) => {
  const { handleRefresh, refreshing, timeSinceUpdate, isBackgroundRefreshing, showUpdatedFlash } = sharedState;
  const [report, setReport] = useState<LevelReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [flashVisible, setFlashVisible] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState<'ALL' | 'SPY' | 'QQQ'>('ALL');

  React.useEffect(() => {
    if (showUpdatedFlash) {
      setFlashVisible(true);
      const timer = setTimeout(() => setFlashVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showUpdatedFlash]);

  const load = useCallback(async (force = false) => {
    try {
      setReport(await fetchLevelReport(force));
    } catch (err) {
      console.error('[LevelTrackView] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 60000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = async () => {
    await Promise.all([load(true), handleRefresh()]);
  };

  const kinds = Object.entries(report?.kinds ?? {})
    .filter(([k]) => symbolFilter === 'ALL' || k.startsWith(symbolFilter))
    .sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a[0]);
      const ib = KIND_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  const totalTouched = kinds.reduce((s, [, k]) => s + k.n_touched, 0);

  return (
    <div className="flex-1 flex flex-col">
      <ControlBar
        title="Track Record Livelli"
        icon="📐"
        left={
          <Labeled label="Simbolo">
            <Segmented
              value={symbolFilter}
              onChange={(s) => setSymbolFilter(s)}
              options={[
                { value: 'ALL' as const, label: 'Tutti' },
                { value: 'SPY' as const, label: 'SPY' },
                { value: 'QQQ' as const, label: 'QQQ' },
              ]}
            />
          </Labeled>
        }
        right={
          <Freshness
            timeSinceUpdate={timeSinceUpdate}
            refreshing={refreshing}
            onRefresh={onRefresh}
            isBackgroundRefreshing={isBackgroundRefreshing}
            flashVisible={flashVisible}
          />
        }
      />

      <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6 w-full">
        {loading && !report ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-4">
            <span className="sr-only">Caricamento track record livelli…</span>
            <SkeletonBlock />
            <SkeletonBlock />
          </div>
        ) : !report || kinds.length === 0 ? (
          <Card className="flex flex-col items-center justify-center min-h-[300px] text-center">
            <span className="text-3xl mb-3">📐</span>
            <span className="text-gray-300 text-sm font-semibold mb-2">Track record in accumulo</span>
            <span className="text-gray-500 text-xs max-w-lg">
              Ogni giorno il sistema registra i livelli operativi (5 per lato per simbolo) e li valuta
              sulle barre 5m reali dopo 24 ore. I primi verdetti compaiono quando ogni famiglia raggiunge
              {report ? ` ${report.min_touched_for_verdict}` : ' 20'} touch.
            </span>
          </Card>
        ) : (
          <>
            {/* Riepilogo */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="!p-3">
                <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">Livelli registrati</span>
                <div className="text-2xl font-black text-slate-100 tnum mt-1">{report.total_issued}</div>
              </Card>
              <Card className="!p-3">
                <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">Valutati (24h)</span>
                <div className="text-2xl font-black text-slate-100 tnum mt-1">{report.total_scored}</div>
              </Card>
              <Card className="!p-3">
                <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">Toccati da prezzo</span>
                <div className="text-2xl font-black text-slate-100 tnum mt-1">{totalTouched}</div>
              </Card>
              <Card className="!p-3">
                <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">Famiglie con verdetto</span>
                <div className="text-2xl font-black text-slate-100 tnum mt-1">
                  {kinds.filter(([, k]) => k.verdict !== 'NO_DATA').length}
                </div>
              </Card>
            </div>

            {/* Tabella famiglie */}
            <Card>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 className="text-sm font-bold text-slate-300">📋 Bounce / Break per famiglia</h3>
                <span className="text-[10px] text-gray-500">
                  aggiornato {new Date(report.generated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full text-xs text-left text-gray-300">
                  <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5">Famiglia</th>
                      <th className="px-4 py-2.5" title="Livelli emessi (1 per strike/giorno)">Emessi</th>
                      <th className="px-4 py-2.5" title="Toccati dal prezzo nella finestra 24h">Toccati</th>
                      <th className="px-4 py-2.5" title="Rimbalzi vs violazioni">Bounce / Break</th>
                      <th className="px-4 py-2.5" title="Frazione di touch risolti con rimbalzo. 50% = nessun effetto">Bounce rate</th>
                      <th className="px-4 py-2.5">Verdetto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {kinds.map(([key, k]) => {
                      const [symbol, ltype, sign] = key.split('|');
                      const vs = VERDICT_STYLE[k.verdict];
                      const rateTone = k.bounce_rate == null ? 'text-slate-400'
                        : k.bounce_rate >= 0.6 ? 'text-emerald-400'
                        : k.bounce_rate <= 0.4 ? 'text-red-400'
                        : 'text-slate-300';
                      return (
                        <tr key={key} className="hover:bg-slate-900/40">
                          <td className="px-4 py-2.5">
                            <span className="font-semibold text-slate-200">{symbol} {ltype === 'support' ? 'supporto' : 'resistenza'}</span>{' '}
                            <span className={`text-[9px] font-extrabold uppercase px-1 py-0.5 rounded ${sign === 'pin' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-700/40 text-slate-400'}`}>
                              {sign === 'pin' ? 'Pin' : 'Trigger'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-gray-400">{k.n_issued}</td>
                          <td className="px-4 py-2.5 font-mono text-gray-400">{k.n_touched}</td>
                          <td className="px-4 py-2.5 font-mono tnum">
                            <span className="text-green-400/90">{k.bounces}</span> / <span className="text-red-400/90">{k.breaks}</span>
                          </td>
                          <td className={`px-4 py-2.5 font-mono font-bold tnum ${rateTone}`}>
                            {fmtRate(k.bounce_rate)}
                            {k.ci95 && <span className="text-[9px] text-gray-500 ml-1 font-normal">CI {fmtRate(k.ci95[0])}–{fmtRate(k.ci95[1])}</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`px-2 py-0.5 text-[9px] font-bold rounded border ${vs.badge}`}>{vs.icon} {vs.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* Come funziona il sistema dei livelli */}
        <Collapsible title="Come nascono e vengono giudicati i livelli" icon="🎓" defaultOpen={kinds.length === 0}>
          <div className="text-xs text-gray-400 space-y-3">
            <div>
              <div className="text-slate-300 font-semibold mb-1">Le tre fonti</div>
              <ul className="list-disc pl-4 space-y-1">
                <li><b>Playbook intraday</b> — livelli di prezzo puro dai futures ES/NQ: massimi/minimi di ieri (PDH/PDL), overnight (ONH/ONL), VWAP con bande, aperture, value area di ieri, POC "naked" mai rivalitati.</li>
                <li><b>Muri da opzioni</b> — gli strike con più Open Interest + Volume, pesati per scadenza e distanza. Classificati col <b>segno della gamma</b>: Pin (gamma lunga → respingono) e Trigger (gamma corta → le rotture accelerano).</li>
                <li><b>GEX Flip</b> — il punto di inversione del regime di gamma.</li>
              </ul>
            </div>
            <div>
              <div className="text-slate-300 font-semibold mb-1">Il giudizio</div>
              <p>
                Ogni livello registrato viene osservato per 24h sulle barre 5m reali: <b>touch</b> = il prezzo entra
                nella banda (±0,1%); se poi si allontana di ≥0,2% senza rompere il buffer è un <b>bounce</b> (respinto),
                se supera il buffer è un <b>break</b> (violato). Il <b>bounce rate</b> per famiglia viene confrontato con
                il 50% (nessun effetto) con una binomiale esatta: sotto i dati minimi non viene emesso alcun verdetto.
              </p>
            </div>
            <div>
              <div className="text-slate-300 font-semibold mb-1">Cosa abbiamo già imparato</div>
              <p>
                Validazione out-of-sample (set 2026): i muri da puro Open Interest come supporti hanno retto <b>meno del
                caso</b> (42% vs 63%); i picchi di gamma lunga hanno respinto l'<b>80%</b> dei touch. Per questo i Pin
                hanno priorità sui muri da OI puro.
              </p>
            </div>
          </div>
        </Collapsible>
      </div>
    </div>
  );
};

function SkeletonBlock() {
  return <div className="animate-pulse rounded-2xl bg-[#161b22] border border-slate-800 h-40 w-full" />;
}
