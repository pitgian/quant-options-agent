import React, { useEffect, useState } from 'react';
import { fetchDayPlan, fetchLevelStats, fetchLiveSpot, type DayPlan, type LiveSpot } from '../services/dayPlanService';
import { Ladder } from './Ladder';
import { Card } from './ui';
import { SessionProfileChart } from './SessionProfileChart';

/**
 * DayView — la pagina operativa: lettura AMT, scala dei livelli, profilo
 * della seduta. Tutto ció che serve durante la giornata, nient'altro.
 */
export const DayView: React.FC<{ futures: 'ES' | 'NQ' }> = ({ futures }) => {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [stats, setStats] = useState<Record<string, { n: number; held: number; rate: number }>>({});
  const [live, setLive] = useState<LiveSpot | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await fetchDayPlan(futures);
      const s = await fetchLevelStats();
      if (!alive) return;
      setPlan(p);
      setStats(s ?? {});
    })();
    return () => { alive = false; };
  }, [futures]);

  // prezzo live ogni 15s (fallback: chiusura del piano)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchLiveSpot();
      if (alive && s) setLive(s);
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const spot = (futures === 'ES' ? live?.ES : live?.NQ) ?? plan?.last_price ?? 0;

  if (!plan) {
    return (
      <Card className="flex flex-col items-center justify-center min-h-[280px] text-center">
        <span className="text-3xl mb-3">📈</span>
        <span className="text-gray-300 text-sm font-semibold mb-1">Piano del giorno non ancora generato</span>
        <span className="text-gray-500 text-xs max-w-md">
          Il pipeline lo pubblica automaticamente al primo giro di mercato.
          Torna tra poco o lancia il workflow dal repository.
        </span>
      </Card>
    );
  }

  const dayChange = spot && plan.last_price ? spot - plan.last_price : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Lettura del giorno */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <h3 className="text-sm font-bold text-slate-200">📰 Lettura del giorno — Auction Market Theory</h3>
          <span className="text-[10px] text-gray-500">
            piano delle {new Date(plan.generated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <ul className="text-xs text-gray-300 space-y-1.5">
          {plan.read.map((s, i) => (
            <li key={i} className="flex gap-2 leading-relaxed">
              <span className="text-blue-400 font-bold">{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* LA SCALA */}
      <Card className="!p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-slate-200">🎯 La scala — livelli di oggi</h3>
          <span className="text-[10px] text-gray-500">distanza in punti · 🧲 magnete · 🛡 barriera · ⚡ trigger</span>
        </div>
        <Ladder levels={plan.levels} spot={spot} futures={futures} stats={stats} />
      </Card>


      {/* Profilo di oggi con i livelli operativi sovrapposti alla loro
          altezza di prezzo: e' la VISTA ESPERTA — un solo grafico che mostra
          volumi + ogni livello al suo posto. */}
      {/* 🗺️ Profilo di oggi + mappa dei livelli: un solo grafico con volumi,
          Value Area e ogni livello operativo alla sua altezza di prezzo. */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-slate-200">🗺️ Profilo di oggi + mappa dei livelli</h3>
          <span className="text-[10px] text-gray-500">volumi della seduta · Value Area · livelli alla loro altezza</span>
        </div>
        <SessionProfileChart
          profile={plan.profile_today}
          spotFut={spot}
          vwap={plan.vwap}
          ibHigh={plan.ib?.high ?? undefined}
          ibLow={plan.ib?.low ?? undefined}
          overlays={plan.levels
            .filter(l =>
              l.kind === 'magnet' || l.kind === 'barrier' ||
              ['PDH', 'PDL', 'ONH', 'ONL'].includes(l.name))
            .slice(0, 10)
            .map(l => ({
              price: l.price,
              label: `${l.nome_it} ${Math.round(l.price)}`,
              color: l.gamma === 'pin' ? '#34d399'
                   : l.gamma === 'trigger' ? '#fbbf24'
                   : l.kind === 'magnet' ? '#c084fc'
                   : '#60a5fa',
            }))}
          futuresSymbol={futures}
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          {[
            ['VAH oggi', plan.developing_va_h],
            ['POC oggi', plan.developing_poc],
            ['VAL oggi', plan.developing_va_l],
            ['VWAP', plan.vwap],
          ].map(([label, v]) => (
            <div key={String(label)} className="bg-[#0d1117] border border-slate-800 rounded-xl p-2.5">
              <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">{String(label)}</span>
              <div className="text-sm font-mono font-bold text-slate-100 tnum mt-0.5">
                {v ? futures + ' ' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
              </div>
            </div>
          ))}
        </div>
      </Card>

    </div>
  );
};
