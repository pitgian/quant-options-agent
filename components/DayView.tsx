import React, { useEffect, useMemo, useState } from 'react';
import { fetchDayPlanFile, fetchLevelStats, fetchLiveSpot, type DayPlan, type DayPlanLevel, type LiveSpot } from '../services/dayPlanService';
import { buildLadderForPlan } from './Ladder';
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
  const [otherPlan, setOtherPlan] = useState<DayPlan | null>(null);
  const [stats, setStats] = useState<Record<string, { n: number; held: number; rate: number }>>({});
  const [live, setLive] = useState<LiveSpot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [file, s] = await Promise.all([fetchDayPlanFile(), fetchLevelStats()]);
      if (!alive) return;
      setPlan(file?.plans?.[futures] ?? null);
      setOtherPlan(file?.plans?.[futures === 'ES' ? 'NQ' : 'ES'] ?? null);
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
    const id = setInterval(tick, 10000);
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
  const flip0 = plan?.gex_flip_0dte;
  const regime = plan?.levels.find(l => l.name === 'GEX-FLIP');

  // Lettura operativa: i due livelli adiacenti allo spot (sopra/sotto) e cosa
  // ci si aspetta da ciascuno in base al meccanismo. maxPerSide alto: voglio
  // il VERO adiacente, non il top-ranked.
  // Tutte le zone della scala (raggio pieno): usate dalla lettura e dallo scenario.
  const ladderAll = useMemo(
    () => (plan ? buildLadderForPlan(optLevels, spot, plan.top_gamma, 99) : null),
    [plan, spot, optLevels],
  );

  const lettura = useMemo(() => {
    if (!plan || !spot) return null;
    const { above, below } = ladderAll!;
    const nearest = (arr: typeof above) =>
      [...arr].sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0] ?? null;
    const up = nearest(above);
    const dn = nearest(below);
    if (!up && !dn) return null;
    return { up, dn };
  }, [plan, spot, ladderAll]);

  // Scenario GEX × Max Pain (configurazioni A/B/C) + divergenza SPY/QQQ.
  //  A compressione: long gamma + max pain vicino → gravità rafforzata
  //  B trend:        short gamma + max pain lontano → gravità inefficace
  //  C checkpoint:   un muro barriera frapposto tra spot e max pain
  //  ibridi (long+lontano / short+vicino): deriva lenta / tensione
  const scenario = useMemo(() => {
    if (!plan || !spot || !ladderAll) return null;
    const NEAR_MP_PCT = 0.004;  // "vicino" al max pain: entro lo 0,4%
    const parts: string[] = [];
    let tag: 'compressione' | 'trend' | 'ibrido' | null = null;
    const mp = plan.max_pain_nearest;
    const regimeLong = gexFlip ? spot > gexFlip.price : null;
    const fmtDist = (d: number) => `${d > 0 ? '+' : ''}${Math.round(d).toLocaleString('it-IT')} pt`;

    if (mp && regimeLong !== null) {
      const dist = mp - spot;
      const near = Math.abs(dist) / spot < NEAR_MP_PCT;
      if (regimeLong && near) {
        tag = 'compressione';
        parts.push(`long gamma e max pain a ${fmtDist(dist)}: la gravità del livello è rafforzata dal regime — favorita la rotazione attorno a ${Math.round(mp).toLocaleString('it-IT')}`);
      } else if (!regimeLong && !near) {
        tag = 'trend';
        parts.push(`short gamma e max pain a ${fmtDist(dist)} (${(dist / spot * 100).toFixed(1)}%): la gravità del max pain perde efficacia — momentum favorito`);
      } else if (regimeLong) {
        tag = 'ibrido';
        parts.push(`long gamma ma max pain lontano: deriva lenta, i muri sul percorso attenuano ogni spinta`);
      } else {
        tag = 'ibrido';
        parts.push(`short gamma con max pain vicino: le coperture incontrano la gravità del livello — volatilità in avvicinamento`);
      }
      // C. checkpoint: un muro barriera tra lo spot e il max pain
      const lo = Math.min(spot, mp), hi = Math.max(spot, mp);
      const wall = [...ladderAll.above, ...ladderAll.below]
        .filter(z => z.kind === 'barrier' && z.price > lo && z.price < hi)
        .sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0] ?? null;
      if (wall) parts.push(`checkpoint verso il max pain: ${wall.label} a ${Math.round(wall.price).toLocaleString('it-IT')} — la rotura apre il riallineamento`);
      if (plan.gex_flip_0dte && regimeLong) parts.push('scadenza oggi: la convergenza verso il max pain tende ad accelerare in chiusura');
    }

    // Divergenza SPY/QQQ: i due regimi sono d'accordo?
    const oFlip = otherPlan?.levels.find(l => l.name === 'GEX-FLIP');
    if (gexFlip && oFlip && otherPlan?.last_price) {
      const mineLong = spot > gexFlip.price;
      const otherLong = otherPlan.last_price > oFlip.price;
      if (mineLong !== otherLong) {
        parts.push(`divergenza SPY/QQQ: ES ${mineLong ? 'long' : 'short'} gamma contro NQ ${otherLong ? 'long' : 'short'} — rotazione fra indici, conviction direzionale ridotta`);
      }
    }
    return { tag, parts };
  }, [plan, spot, gexFlip, otherPlan, ladderAll]);

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
            {flip0 && (
              <span className={`text-[11px] font-mono font-semibold tnum ${
                gexFlip && ((spot > gexFlip.price) === (spot > flip0))
                  ? 'text-gray-400' : 'text-amber-300'
                }`}
                title={gexFlip && ((spot > gexFlip.price) === (spot > flip0))
                  ? 'Flip 0DTE: allineato al regime strutturale'
                  : 'Flip 0DTE DIVERGENTE dal regime aggregato: il libro che scade oggi spinge in direzione opposta alla struttura — probabili scatti intraday'}>
                0DTE {futures} {flip0.toLocaleString()}
              </span>
            )}
          </div>
          <span className={`text-[10px] tnum ${
            (Date.now() - new Date(plan.generated_at).getTime()) > 12 * 60000 ? 'text-red-400'
            : (Date.now() - new Date(plan.generated_at).getTime()) > 7 * 60000 ? 'text-amber-300'
            : 'text-gray-500'
          }`} title="Se il piano è fermo da più di 7 minuti controlla la pagina Actions su GitHub: il cron di GitHub a volte ritarda">
            piano delle {new Date(plan.generated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {lettura && (
          <p className="text-[11px] leading-relaxed mt-2 pt-2 border-t border-slate-800/70 text-gray-400">
            <span className="font-bold text-slate-200">Spot {futures} {Math.round(spot).toLocaleString()}</span>
            {' — '}
            {lettura.up && (() => {
              const d = Math.round(lettura.up.price - spot);
              const exp = lettura.up.kind === 'magnet' ? 'tende ad attirarlo'
                : lettura.up.kind === 'trigger' ? 'se lo supera, il movimento accelera'
                : 'se il prezzo ci arriva, dovrebbe respingere';
              return <>sopra: <span className="text-slate-200">{lettura.up.label}</span> {lettura.up.price.toLocaleString()} ({d > 0 ? '+' : ''}{d} pt) — {exp}</>;
            })()}
            {lettura.up && lettura.dn && ' · '}
            {lettura.dn && (() => {
              const d = Math.round(lettura.dn.price - spot);
              const exp = lettura.dn.kind === 'magnet' ? 'tende ad attirarlo'
                : lettura.dn.kind === 'trigger' ? 'se lo perde, il movimento accelera'
                : 'se il prezzo ci arriva, dovrebbe respingere';
              return <>sotto: <span className="text-slate-200">{lettura.dn.label}</span> {lettura.dn.price.toLocaleString()} ({d} pt) — {exp}</>;
            })()}
            {'. '}
            {gexFlip && (
              <span className={spot > gexFlip.price ? 'text-emerald-400/80' : 'text-red-400/80'}>
                {spot > gexFlip.price
                  ? 'Long gamma: i respingimenti sui barrier sono favoriti, le rotture spesso falliscono.'
                  : 'Short gamma: i pin reggono meno e le rotture dei trigger accelerano.'}
              </span>
            )}
          </p>
        )}
        {scenario && scenario.parts.length > 0 && (
          <p className="text-[11px] leading-relaxed text-gray-400 mt-1">
            {scenario.tag && <span className="font-bold text-slate-200 uppercase tracking-wide">Scenario {scenario.tag}</span>}
            {' — '}{scenario.parts.join(' · ')}
          </p>
        )}
      </Card>

      {/* LA SCALA — solo opzioni */}
      <Card className="!p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-slate-200">🎯 La scala — livelli opzioni</h3>
          <span className="text-[10px] text-gray-500">distanza in punti · 🧲 magnete · 🛡 barriera · ⚡ trigger · barra GEX 🟢 pin / 🔴 trigger · ★★★ zona grossa, confermata e vicina</span>
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
