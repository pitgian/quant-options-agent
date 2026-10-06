import React, { useEffect, useMemo, useState } from 'react';
import { fetchDayPlan, fetchLevelStats, fetchLiveSpot, type DayPlan, type DayPlanLevel, type LiveSpot } from '../services/dayPlanService';
import { buildLadder, type LadderLevel } from '../lib/auction';
import { Ladder } from './Ladder';
import { Card, Badge } from './ui';

const fmtGexCompact = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 0 });

/**
 * DayView — i livelli OPERATIVI DA OPZIONI del giorno.
 *
 * Solo fonti opzioni: GEX flip, muri gamma (pin/barriera/trigger), max pain,
 * top strike per gamma assoluta. Ogni livello porta l'affidabilità storica
 * dal track record.
 */
export const DayView: React.FC<{ futures: 'ES' | 'NQ' }> = ({ futures }) => {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [stats, setStats] = useState<Record<string, { n: number; held: number; rate: number }>>({});
  const [live, setLive] = useState<LiveSpot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [p, s] = await Promise.all([fetchDayPlan(futures), fetchLevelStats()]);
      if (!alive) return;
      setPlan(p);
      setStats(s ?? {});
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [futures]);

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

  // SOLO livelli da opzioni + max pain (i livelli di prezzo — VWAP, max/min,
  // value — non fanno parte di questo strumento)
  const optLevels: DayPlanLevel[] = useMemo(() => {
    if (!plan) return [];
    const out: DayPlanLevel[] = plan.levels.filter(l => l.source === 'options');
    if (plan.max_pain_nearest) {
      out.push({
        name: 'MAXPAIN-0DTE',
        nome_it: 'Max Pain scadenza vicina',
        price: plan.max_pain_nearest,
        kind: 'magnet',
        source: 'options',
        dist_pts: Math.round(plan.max_pain_nearest - spot),
      } as DayPlanLevel);
    }
    if (plan.max_pain_all) {
      out.push({
        name: 'MAXPAIN-ALL',
        nome_it: 'Max Pain (tutte le scadenze)',
        price: plan.max_pain_all,
        kind: 'magnet',
        source: 'options',
        dist_pts: Math.round(plan.max_pain_all - spot),
      } as DayPlanLevel);
    }
    // I muri gamma del profilo per strike entrano nella scala come livelli a
    // sé — ma SOLO i top 3 per lato per |GEX|: i minori restano visibili come
    // barra sulla loro zona (se esiste) senza creare righe proprie. Il
    // clustering può fonderli con i muri OI+Volume vicini (= confluenza), così
    // anche il muro più grande, prima invisibile se cadeva tra le zone, entra.
    const gammaSorted = [...(plan.top_gamma ?? [])].sort((a, b) => Math.abs(b.net_gex) - Math.abs(a.net_gex));
    const top3 = new Set([
      ...gammaSorted.filter(t => t.strike_fut >= spot).slice(0, 3),
      ...gammaSorted.filter(t => t.strike_fut < spot).slice(0, 3),
    ]);
    for (const t of top3) {
      const zone = Math.round(t.strike_fut / 5) * 5;
      out.push({
        name: `GAMMA-${zone}`,
        nome_it: `Muro gamma ${fmtGexCompact.format(t.net_gex)} (${t.sign === 'long' ? 'pin' : 'trigger'})`,
        price: zone,
        kind: t.sign === 'long' ? 'barrier' : 'trigger',
        source: 'options',
        dist_pts: Math.round(zone - spot),
        gamma: t.sign === 'long' ? 'pin' : 'trigger',
      } as DayPlanLevel);
    }
    return out;
  }, [plan, spot]);

  const gexFlip = plan?.levels.find(l => l.name === 'GEX-FLIP');
  const regime = plan?.levels.find(l => l.name === 'GEX-FLIP');

  if (!plan) {
    return (
      <Card className="flex flex-col items-center justify-center min-h-[280px] text-center">
        <span className="text-3xl mb-3">⚙️</span>
        <span className="text-gray-300 text-sm font-semibold mb-1">Piano opzioni non ancora generato</span>
        <span className="text-gray-500 text-xs max-w-md">
          Il pipeline lo pubblica al primo giro di mercato (ogni 5 minuti in seduta).
        </span>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Regime gamma */}
      <Card className="!p-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">Regime gamma</span>
            {gexFlip ? (
              <Badge tone={spot > gexFlip.price ? 'good' : 'bad'}
                     title={spot > gexFlip.price
                       ? 'Sopra il flip: dealer long gamma — volatilità contenuta, i livelli respingono (pin)'
                       : 'Sotto il flip: dealer short gamma — i movimenti si amplificano (trend)'}>
                {spot > gexFlip.price ? '▲ Long gamma (mean reversion)' : '▼ Short gamma (trend/amplificazione)'}
              </Badge>
            ) : '—'}
            {gexFlip && (
              <span className="text-[11px] font-mono text-gray-400 tnum">
                Flip {futures} {gexFlip.price.toLocaleString()}
              </span>
            )}
          </div>
          <span className="text-[10px] text-gray-500">
            piano delle {new Date(plan.generated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </Card>

      {/* LA SCALA — solo opzioni */}
      <Card className="!p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-slate-200">🎯 La scala — livelli opzioni</h3>
          <span className="text-[10px] text-gray-500">distanza in punti · 🧲 magnete · 🛡 barriera · ⚡ trigger · barra GEX 🟢 pin / 🔴 trigger</span>
        </div>
        <Ladder levels={optLevels} spot={spot} futures={futures} stats={stats} maxPerSide={7} topGamma={plan.top_gamma} />
        <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
          Solo livelli derivati da opzioni: GEX flip, muri gamma, max pain.
          Pin = gamma lunga (respinge) · Trg = gamma corta (accelera) · Magnete = il prezzo tende a tornarci.
          La barra a destra di ogni zona è il GEX netto degli strike lì caduti:
          più è lunga più il muro è denso, verde respinge / rossa amplifica.
        </p>
      </Card>
    </div>
  );
};
