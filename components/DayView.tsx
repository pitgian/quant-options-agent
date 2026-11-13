import React, { useEffect, useMemo, useState } from 'react';
import { fetchDayPlanFile, fetchLevelStats, fetchLiveSpot, type DayPlan, type DayPlanLevel, type LiveSpot } from '../services/dayPlanService';
import { buildLadderForPlan } from './Ladder';
import { Ladder } from './Ladder';
import { GexHistogram, type GexProfileEntry } from './GexHistogram';
import { Card, Badge } from './ui';

const fmtGexCompact = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 0 });
/** Prezzo nativo: intero senza decimali (strike SPX/SPY), altrimenti 1 decimale
 *  (equivalenti calcolati via ratio, tipici di SPY/QQQ). */
const fmtNat = (v: number): string =>
  (Math.round(v * 10) / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });

export type ChainSource = 'etf' | 'index' | 'both';
export type GexBucket = 'all' | 'week' | '0dte';

/**
 * DayView — i livelli OPERATIVI DA OPZIONI del giorno.
 *
 * Solo fonti opzioni: GEX flip, muri gamma (pin/barriera/trigger), max pain,
 * top strike per gamma assoluta. Ogni livello porta l'affidabilità storica
 * dal track record. La fonte è selezionabile: catene ETF (SPY/QQQ), catene
 * indici (SPX/NDX) o entrambe — i livelli indice arrivano con chain='index'
 * e nomi suffissati -IDX (track record separato per fonte).
 */
export const DayView: React.FC<{ futures: 'ES' | 'NQ'; chain: ChainSource; bucket: GexBucket }> = ({ futures, chain, bucket }) => {
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [otherPlan, setOtherPlan] = useState<DayPlan | null>(null);
  const [stats, setStats] = useState<Record<string, { n: number; held: number; rate: number }>>({});
  const [live, setLive] = useState<LiveSpot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [file, s] = await Promise.all([fetchDayPlanFile(), fetchLevelStats()]);
      if (!alive) return;
      // Tolleranza ai fetch falliti: se il piano non arriva (republish del
      // data branch, CDN, rete) si CONSERVA l'ultimo piano valido invece di
      // svuotare la pagina — un buco di 60-90 secondi durante il republish
      // non deve cancellare la scala (lezione del 06/11).
      if (file?.plans?.[futures]) setPlan(file.plans[futures]);
      const otherFut = futures === 'ES' ? 'NQ' : 'ES';
      if (file?.plans?.[otherFut]) setOtherPlan(file.plans[otherFut]);
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
  const idxName = futures === 'ES' ? 'SPX' : 'NDX';
  const etfName = futures === 'ES' ? 'SPY' : 'QQQ';
  // DOPPIO PREZZO: fattori NATIVO→futures pubblicati dal pipeline. Con questi
  // ogni livello della scala e ogni barra dell'istogramma mostra il prezzo in
  // punti futures E il corrispondente nativo (SPY/QQQ o SPX/NDX).
  const etfRatio = plan?.etf_to_fut_ratio;
  const idxRatio = plan?.idx_to_fut_ratio;

  // Strike della vista corrente → segmento "≈ ES 7670 · SPX 7646" per il
  // tooltip dell'istogramma. Direzione in base alla fonte: vista ETF gli
  // strike sono GIÀ nativi (→ futuro via ratio ETF), vista indici/'Entrambi'
  // sono in scala futures (→ nativi dividendo per il ratio).

  // LA SCALA SEMPLIFICATA — solo i livelli che contano, per fonte selezionata:
  //   1. i 3 muri gamma PIÙ GROSSI per |GEX| (independentemente dal lato:
  //      il segno decide pin 🛡 vs trigger ⚡) — è la lettura "InsiderFinance":
  //      pochi livelli, i grandi
  //   2. il Max Pain della scadenza vicina (magnete 🧲)
  //   3. il flip gamma (confinе di regime)
  // Fuori scala: PIN/TRIGGER minori, muri gamma piccoli, max pain aggregato,
  // flip 0DTE (resta nell'header). Il track record li continua a giudicare
  // TUTTI lato backend: l'affidabilità storica non si perde.
  const optLevels: DayPlanLevel[] = useMemo(() => {
    if (!plan) return [];
    const out: DayPlanLevel[] = [];

    // flip gamma della fonte (regime boundary, pivot) — con doppio prezzo:
    // nativo esatto se pubblicato dal pipeline, altrimenti ricavato dal ratio.
    const flipName = chain === 'index' ? 'GEX-FLIP-IDX' : 'GEX-FLIP';
    const flip = plan.levels.find(l => l.name === flipName);
    if (flip) out.push({
      ...flip,
      native: chain === 'index'
        ? (idxRatio ? Math.round(flip.price / idxRatio * 10) / 10 : undefined)
        : (plan.gex_flip_native ?? (etfRatio ? Math.round(flip.price / etfRatio * 10) / 10 : undefined)),
      nativeSource: chain === 'index' ? idxName : etfName,
    });

    // Max Pain della scadenza vicina (magnete intraday)
    const addMp = (price: number | undefined, name: string, nome: string,
                   native?: number, nativeSource?: string) => {
      if (price) out.push({
        name, nome_it: nome, price, kind: 'magnet', source: 'options',
        dist_pts: Math.round(price - spot),
        native, nativeSource,
      } as DayPlanLevel);
    };
    if (chain !== 'index') addMp(plan.max_pain_nearest, 'MAXPAIN-0DTE', 'Max Pain scadenza vicina',
      plan.max_pain_nearest_native, etfName);
    if (chain !== 'etf') addMp(plan.max_pain_nearest_index, 'MAXPAIN-0DTE-IDX', `Max Pain scadenza vicina (${idxName})`,
      plan.max_pain_nearest_index && idxRatio ? Math.round(plan.max_pain_nearest_index / idxRatio * 10) / 10 : undefined, idxName);

    // I muri gamma della BORSA selezionata (0dte/week/all), con garanzia
    // per lato: il migliore sopra + il migliore sotto SEMPRE (se esistono),
    // poi si riempie fino a 4 col più grosso restante. Così non capita più
    // che un lato resti vuoto solo perché i |GEX| più grossi stanno tutti
    // dall'altra parte, e il 4° livello per |GEX| non si perde.
    const addGammaWalls = (
      tg: typeof plan.top_gamma | undefined,
      nameSuffix: string,
    ) => {
      const arr = tg ?? [];
      if (!arr.length) return;
      const byGex = (a: typeof arr[0], b: typeof arr[0]) => Math.abs(b.net_gex) - Math.abs(a.net_gex);
      const above = arr.filter(t => t.strike_fut >= spot).sort(byGex);
      const below = arr.filter(t => t.strike_fut < spot).sort(byGex);
      const picked = new Set<typeof arr[0]>();
      if (above[0]) picked.add(above[0]);
      if (below[0]) picked.add(below[0]);
      const rest = [...above.slice(1), ...below.slice(1)].sort(byGex);
      for (const t of rest) {
        if (picked.size >= 4) break;
        picked.add(t);
      }
      for (const t of picked) {
        const zone = Math.round(t.strike_fut / 5) * 5;
        // Lato dominante dello strike (call vs put): stessa lingua dei
        // 'Call wall / Put wall' di InsiderFinance; il segno della gamma
        // netta resta il meccanismo (pin 🛡 / trigger ⚡).
        const wallLabel = t.side === 'call' ? 'Call wall' : t.side === 'put' ? 'Put wall' : 'Muro gamma';
        out.push({
          name: `MURO-GAMMA${nameSuffix}`,
          nome_it: `${wallLabel} ${fmtGexCompact.format(t.net_gex)} (${t.sign === 'long' ? 'pin' : 'trigger'})`,
          price: zone,
          kind: t.sign === 'long' ? 'barrier' : 'trigger',
          source: 'options',
          dist_pts: Math.round(zone - spot),
          gamma: t.sign === 'long' ? 'pin' : 'trigger',
          // DOPPIO PREZZO: lo strike nativo della catena (SPY/QQQ o SPX/NDX)
          // arriva esatto dal pipeline accanto a strike_fut — la fonte
          // ('SPY'/'SPX') la mostra il chip nativo della scala.
          native: t.strike,
          nativeSource: nameSuffix ? idxName : etfName,
        } as DayPlanLevel);
      }
    };
    // Profili gamma della borsa selezionata (0dte/week/all) per catena:
    // usati SIA dai muri della scala SIA dalle barre GEX.
    const tgEtf = bucket === '0dte' ? plan.top_gamma_0dte
      : bucket === 'week' ? plan.top_gamma_week
      : plan.top_gamma;
    const tgIdx = bucket === '0dte' ? plan.top_gamma_0dte_index
      : bucket === 'week' ? plan.top_gamma_week_index
      : plan.top_gamma_index;
    if (chain !== 'index') addGammaWalls(tgEtf, '');
    if (chain !== 'etf') addGammaWalls(tgIdx, '-IDX');
    return out;
  }, [plan, spot, chain, idxName, etfName, etfRatio, idxRatio, bucket]);

  // Flip e regime SECONDO LA FONTE selezionata. Il regime esiste ANCHE senza
  // flip: quando il profilo entro ±10% è tutto positivo/negativo non c'è
  // zero-crossing (flip assente) ma il segno del GEX sullo spot resta
  // definito — così il badge non sfarfalla.
  const flipEtf = plan?.levels.find(l => l.name === 'GEX-FLIP');
  const flipIdx = plan?.levels.find(l => l.name === 'GEX-FLIP-IDX');
  const gexFlip = chain === 'index' ? flipIdx : flipEtf;
  const flipOther = chain === 'both' ? flipIdx : null;
  const flip0 = chain === 'index' ? plan?.gex_flip_0dte_index : plan?.gex_flip_0dte;
  const flip0Other = chain === 'both' ? plan?.gex_flip_0dte_index : null;
  const regimeNow: 'long' | 'short' | null =
    gexFlip ? (spot > gexFlip.price ? 'long' : 'short')
            : (chain === 'index' ? (plan?.gamma_regime_index ?? null)
                                 : (plan?.gamma_regime ?? null));

  // Doppio prezzo nel tooltip dell'istogramma (vedi commento sopra idxRatio).
  const futEq = useMemo(() => {
    if (chain === 'etf') {
      if (!etfRatio) return undefined;
      return (s: number) => `≈ ${futures} ${fmtNat(s * etfRatio)}${idxRatio ? ` · ${idxName} ${fmtNat(s * etfRatio / idxRatio)}` : ''}`;
    }
    if (!idxRatio) return undefined;
    return (s: number) => `${idxName} ${fmtNat(s / idxRatio)}${etfRatio ? ` · ${etfName} ${fmtNat(s / etfRatio)}` : ''}`;
  }, [chain, futures, idxName, etfName, etfRatio, idxRatio]);

  // Profili SEPARATI delle due fonti (solo vista 'Entrambi'): servono a
  // GexHistogram per rilevare le ZONE DI CONFLUENZA. Devono essere le
  // varianti _binned (griglia 25pt in scala futures condivisa): la raw
  // indice a 5pt non ha strike in comune e falserebbe la detection.
  const profilesBoth = useMemo(() => {
    if (!plan || chain !== 'both') return { etf: undefined, idx: undefined };
    const pick = (
      all: Array<GexProfileEntry> | undefined,
      wk: Array<GexProfileEntry> | undefined,
      zero: Array<GexProfileEntry> | undefined,
    ): Array<GexProfileEntry> | undefined =>
      bucket === '0dte' ? zero : bucket === 'week' ? wk : all;
    return {
      etf: pick(plan.gex_profile_binned, plan.gex_profile_week_binned, plan.gex_profile_0dte_binned),
      idx: pick(plan.gex_profile_index_binned, plan.gex_profile_week_index_binned, plan.gex_profile_0dte_index_binned),
    };
  }, [plan, chain, bucket]);

  // Profilo GEX COMPLETO (istogramma) della borsa selezionata; in 'Entrambi'
  // le due fonti si SOMMANO per strike (libro aggregato).
  const profileSel = useMemo<Array<GexProfileEntry> | undefined>(() => {
    if (!plan) return undefined;
    const pick = (
      all: Array<GexProfileEntry> | undefined,
      wk: Array<GexProfileEntry> | undefined,
      zero: Array<GexProfileEntry> | undefined,
    ): Array<GexProfileEntry> | undefined =>
      bucket === '0dte' ? zero : bucket === 'week' ? wk : all;
    if (chain === 'etf') return pick(plan.gex_profile, plan.gex_profile_week, plan.gex_profile_0dte);
    // Vista 'indice': profilo RAW per strike (5 pt, confrontabile 1:1 con
    // InsiderFinance). Per la somma 'Entrambi' si usano le varianti _binned
    // (griglia 25pt in scala futures condivisa da ETF e indice — altrimenti
    // 0 strike comuni e la merge affianca i due libri invece di sommarli).
    if (chain === 'index') return pick(plan.gex_profile_index, plan.gex_profile_week_index, plan.gex_profile_0dte_index);
    const a = pick(plan.gex_profile_binned, plan.gex_profile_week_binned, plan.gex_profile_0dte_binned)
      ?? pick(plan.gex_profile, plan.gex_profile_week, plan.gex_profile_0dte) ?? [];
    const b = pick(plan.gex_profile_index_binned, plan.gex_profile_week_index_binned, plan.gex_profile_0dte_index_binned)
      ?? pick(plan.gex_profile_index, plan.gex_profile_week_index, plan.gex_profile_0dte_index) ?? [];
    const merged = new Map<number, { s: number; c: number; p: number; co: number; po: number }>();
    for (const e of [...a, ...b]) {
      const cur = merged.get(e.s) ?? { s: e.s, c: 0, p: 0, co: 0, po: 0 };
      cur.c += e.c;
      cur.p += e.p;
      cur.co += e.co ?? 0;
      cur.po += e.po ?? 0;
      merged.set(e.s, cur);
    }
    return [...merged.values()].sort((x, y) => x.s - y.s);
  }, [plan, chain, bucket]);

  // Profilo gamma della BORSA selezionata (barre GEX della scala).
  // pick non restituisce MAI undefined: i campi possono mancare nel piano
  // (catena degradata o piano vecchio) — lo spread qui sotto altrimenti
  // abbatte la pagina (bug del 05/11, vista indici + borsa 0DTE).
  const topGammaSel = useMemo(() => {
    if (!plan) return undefined;
    const pick = (
      all: typeof plan.top_gamma,
      wk: typeof plan.top_gamma_week,
      zero: typeof plan.top_gamma_0dte,
    ): NonNullable<typeof plan.top_gamma> =>
      bucket === '0dte' ? (zero ?? []) : bucket === 'week' ? (wk ?? []) : (all ?? []);
    if (chain === 'etf') return pick(plan.top_gamma, plan.top_gamma_week, plan.top_gamma_0dte);
    if (chain === 'index') return pick(plan.top_gamma_index, plan.top_gamma_week_index, plan.top_gamma_0dte_index);
    return [
      ...pick(plan.top_gamma, plan.top_gamma_week, plan.top_gamma_0dte),
      ...pick(plan.top_gamma_index, plan.top_gamma_week_index, plan.top_gamma_0dte_index),
    ];
  }, [plan, chain, bucket]);

  // Lettura operativa: i due livelli adiacenti allo spot (sopra/sotto) e cosa
  // ci si aspetta da ciascuno in base al meccanismo. maxPerSide alto: voglio
  // il VERO adiacente, non il top-ranked.
  // Tutte le zone della scala (raggio pieno): usate dalla lettura e dallo scenario.
  const ladderAll = useMemo(
    () => (plan ? buildLadderForPlan(optLevels, spot, topGammaSel, 99) : null),
    [plan, spot, optLevels, topGammaSel],
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
    const mp = chain === 'index' ? plan.max_pain_nearest_index : plan.max_pain_nearest;
    const regimeLong = regimeNow;
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
      if (flip0 && regimeLong) parts.push('scadenza oggi: la convergenza verso il max pain tende ad accelerare in chiusura');
    }

    // Divergenza SPY/QQQ (catene ETF): i due regimi sono d'accordo?
    const oFlip = otherPlan?.levels.find(l => l.name === 'GEX-FLIP');
    if (flipEtf && oFlip && otherPlan?.last_price) {
      const mineLong = spot > flipEtf.price;
      const otherLong = otherPlan.last_price > oFlip.price;
      if (mineLong !== otherLong) {
        parts.push(`divergenza SPY/QQQ: ES ${mineLong ? 'long' : 'short'} gamma contro NQ ${otherLong ? 'long' : 'short'} — rotazione fra indici, conviction direzionale ridotta`);
      }
    }
    return { tag, parts };
  }, [plan, spot, regimeNow, otherPlan, ladderAll, chain, flipEtf, flip0]);

  // Nota di regime: esiste almeno un pin (gamma lunga) SOTTO lo spot? Se no,
  // è la firma strutturale del libro (put comprate = dealer short gamma sotto):
  // va detto nella scala, non lasciato intuire. DEVE stare PRIMA dell'early
  // return su !plan: un hook dopo il return condizionale cambia l'ordine degli
  // hook tra il primo render (piano assente) e quello con i dati → crash React
  // (pagina nera, bug del 03/11).
  const hasPinBelow = useMemo(() => {
    if (!optLevels.length) return null;
    // coerente con ciò che la scala MOSTRA: esiste una riga 🛡 sotto lo spot?
    return optLevels.some(l => l.price < spot && (l.gamma === 'pin' || l.kind === 'barrier'));
  }, [optLevels, spot]);

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
            {regimeNow ? (
              <Badge tone={regimeNow === 'long' ? 'good' : 'bad'}
                     title={regimeNow === 'long'
                       ? (gexFlip ? 'Sopra il flip: dealer long gamma — volatilità contenuta, i livelli respingono (pin)'
                                  : 'Dealer long gamma su tutto il profilo entro ±10% — volatilità contenuta (flip oltre la finestra)')
                       : (gexFlip ? 'Sotto il flip: dealer short gamma — i movimenti si amplificano (trend)'
                                  : 'Dealer short gamma su tutto il profilo entro ±10% — i movimenti si amplificano (flip oltre la finestra)')}>
                {regimeNow === 'long' ? '▲ Long gamma (mean reversion)' : '▼ Short gamma (trend/amplificazione)'}
                {!gexFlip && <span className="ml-1 opacity-70">· flip oltre ±10%</span>}
              </Badge>
            ) : '—'}
            {gexFlip && (
              <span className="text-[11px] font-mono text-gray-400 tnum">
                Flip {futures}{chain !== 'etf' && ` · ${idxName}`} {gexFlip.price.toLocaleString()}
              </span>
            )}
            {flipOther && (
              <span className={`text-[11px] font-mono tnum ${gexFlip && (spot > gexFlip.price) !== (spot > flipOther.price) ? 'font-semibold text-amber-300' : 'text-gray-400'}`}
                    title={gexFlip && (spot > gexFlip.price) !== (spot > flipOther.price)
                      ? `Il flip derivato dalla catena ${idxName} DIVERGE da quello ETF: le due fonti leggono regimi opposti`
                      : `Flip derivato dalla catena ${idxName} (opzioni indici), allineato alla fonte ETF`}>
                Flip {idxName} {flipOther.price.toLocaleString()}
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
                0DTE {futures}{chain !== 'etf' && ` · ${idxName}`} {flip0.toLocaleString()}
              </span>
            )}
            {flip0Other && (
              <span className="text-[11px] font-mono text-gray-400 tnum"
                    title={`Flip 0DTE derivato dalla catena ${idxName} (scadenze di oggi, opzioni indici)`}>
                0DTE {idxName} {flip0Other.toLocaleString()}
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
            {regimeNow && (
              <span className={regimeNow === 'long' ? 'text-emerald-400/80' : 'text-red-400/80'}>
                {regimeNow === 'long'
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
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-slate-200">🎯 La scala</h3>
            <span className="text-[10px] font-semibold text-gray-500" title="Cambia dal selettore nella barra in alto">
              borsa: {bucket === 'all' ? 'Tutte' : bucket === 'week' ? '≤7gg' : '0DTE'}
            </span>
            <span className="text-[10px] font-semibold text-gray-500">
              {chain === 'etf' ? 'da ETF (SPY/QQQ)' : chain === 'index' ? `da indici (${idxName})` : `ETF + indici (SPY/QQQ + ${idxName})`}
            </span>
          </div>
          <span className="text-[10px] text-gray-500">distanza in punti · 🧲 magnete · 🛡 pin · ⚡ trigger · ⧉ confluenza · ●●● peso · barra GEX 🟢 pin / 🔴 trigger</span>
        </div>
        {optLevels.length === 0 ? (
          <p className="text-[11px] text-amber-300/90 py-4 leading-relaxed">
            Nessun livello opzioni da questa fonte in questo snapshot —
            {chain === 'index' ? ` la catena ${idxName}` : ' la catena'} è degradata o i dati sono in arrivo.
            Prova un'altra fonte dal menu in alto o attendi il prossimo giro della pipeline (ogni 5 minuti in seduta).
          </p>
        ) : (
          <Ladder levels={optLevels} spot={spot} futures={futures} stats={stats} maxPerSide={7} topGamma={topGammaSel}
                  ratios={{ etf: etfRatio, idx: idxRatio }} />
        )}
        {hasPinBelow === false && optLevels.length > 0 && (
          <p className="text-[10px] text-amber-400/80 leading-relaxed mt-2" title="Sotto lo spot tutto il libro è put comprate: i dealer sono short gamma e il loro hedging vende mentre il prezzo scende">
            ⚠ Nessun pin sotto lo spot: sotto è tutto put comprata (dealer short gamma) — le discese tendono ad accelerare. Il primo sostegno “da gamma” torna sopra il flip o dove le put vengono vendute.
          </p>
        )}
        <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
          La scala mostra SOLO i livelli chiave: i muri gamma più grossi per |GEX| della borsa
          e della fonte scelte (il segno decide il meccanismo: 🛡 pin = respinge, ⚡ trigger = accelera),
          il <b>Max Pain della scadenza vicina</b> (🧲 magnete) e il <b>flip gamma</b> (confine di regime).
          Due indicatori DIVERSI: <b>⧉ CONFLUENZA</b> = più livelli sulla stessa zona a 5 punti —
          viola “ETF×{idxName}” quando le due fonti indipendenti (catena ETF e catena indici)
          danno lo stesso livello: la conferma più forte della scala; <b>●●● PESO</b> = importanza
          del livello (flip/pin, vicinanza allo spot, GEX della zona) — non è confluenza.
          Sotto ogni zona in confluenza trovi QUALE livelli convergono e da quale fonte.
          La barra a destra di ogni zona è il GEX netto degli strike lì caduti:
          più è lunga più il muro è denso, verde respinge / rossa amplifica.
        </p>
      </Card>

      {/* ISTOGRAMMA GEX — tutti gli strike della borsa selezionata */}
      <Card className="!p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-slate-200">📊 Istogramma — GEX e Open Interest, tutti gli strike</h3>
          <span className="text-[10px] text-gray-500">
            borsa: {bucket === 'all' ? 'Tutte' : bucket === 'week' ? '≤7gg' : '0DTE'} ·
            fonte: {chain === 'etf' ? 'ETF (SPY/QQQ)' : chain === 'index' ? `indici (${idxName})` : 'ETF + indici'} ·
            cambia dalla barra superiore
          </span>
        </div>
        <GexHistogram
          profile={profileSel}
          spot={chain === 'etf' ? (plan?.spot_etf ?? spot) : spot}
          idxName={chain === 'etf' ? etfName : idxName}
          futName={futures}
          strikeScale={chain === 'etf' ? etfName : futures}
          maxPain={chain === 'index' ? plan?.max_pain_nearest_index
            : chain === 'etf' ? (plan?.max_pain_nearest_native ?? plan?.max_pain_nearest)
            : plan?.max_pain_nearest}
          flip={chain === 'etf'
            ? (bucket === '0dte' ? (plan?.gex_flip_0dte_native ?? gexFlip?.price) : (plan?.gex_flip_native ?? gexFlip?.price))
            : gexFlip?.price}
          futEq={futEq}
          profileEtf={profilesBoth.etf}
          profileIdx={profilesBoth.idx}
        />
        <p className="text-[10px] text-gray-500 leading-relaxed mt-2">
          Ogni barra è uno strike reale della catena (niente aggregazione):
          barre verdi sopra lo zero = gamma lunga delle call (respinge); barre rosse
          sotto = gamma corta delle put (amplifica). La linea blu tratteggiata è lo spot: le barre più
          alte vicino alla linea sono i pin di scadenza, le code rosse lontane sono l'assicurazione
          anti-crollo. Il selettore qui sopra cambia la finestra di zoom (±1,5% zona del denaro,
          ±20% libro completo).
        </p>
      </Card>
    </div>
  );
};
