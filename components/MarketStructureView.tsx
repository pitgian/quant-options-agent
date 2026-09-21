/**
 * MarketStructureView — Premium 3-profile volume profile and market structure analysis view.
 *
 * Displays a unified horizontal layout comparing:
 *   1. ETF Options Profile (OI + Volume)
 *   2. Aligned Strikes (Index / ETF) and Confluent Key Level Badges
 *   3. Index Options Profile (OI + Volume)
 *   4. Expiry-Aligned Futures Volume Profile
 *
 * @module components/MarketStructureView
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ExpiryFilter } from '../types';
import { useOptionsData } from '../hooks/useOptionsData';
import { formatCompact } from '../utils/formatting';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { EXPIRY_OPTIONS } from '../lib/expiry';
import { KRONOS_TIMEFRAMES, getActiveKronosForecast, type KronosTimeframe } from '../lib/kronos';
import { StructuralAnalysisCard, type StructuralAnalysis } from './MarketStructurePanels';
import { ControlBar, Segmented, Labeled, Freshness, Card, Badge, InfoHint } from './ui';
import { MarketLevelsColumn, TradingGuide } from './MarketLevelsPanel';
import { detectNodes } from '../lib/volumeProfile';

export type FuturesTimeframe = 'auto' | '1d' | '2d' | '5d' | '7d' | '30d' | '90d' | 'max';

export const FUTURES_TF_LABELS: Record<string, string> = {
  '1d': 'Giornaliero', '2d': '2 Giorni', '5d': '5 Giorni', '7d': 'Settimanale',
  '30d': 'Mensile', '90d': 'Trimestrale', 'max': '1 Anno',
};

export function MarketStructureView({ sharedState }: { sharedState: ReturnType<typeof useOptionsData> }) {
  const state = sharedState;

  const {
    loading,
    error,
    market,
    setMarket,
    etfData,
    indexData,
    timeSinceUpdate,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    lastRefreshed,
    kronosForecast,
    liveSpot,
  } = state;

  const [zoomPct, setZoomPct] = useState(3.0);
  const [rowHeight, setRowHeight] = useState(22);
  const [flashVisible, setFlashVisible] = useState(false);
  const [selectedFuturesTf, setSelectedFuturesTf] = useState<FuturesTimeframe>('auto');
  // Mercato tab layout toggle: volume profile (hero) vs intraday key levels.
  const [viewMode, setViewMode] = useState<'profile' | 'levels'>('profile');
  // Confluence toggle for the embedded levels panel.
  const [showCrossSymbol, setShowCrossSymbol] = useState(true);
  const [showKronosDetails, setShowKronosDetails] = useState(false);
  const [kronosTimeframe, setKronosTimeframe] = useState<KronosTimeframe>('1d');

  useEffect(() => {
    if (showUpdatedFlash) {
      setFlashVisible(true);
      const timer = setTimeout(() => setFlashVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showUpdatedFlash]);

  // ---- Compute Basis Multiplier between Futures and Cash ----
  const basisMultiplier = useMemo(() => {
    if (!indexData) return 1;
    const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const cashSpot = liveSpot[indexSymbol as keyof typeof liveSpot] || indexData.spot;
    const futuresSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexData.spot;
    return (cashSpot && cashSpot > 0) ? (futuresSpot / cashSpot) : 1;
  }, [liveSpot, indexData, market]);

  // ---- Resolve the futures volume profile for the selected timeframe ----
  // Shared by profileData (for per-level interpolation) and futuresMP (for
  // POC / VAH / VAL computation). Keys are price strings on the futures scale.
  const resolvedFuturesProfile = useMemo(() => {
    if (!indexData) return { profile: null as Record<string, number> | null, prices: [] as number[], volsByPrice: new Map<number, number>(), tf: '' };
    let tf = '30d';
    if (selectedFuturesTf === 'auto') {
      if (expiryFilter === '0dte') tf = '2d';
      else if (expiryFilter === '1-7dte') tf = '7d';
      else if (expiryFilter === '8-30dte') tf = '30d';
      else if (expiryFilter === '30+dte') tf = '90d';
      else tf = '30d';
    } else {
      tf = selectedFuturesTf;
    }
    const profile = (indexData.futuresVolumeProfiles?.[tf] ?? indexData.futuresVolumeProfile ?? null);
    // Build a Number→vol map so consumers don't hit the string-key("7345.0") vs
    // Number(7345) mismatch. prices is the sorted numeric price axis.
    const volsByPrice = new Map<number, number>();
    if (profile) for (const k of Object.keys(profile)) volsByPrice.set(Number(k), profile[k] || 0);
    const prices = Array.from(volsByPrice.keys()).sort((a, b) => a - b);
    return { profile, prices, volsByPrice, tf };
  }, [indexData, selectedFuturesTf, expiryFilter]);

  // ---- Market Profile metrics: POC + Value Area (VAH/VAL) for the active tf ----
  // Standard Market Profile: POC = highest-volume price; Value Area = the
  // price range containing 70% of total volume, built by expanding from POC
  // up/down one price-node at a time (always adding the larger side) until
  // 70% is reached. VAH/VAL are the top/bottom of that range.
  const futuresMP = useMemo(() => {
    const { volsByPrice, prices } = resolvedFuturesProfile;
    if (prices.length === 0) return null;
    const nodes = prices.map(p => ({ price: p, vol: volsByPrice.get(p) || 0 })).filter(n => n.vol > 0);
    if (nodes.length === 0) return null;
    const totalVol = nodes.reduce((s, n) => s + n.vol, 0);
    const valueTarget = totalVol * 0.70;
    // POC = max volume node (lowest price ties)
    let pocIdx = 0;
    for (let i = 1; i < nodes.length; i++) if (nodes[i].vol > nodes[pocIdx].vol) pocIdx = i;
    // Expand value area from POC
    let lo = pocIdx, hi = pocIdx, acc = nodes[pocIdx].vol;
    while (acc < valueTarget && (lo > 0 || hi < nodes.length - 1)) {
      const up = hi < nodes.length - 1 ? nodes[hi + 1].vol : -1;
      const dn = lo > 0 ? nodes[lo - 1].vol : -1;
      if (up >= dn && up >= 0) { hi++; acc += nodes[hi].vol; }
      else if (dn >= 0) { lo--; acc += nodes[lo].vol; }
      else break;
    }
    return {
      poc: nodes[pocIdx].price,
      vah: nodes[hi].price,
      val: nodes[lo].price,
      totalVol,
      pocVol: nodes[pocIdx].vol,
    };
  }, [resolvedFuturesProfile]);

  // ---- Stable structural spots ----
  // The live-spot poller (every 15s) recreates indexData/etfData objects via
  // adjustDataWithLiveSpot, changing their .spot and reference identity. But
  // .gexStrikeData (the actual options chain) is preserved across ticks — it
  // only changes on a real data refresh (~5 min). By memoizing the spot on
  // gexStrikeData identity, the grid anchor stays frozen between refreshes,
  // so the 101 level rows don't jitter and profileData doesn't needlessly
  // recompute on every live tick.
  const indexSpotStable = useMemo(() => indexData?.spot ?? 0, [indexData?.gexStrikeData]);
  const etfSpotStable   = useMemo(() => etfData?.spot ?? 0,   [etfData?.gexStrikeData]);

  // ---- Extract and Merge Profile Data ----
  const profileData = useMemo(() => {
    if (!indexData || !etfData) return [];

    // Use the STABLE structural spots so the grid doesn't move every 15s.
    const indexSpot = indexSpotStable;
    const etfSpot = etfSpotStable;
    const ratio = indexSpot / etfSpot;

    const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    // GRID ANCHOR = structural spot from the JSON (refreshed every ~5 min by CI),
    // NOT liveSpot (refreshed every 15s). Anchoring to the live tick would
    // recompute the entire 101-row grid + nearest-strike walks on every tick,
    // causing (a) visible jitter as all level prices shift and (b) main-thread
    // jank that freezes scroll. The live spot is only used to draw the yellow
    // 'spot' highlighter on the nearest row — see isClosest in the render loop.
    const gridAnchor = indexSpot;

    // ---- Level-centric grid (Option A) ----
    // The chart axis is a uniform grid of PRICE LEVELS spaced by % from the
    // structural spot, NOT the SPX strike grid. Each row is one price level; at
    // that level we independently look up the nearest ETF strike, nearest
    // Index strike, and interpolate the futures volume. This makes ETF / Index
    // / Futures align on every horizontal row — you can read across a row and
    // see all three flows at the SAME distance from spot.
    //
    // Field names are preserved (strike, futuresStrike, etfStrike) so the
    // downstream HVN/LVN, Kronos-boundary, and Fair-Value-Area logic — which
    // keys off `strike` as a unique row id — keeps working unchanged.
    const etfByStrike = new Map(etfData.gexStrikeData.map(d => [d.strike, d]));
    const indexByStrike = new Map(indexData.gexStrikeData.map(d => [d.strike, d]));
    const indexStrikes = indexData.gexStrikeData.map(d => d.strike).sort((a, b) => a - b);
    const etfStrikes  = etfData.gexStrikeData.map(d => d.strike).sort((a, b) => a - b);
    if (indexStrikes.length === 0 || etfStrikes.length === 0) return [];

    // Profile + interpolation helper come from the shared resolvedFuturesProfile memo.
    const { prices: futPrices, volsByPrice } = resolvedFuturesProfile;
    const futuresVolAt = (price: number): number => {
      if (futPrices.length === 0) return 0;
      if (price <= futPrices[0]) return volsByPrice.get(futPrices[0]) || 0;
      if (price >= futPrices[futPrices.length - 1]) return volsByPrice.get(futPrices[futPrices.length - 1]) || 0;
      let lo = 0, hi = futPrices.length - 1;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (futPrices[mid] <= price) lo = mid; else hi = mid; }
      const p0 = futPrices[lo], p1 = futPrices[hi];
      const v0 = volsByPrice.get(p0) || 0, v1 = volsByPrice.get(p1) || 0;
      const t = p1 === p0 ? 0 : (price - p0) / (p1 - p0);
      return v0 + (v1 - v0) * t;
    };

    // ---- Build the level grid from REAL Index strikes ----
    // Previously this was a synthetic uniform grid (~100 rows) onto which
    // option strikes were mapped by nearest-match. That produced FAKE
    // duplicate levels: several grid rows resolved to the same strike (so
    // the same OI repeated) and the futures volume was interpolated across
    // every synthetic row (so the same volume repeated). The fix is to make
    // the grid itself the real Index strike ladder — every row is an actual
    // traded strike with its real OI/volume, sampled (not interpolated) from
    // the futures profile. ETF aligns to the nearest real ETF strike.
    const rows: any[] = [];
    const loPrice = gridAnchor * (1 - zoomPct / 100);
    const hiPrice = gridAnchor * (1 + zoomPct / 100);
    let etfPtr = 0; // monotonic pointer for nearest-ETF-strike walk

    for (const idxStrike of indexStrikes) {
      if (idxStrike < loPrice || idxStrike > hiPrice) continue;
      const indexStrikeData = indexByStrike.get(idxStrike);
      // Skip strikes with absolutely no market structure signal (no OI, no vol,
      // no futures volume) so the ladder stays focused on real levels.
      const idxCallOI  = indexStrikeData?.callOI     ?? 0;
      const idxPutOI   = indexStrikeData?.putOI      ?? 0;
      const idxCallVol = indexStrikeData?.callVolume ?? 0;
      const idxPutVol  = indexStrikeData?.putVolume  ?? 0;

      // Map this Index strike back to the ETF (cash) scale and find the
      // nearest real ETF strike via a monotonic walk.
      const etfPrice = idxStrike / (indexSpot / etfSpot); // index→etf scale
      while (etfPtr + 1 < etfStrikes.length && Math.abs(etfStrikes[etfPtr + 1] - etfPrice) < Math.abs(etfStrikes[etfPtr] - etfPrice)) etfPtr++;
      const nearestEtfStrike = etfStrikes[etfPtr];
      const etfStrikeData = etfByStrike.get(nearestEtfStrike);

      const etfCallOI  = etfStrikeData?.callOI     ?? 0;
      const etfPutOI   = etfStrikeData?.putOI      ?? 0;
      const etfCallVol = etfStrikeData?.callVolume ?? 0;
      const etfPutVol  = etfStrikeData?.putVolume  ?? 0;

      const indexVolume = idxCallOI + idxPutOI + idxCallVol + idxPutVol;
      const etfVolume   = etfCallOI + etfPutOI + etfCallVol + etfPutVol;
      const futuresVolume = futuresVolAt(idxStrike);

      rows.push({
        strike: idxStrike,          // unique row id (real Index strike)
        futuresStrike: idxStrike,   // alias — Kronos boundary / isClosest logic
        etfStrike: nearestEtfStrike,
        indexStrike: idxStrike,
        etfPrice: nearestEtfStrike, // real ETF strike aligned to this Index level (for label)
        etfTruePrice: etfPrice,    // exact ETF-scale price of THIS Index strike (for de-dup)
        levelPrice: idxStrike,      // real futures-scale price (for label)
        distancePct: ((idxStrike - gridAnchor) / gridAnchor) * 100,
        indexVolume, etfVolume, futuresVolume,
        indexCallOI: idxCallOI, indexPutOI: idxPutOI,
        etfCallOI, etfPutOI,
        indexTotalOI: idxCallOI + idxPutOI,
        indexTotalVol: idxCallVol + idxPutVol,
        etfTotalOI: etfCallOI + etfPutOI,
        etfTotalVol: etfCallVol + etfPutVol,
        etfIsPrimary: false,   // filled in post-pass below
        indexIsPrimary: true,
      });
    }
    // Post-pass: for each UNIQUE ETF strike, mark only the Index row nearest
    // to its true price as 'primary'. Multiple dense Index strikes (e.g. NDX
    // 5-pt grid) can map to the same ETF strike (QQQ 1-pt grid); rendering the
    // ETF bar at full opacity on all of them reads as duplicate data. The
    // non-primary rows render a faint connector instead.
    const etfTrueLevel = new Map<number, { bestDelta: number }>(); // etfStrike → closest row seen
    for (const r of rows) {
      const cur = etfTrueLevel.get(r.etfStrike);
      const delta = Math.abs(r.etfTruePrice - r.etfStrike);
      if (cur === undefined || delta < cur.bestDelta) {
        etfTrueLevel.set(r.etfStrike, { bestDelta: delta });
      }
    }
    for (const r of rows) {
      const cur = etfTrueLevel.get(r.etfStrike);
      r.etfIsPrimary = cur !== undefined && Math.abs(r.etfTruePrice - r.etfStrike) === cur.bestDelta;
    }
    return rows;
  }, [indexData?.gexStrikeData, etfData?.gexStrikeData, indexData?.futuresVolumeProfiles, indexData?.futuresVolumeProfile, resolvedFuturesProfile, expiryFilter, selectedFuturesTf, basisMultiplier, market, zoomPct, indexSpotStable, etfSpotStable]);

  // ---- Filter profile based on zoom percentage around spot ----
  const zoomedProfile = useMemo(() => {
    return profileData.filter(d => Math.abs(d.distancePct) <= zoomPct);
  }, [profileData, zoomPct]);

  // ---- Active Kronos Forecast based on timeframe selection ----
  // ---- Active Kronos Forecast based on timeframe selection ----
  // (timeframe→resolution mapping + candle scaling now lives in lib/kronos.ts)
  const activeKronosForecast = useMemo(() => {
    if (!kronosForecast || !etfData || !etfData.spot) return null;
    const biasItem = market === 'SP500' ? kronosForecast.SP500_bias : kronosForecast.NASDAQ_bias;
    return getActiveKronosForecast(biasItem, etfData.spot, kronosTimeframe);
  }, [kronosForecast, market, kronosTimeframe, etfData]);

  // ---- Kronos expected price range in Futures terms ----
  const kronosRange = useMemo(() => {
    if (!activeKronosForecast || !indexData || !etfData) return null;

    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const futuresSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexData.spot;
    
    if (futuresSpot && activeKronosForecast.lastPrice > 0) {
      const etfToFuturesRatio = futuresSpot / activeKronosForecast.lastPrice;
      return {
        low: activeKronosForecast.expectedLow * etfToFuturesRatio,
        high: activeKronosForecast.expectedHigh * etfToFuturesRatio,
        etfToFuturesRatio
      };
    }
    return null;
  }, [activeKronosForecast, indexData, etfData, liveSpot, market]);

  // ---- Calculate visual boundaries for Kronos expected range ----
  // Boundaries are kept in PRICE space (dollar low/high) so the rendered band
  // stays identical regardless of how dense the strike grid is — i.e. the
  // visual range does NOT depend on the selected expiry filter. Each row is
  // shaded/labelled by checking whether its price falls inside [low, high].
  const kronosBoundaries = useMemo(() => {
    if (!kronosRange || zoomedProfile.length === 0) return null;
    return {
      min: kronosRange.low,
      max: kronosRange.high,
    };
  }, [kronosRange, zoomedProfile]);

  const hasFuturesData = useMemo(() => {
    return zoomedProfile.some(d => d.futuresVolume > 0);
  }, [zoomedProfile]);

  // ---- Node detection (HVN & LVN) via lib/volumeProfile (prominence-based:
  //      only peaks that DOMINATE their neighborhood survive — the old ±2
  //      local-max heuristic flagged dozens of micro-wiggles) ----
  const nodes = useMemo(() => {
    if (zoomedProfile.length === 0) {
      return { hvnStrikes: new Set<number>(), lvnStrikes: new Set<number>(), lvnZones: new Map<number, { low: number; high: number }>() };
    }
    const volumes = zoomedProfile.map(d => hasFuturesData ? d.futuresVolume : (d.etfVolume + d.indexVolume));
    const strikes = zoomedProfile.map(d => d.strike);
    const { hvnIndices, lvnIndices, lvnZones } = detectNodes(volumes);
    const hvnStrikes = new Set(hvnIndices.map(i => strikes[i]));
    const lvnStrikes = new Set(lvnIndices.map(i => strikes[i]));
    const zoneMap = new Map<number, { low: number; high: number }>();
    for (const z of lvnZones) {
      zoneMap.set(strikes[z.from], { low: strikes[z.from], high: strikes[z.to] });
    }
    return { hvnStrikes, lvnStrikes, lvnZones: zoneMap };
  }, [zoomedProfile, hasFuturesData]);

  // ---- Merge overlapping LVN zones ----
  const mergedZones = useMemo(() => {
    const rawZones = Array.from(nodes.lvnZones.values()).sort((a, b) => a.low - b.low);
    if (rawZones.length === 0) return [];

    const merged: { low: number; high: number }[] = [{ ...rawZones[0] }];
    for (let i = 1; i < rawZones.length; i++) {
      const current = rawZones[i];
      const last = merged[merged.length - 1];

      if (current.low <= last.high) {
        last.high = Math.max(last.high, current.high);
      } else {
        merged.push({ ...current });
      }
    }
    return merged;
  }, [nodes.lvnZones]);

  // ---- Value Area / Fair Value Areas (FVAs) Grouping ----
  const fairValueAreas = useMemo(() => {
    if (!indexData || zoomedProfile.length === 0) return [];

    const strikes = zoomedProfile.map(d => d.strike).sort((a, b) => a - b);
    const indexSpot = indexData.spot;
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const axisSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexSpot;

    const areas: {
      id: number;
      low: number;
      high: number;
      poc: number;
      maxVolume: number;
      totalVolume: number;
      volumeShare?: number;
      status: 'current' | 'above' | 'below';
    }[] = [];

    const ranges: { low: number; high: number }[] = [];

    if (mergedZones.length === 0) {
      ranges.push({ low: strikes[0], high: strikes[strikes.length - 1] });
    } else {
      if (strikes[0] < mergedZones[0].low) {
        ranges.push({ low: strikes[0], high: mergedZones[0].low });
      }

      for (let i = 0; i < mergedZones.length - 1; i++) {
        const low = mergedZones[i].high;
        const high = mergedZones[i + 1].low;
        if (low < high) {
          ranges.push({ low, high });
        }
      }

      const lastZone = mergedZones[mergedZones.length - 1];
      if (lastZone.high < strikes[strikes.length - 1]) {
        ranges.push({ low: lastZone.high, high: strikes[strikes.length - 1] });
      }
    }

    ranges.forEach((range, idx) => {
      const strikesInArea = zoomedProfile.filter(d => d.strike >= range.low && d.strike <= range.high);
      // Sliver filter: an "area" needs at least 2 price rows to be a zone.
      if (strikesInArea.length < 2) return;

      let poc = strikesInArea[0].strike;
      let maxVol = -1;
      const hasFutures = strikesInArea.some(d => d.futuresVolume > 0);
      let totalVol = 0;

      for (const d of strikesInArea) {
        const vol = hasFutures ? d.futuresVolume : (d.etfVolume + d.indexVolume);
        totalVol += vol;
        if (vol > maxVol) {
          maxVol = vol;
          poc = d.strike;
        }
      }

      let status: 'current' | 'above' | 'below' = 'above';
      if (axisSpot >= range.low && axisSpot <= range.high) {
        status = 'current';
      } else if (axisSpot < range.low) {
        status = 'above';
      } else {
        status = 'below';
      }

      areas.push({
        id: idx + 1,
        low: range.low,
        high: range.high,
        poc,
        maxVolume: maxVol,
        totalVolume: totalVol,
        status,
      });
    });

    // Volume share per area: quota dei volumi totali delle aree (aiuta a
    // capire quale value area domina — la primary — e quali sono marginali).
    const grandTotal = areas.reduce((s, a) => s + a.totalVolume, 0);
    for (const a of areas) {
      a.volumeShare = grandTotal > 0 ? a.totalVolume / grandTotal : 0;
    }

    return areas;
  }, [mergedZones, zoomedProfile, indexData, liveSpot, market]);

  // ---- Actionable Trading Analysis Card ----
  const analysis = useMemo(() => {
    if (!indexData || fairValueAreas.length === 0) return null;
    
    const indexSpot = indexData.spot;
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const axisSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexSpot;

    const currentArea = fairValueAreas.find(a => a.status === 'current');
    const currentLvnZone = mergedZones.find(z => axisSpot >= z.low && axisSpot <= z.high);

    if (currentLvnZone) {
      return {
        isInsideLvn: true,
        lvnZone: currentLvnZone,
        suggestion: `Il prezzo dell'indice si trova all'interno di una Zona di Transizione a basso volume ($${currentLvnZone.low.toFixed(0)} - $${currentLvnZone.high.toFixed(0)}). I volumi in questa fascia sono molto scarsi. Questo indica instabilità: il prezzo tende ad attraversare rapidamente quest'area per raggiungere una zona di Fair Value adiacente o subire un netto rigetto verso la zona precedente. Monitorare la forza dei volumi per identificare un breakout confermato.`,
      };
    }

    if (!currentArea) {
      return {
        message: "Il prezzo si trova al di fuori dei nodi ad alto volume rilevati.",
        suggestion: "Monitorare la reazione del prezzo sui confini dell'area di Fair Value più vicina.",
      };
    }

    const distanceToUpper = currentArea.high - axisSpot;
    const distanceToLower = axisSpot - currentArea.low;

    const nearestBoundary = distanceToUpper < distanceToLower
      ? { low: currentArea.high, high: currentArea.high, type: 'Confine Superiore (LVN)', dist: distanceToUpper, pct: (distanceToUpper / axisSpot) * 100 }
      : { low: currentArea.low, high: currentArea.low, type: 'Confine Inferiore (LVN)', dist: distanceToLower, pct: (distanceToLower / axisSpot) * 100 };

    const lvnZone = mergedZones.find(z => z.low === nearestBoundary.low || z.high === nearestBoundary.high);
    const boundaryText = lvnZone
      ? `Zona LVN a $${lvnZone.low.toFixed(0)} - $${lvnZone.high.toFixed(0)}`
      : `$${nearestBoundary.low.toFixed(0)}`;

    let suggestion = "";
    if (nearestBoundary.pct < 0.6) {
      suggestion = `Il prezzo spot dell'indice è in prossimità del limite critico (${nearestBoundary.type}) definito dalla ${boundaryText} (distanza: ${nearestBoundary.pct.toFixed(2)}%). Un rifiuto dei volumi su questa soglia suggerisce una reazione di rimbalzo (Mean Reversion) verso il POC interno a $${currentArea.poc.toFixed(0)}. Al contrario, una rottura decisa dei volumi (Breakout) indicherà una rapida transizione attraverso la zona di rifiuto verso l'FVA adiacente.`;
    } else {
      suggestion = `Il prezzo dell'indice si sta muovendo in equilibrio all'interno della zona di Fair Value ($${currentArea.low.toFixed(0)} - $${currentArea.high.toFixed(0)}). Il magnete principale (Point of Control) è a $${currentArea.poc.toFixed(0)}, che agisce come centro di gravità. Le soglie esterne ($${currentArea.low.toFixed(0)} e $${currentArea.high.toFixed(0)}) delimitano le zone LVN di rigetto strutturale.`;
    }

    return {
      currentArea,
      nearestBoundary: lvnZone ? { ...lvnZone, type: nearestBoundary.type, pct: nearestBoundary.pct } : null,
      suggestion,
    };
  }, [fairValueAreas, mergedZones, indexData, liveSpot, market]);

  // ---- Max values for bar sizing ----
  const { maxEtfVolume, maxIndexVolume, maxFuturesVolume, maxIndexTotalOI, maxEtfTotalOI, maxIndexTotalVol, maxEtfTotalVol } = useMemo(() => {
    let maxEtf = 1;
    let maxIdx = 1;
    let maxFut = 1;
    let maxIdxOI = 1;
    let maxEtfOI = 1;
    let maxIdxVol = 1;
    let maxEtfVol = 1;
    for (const d of zoomedProfile) {
      if (d.etfVolume > maxEtf) maxEtf = d.etfVolume;
      if (d.indexVolume > maxIdx) maxIdx = d.indexVolume;
      if (d.futuresVolume > maxFut) maxFut = d.futuresVolume;
      if (d.indexTotalOI  > maxIdxOI)  maxIdxOI  = d.indexTotalOI;
      if (d.etfTotalOI    > maxEtfOI)  maxEtfOI  = d.etfTotalOI;
      if (d.indexTotalVol > maxIdxVol) maxIdxVol = d.indexTotalVol;
      if (d.etfTotalVol   > maxEtfVol) maxEtfVol = d.etfTotalVol;
    }
    return { maxEtfVolume: maxEtf, maxIndexVolume: maxIdx, maxFuturesVolume: maxFut, maxIndexTotalOI: maxIdxOI, maxEtfTotalOI: maxEtfOI, maxIndexTotalVol: maxIdxVol, maxEtfTotalVol: maxEtfVol };
  }, [zoomedProfile]);

  // Cross-symbol CONFLUENCE pre-selection (capped + direction-filtered).
  // A row qualifies when BOTH the Index OI and the aligned ETF OI are strong
  // (each >= CONFLUENCE_OI_PCT of its own max). The threshold is percentile-
  // relative per side because index and ETF OI live on very different absolute
  // scales (NDX walls ~1k contracts vs QQQ ~400k), so an absolute cutoff would
  // fire only on the ETF or never on the index.
  //
  // DIRECTION must also agree: a true confluence is a put wall on BOTH the
  // index and the ETF (support), or a call wall on BOTH (resistance). When the
  // two sides disagree (e.g. index call-heavy but ETF put-heavy) it is NOT a
  // confluence — it's a structural disagreement — and is dropped. Comparing
  // put/call FRACTIONS per symbol (not absolute OI) avoids the ETF always
  // outvoting the index because of its larger contract scale.
  //
  // To keep the chart readable we DON'T flag every qualifying row: we rank
  // candidates by combined OI width (index + etf) and keep only the top
  // CONFLUENCE_MAX_LEVELS. Without this cap a dense NDX ladder produced ~17
  // markers — noise, not signal.
  const CONFLUENCE_OI_PCT = 40;
  const CONFLUENCE_MAX_LEVELS = 8;
  const confluenceStrikes = useMemo(() => {
    const candidates = zoomedProfile
      .filter(d => d.etfIsPrimary)
      .map(d => {
        const idxTotalOI = d.indexCallOI + d.indexPutOI;
        const etfTotalOI = d.etfCallOI + d.etfPutOI;
        const idxHasOI = idxTotalOI > 0;
        const etfHasOI = etfTotalOI > 0;
        const idxOIWidth = maxIndexTotalOI > 0 ? (idxTotalOI / maxIndexTotalOI) * 100 : 0;
        const etfOIWidth = maxEtfTotalOI > 0 ? (etfTotalOI / maxEtfTotalOI) * 100 : 0;
        const strongEnough = idxHasOI && etfHasOI &&
          idxOIWidth >= CONFLUENCE_OI_PCT && etfOIWidth >= CONFLUENCE_OI_PCT;
        // Per-symbol put/call direction (fractions, scale-free).
        const idxPutFrac = idxHasOI ? d.indexPutOI / idxTotalOI : 0;
        const etfPutFrac = etfHasOI ? d.etfPutOI / etfTotalOI : 0;
        const idxIsPut = idxPutFrac > 0.5;
        const etfIsPut = etfPutFrac > 0.5;
        // Both sides must agree on direction to be a real confluence.
        const direction = idxIsPut === etfIsPut
          ? (idxIsPut ? 'support' : 'resistance')
          : null; // disagreement -> not a confluence
        const qualifies = strongEnough && direction !== null;
        return { strike: d.strike, qualifies, combinedWidth: idxOIWidth + etfOIWidth, type: direction as 'support' | 'resistance' | null };
      })
      .filter(c => c.qualifies && c.type !== null)
      .sort((a, b) => b.combinedWidth - a.combinedWidth)
      .slice(0, CONFLUENCE_MAX_LEVELS)
      .map(c => ({ strike: c.strike, type: c.type as 'support' | 'resistance' }));
    return new Map(candidates.map(c => [c.strike, c.type]));
  }, [zoomedProfile, maxIndexTotalOI, maxEtfTotalOI]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={handleRefresh} />;
  if (!indexData || !etfData) return <ErrorState message="Dati non disponibili" onRetry={handleRefresh} />;

  const indexSpot = indexData.spot;
  const etfSpot = etfData.spot;
  const ratio = indexSpot / etfSpot;

  const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
  const etfSymbol = market === 'SP500' ? 'SPY' : 'QQQ';
  const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
  const cashSpot = liveSpot[indexSymbol as keyof typeof liveSpot] || indexSpot;
  const etfCashSpot = liveSpot[etfSymbol as keyof typeof liveSpot] || etfSpot;
  const futuresSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexSpot;

  return (
    <div className="min-h-screen flex flex-col bg-[#0d1117]">
      <ControlBar
        left={
          <>
            <Segmented
              value={market}
              onChange={(m) => setMarket(m)}
              options={[
                { value: 'SP500', label: '🇺🇸 S&P 500' },
                { value: 'NASDAQ100', label: '💻 Nasdaq 100' },
              ]}
            />
            <Segmented
              value={viewMode}
              onChange={(v) => setViewMode(v)}
              options={[
                { value: 'profile', label: '📊 Profilo Volumi' },
                { value: 'levels', label: '🎯 Livelli Intraday' },
              ]}
            />
            <Labeled label="Range">
              <Segmented
                value={zoomPct}
                onChange={(z) => setZoomPct(z)}
                size="xs"
                options={[
                  { value: 1.5, label: '±1.5%' },
                  { value: 3.0, label: '±3.0%' },
                  { value: 5.0, label: '±5.0%' },
                ]}
              />
            </Labeled>
            <Labeled label="Zoom" title="Altezza righe del profilo">
              <div className="flex items-center gap-1 bg-[#0d1117] rounded-lg px-2 py-1 border border-slate-800">
                <button
                  onClick={() => setRowHeight(h => Math.max(14, h - 2))}
                  disabled={rowHeight <= 14}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 font-bold text-xs"
                  title="Stringi righe (più livelli visibili)"
                >−</button>
                <input
                  type="range" min={14} max={36} step={2} value={rowHeight}
                  onChange={(e) => setRowHeight(Number(e.target.value))}
                  className="w-14 accent-blue-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
                  title={`Altezza righe: ${rowHeight}px`}
                />
                <button
                  onClick={() => setRowHeight(h => Math.min(36, h + 2))}
                  disabled={rowHeight >= 36}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 font-bold text-xs"
                  title="Allarga righe (maggior dettaglio)"
                >+</button>
              </div>
            </Labeled>
            <Labeled label="Scadenza">
              <select
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
                className="bg-[#0d1117] border border-slate-800 text-gray-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Futures" title="Timeframe del profilo volumi futures">
              <select
                value={selectedFuturesTf}
                onChange={(e) => setSelectedFuturesTf(e.target.value as FuturesTimeframe)}
                className="bg-[#0d1117] border border-slate-800 text-gray-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                <option value="auto">Auto (scadenza)</option>
                <option value="1d">Giornaliero</option>
                <option value="2d">2 Giorni</option>
                <option value="7d">Settimanale</option>
                <option value="30d">Mensile</option>
                <option value="90d">Trimestrale</option>
                <option value="max">1 Anno</option>
              </select>
            </Labeled>
            <Labeled label="Kronos">
              <Segmented
                value={kronosTimeframe}
                onChange={(tf) => setKronosTimeframe(tf)}
                size="xs"
                options={KRONOS_TIMEFRAMES.map((tf) => ({ value: tf.key, label: tf.label }))}
              />
            </Labeled>
          </>
        }
        right={
          <Freshness
            timeSinceUpdate={timeSinceUpdate}
            refreshing={refreshing}
            onRefresh={handleRefresh}
            isBackgroundRefreshing={isBackgroundRefreshing}
            flashVisible={flashVisible}
          />
        }
      />
      {viewMode === 'levels' && (
        <div
          className="sticky z-40 border-b border-slate-800 bg-[#161b22]/95 backdrop-blur px-4 py-2 sm:px-6"
          style={{ top: 'calc(var(--app-nav-h, 0px) + var(--app-controlbar-h, 49px))' }}
        >
          <div className="max-w-[1850px] mx-auto flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setShowCrossSymbol(!showCrossSymbol)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-extrabold transition-all duration-150"
              style={{
                backgroundColor: showCrossSymbol ? 'rgba(245,158,11,0.15)' : 'transparent',
                color: showCrossSymbol ? '#f59e0b' : '#64748b',
                border: '1px solid',
                borderColor: showCrossSymbol ? 'rgba(245,158,11,0.25)' : 'transparent',
              }}
              title={showCrossSymbol ? 'Nascondi confluenze cross-symbol' : 'Mostra confluenze cross-symbol'}
            >
              ★ Confluenze
            </button>
          </div>
        </div>
      )}
      {/* ================================================================== */}
      {/* MAIN CONTENT AREA                                                 */}
      {/* ================================================================== */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col gap-6 w-full animate-fadeIn">
          
          {/* ================================================================== */}
          {/* TICKER STRIP — compact one-row market state (was: 4 separate cards) */}
          {/* ================================================================== */}
          <Card className="!p-3">
            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
              <div className="flex flex-col">
                <span className="text-[9px] text-blue-400 uppercase font-extrabold tracking-widest">{futuresSymbol} · LIVE</span>
                <span className="text-xl font-mono font-extrabold text-white leading-none tnum">
                  ${futuresSpot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                </span>
              </div>
              <div className="w-px h-8 bg-slate-800 hidden sm:block" />
              <div className="flex flex-col">
                <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">{indexSymbol} / {etfSymbol}</span>
                <span className="text-xs font-mono font-bold text-slate-200 tnum">
                  ${cashSpot > 0 ? cashSpot.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} · ${etfCashSpot > 0 ? etfCashSpot.toFixed(2) : '—'}
                </span>
              </div>
              <div className="w-px h-8 bg-slate-800 hidden sm:block" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Regime GEX</span>
                <div className="flex items-center gap-1.5">
                  <Badge tone={indexData.gexRegime.regime === 'positive' ? 'good' : indexData.gexRegime.regime === 'negative' ? 'bad' : 'neutral'}>
                    {indexData.gexRegime.regime === 'positive' ? '▲ Positivo' : indexData.gexRegime.regime === 'negative' ? '▼ Negativo' : '◆ Neutrale'}
                  </Badge>
                  {indexData.gexRegime.flipPoint && (
                    <span className="text-[9px] text-gray-500 font-mono tnum">
                      Flip ${(indexData.gexRegime.flipPoint * basisMultiplier).toFixed(0)}
                    </span>
                  )}
                </div>
              </div>
              <div className="w-px h-8 bg-slate-800 hidden sm:block" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col">
                  <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Skew 25D</span>
                  <span className="text-[11px] font-mono font-bold text-amber-400 tnum">
                    {indexData.volatilitySkew25d !== undefined ? ((indexData.volatilitySkew25d > 0 ? '+' : '') + (indexData.volatilitySkew25d * 100).toFixed(1) + '%') : '—'}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">P/C OI</span>
                  <span className="text-[11px] font-mono font-bold text-indigo-400 tnum">
                    {indexData.putCallOiRatio !== undefined ? indexData.putCallOiRatio.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
              <div className="w-px h-8 bg-slate-800 hidden sm:block" />
              <div className="flex items-center gap-2">
                <div className="flex flex-col">
                  <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">
                    Kronos ({kronosTimeframe})
                  </span>
                  <div className="flex items-center gap-1.5">
                    {activeKronosForecast ? (
                      <>
                        <Badge tone={activeKronosForecast.trendBias === 'BULLISH' ? 'good' : activeKronosForecast.trendBias === 'BEARISH' ? 'bad' : 'neutral'}>
                          {activeKronosForecast.trendBias === 'BULLISH' ? '▲ Rialzista' : activeKronosForecast.trendBias === 'BEARISH' ? '▼ Ribassista' : '◆ Neutrale'}
                        </Badge>
                        <span className="text-[11px] font-mono font-bold text-blue-400 tnum" title="Range atteso (scala futures)">
                          {kronosRange ? `$${kronosRange.low.toFixed(0)}–$${kronosRange.high.toFixed(0)}` : '—'}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-gray-500">in attesa…</span>
                    )}
                  </div>
                </div>
                {activeKronosForecast && (
                  <Badge tone={activeKronosForecast.volatilityPct >= 0.5 ? 'bad' : activeKronosForecast.volatilityPct < 0.2 ? 'good' : 'warn'}
                         title={`Volatilità stimata sul range: ${activeKronosForecast.volatilityPct.toFixed(3)}%`}>
                    {activeKronosForecast.volatilityPct.toFixed(2)}% {activeKronosForecast.volatilityPct >= 0.5 ? 'ELEV' : activeKronosForecast.volatilityPct < 0.2 ? 'BASSA' : 'MOD'}
                  </Badge>
                )}
              </div>
            </div>
          </Card>

          {viewMode === 'levels' ? (
            <>
              <TradingGuide />
              <MarketLevelsColumn
                market={market}
                defaultSymbol={etfSymbol}
                etfSymbol={etfSymbol}
                indexSymbol={indexSymbol}
                futuresSymbol={futuresSymbol}
                etfData={etfData}
                indexData={indexData}
                liveSpot={liveSpot}
                kronosForecast={kronosForecast}
                kronosTimeframe={kronosTimeframe}
                showCrossSymbol={showCrossSymbol}
                intradayLevels={etfData.intradayLevels}  // playbook calcolato per SPY/QQQ
              />
            </>
          ) : (
          <>
          {/* ================================================================== */}
          {/* PROFILE CHART (WIDESCREEN FULL WIDTH)                              */}
          {/* ================================================================== */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 flex flex-col w-full">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-100 flex items-center gap-2 flex-wrap">
                  📊 Profilo Volumi Unificato (3-Profile Chart)
                  {/* Timeframe SEMPRE visibile: era sepolto nella legenda e
                      l'utente non poteva sapere quale profilo stesse guardando */}
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-sky-300 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20"
                        title={selectedFuturesTf === 'auto' ? 'Timeframe automatico, allineato alla scadenza selezionata' : 'Timeframe selezionato manualmente'}>
                    Futures: {FUTURES_TF_LABELS[resolvedFuturesProfile.tf] ?? resolvedFuturesProfile.tf}
                    <span className="text-[10px] text-sky-400/60">
                      ({selectedFuturesTf === 'auto' ? `auto · scadenza ${expiryFilter}` : 'manuale'})
                    </span>
                  </span>
                  {!hasFuturesData && (
                    <span className="text-xs font-normal text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      Fallback Opzioni
                    </span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Analisi incrociata delle opzioni retail (ETF) a sinistra, opzioni istituzionali (Indice) al centro-destra e volumi futures a destra.
                </p>
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-850">
                  <InfoHint title="Legenda — Profilo Volumi Unificato">
                    <ul className="space-y-1.5">
                      <li><b>Larghezza barra:</b> Open Interest totale (livello strutturale — definisce i wall).</li>
                      <li><b>Colore barra:</b> 🟢 Call OI (resistenza) · 🔴 Put OI (supporto).</li>
                      <li><b>Striscia ambra in cima:</b> volume scambiato oggi (scala indipendente — flusso intraday).</li>
                      <li><b>POC</b> — Point of Control del timeframe futures selezionato (prezzo a maggior volume).</li>
                      <li><b>VAH · VAL</b> — Value Area High/Low: range col 70% del volume del timeframe selezionato.</li>
                      <li><b>Volumi Futures:</b> storico {selectedFuturesTf === 'auto' ? 'allineato alla scadenza selezionata' : 'su timeframe personalizzato'}.</li>
                      <li><b>Rettangolo blu:</b> range atteso Kronos sull'orizzonte selezionato.</li>
                    </ul>
                  </InfoHint>
                  <span className="text-[10px] text-gray-500">Legenda e significato dei colori</span>
                </div>
              </div>
            </div>

            {/* Scrollable container for mobile responsiveness */}
            <div className="overflow-x-auto">
              <div className="min-w-[700px] md:min-w-0">
                {/* Header labels for profiles */}
                <div className="grid grid-cols-[1fr_150px_1fr_1fr] gap-2 mb-2 px-2 text-[9px] font-bold tracking-wider text-gray-500 uppercase">
                  <span className="text-right">Opzioni ETF (OI+Vol)</span>
                  <span className="text-center">Prezzo Livello (F | E)</span>
                  <span className="text-left">Opzioni Indice (OI+Vol)</span>
                  <span className="text-left">Volumi Futures · {FUTURES_TF_LABELS[resolvedFuturesProfile.tf] ?? resolvedFuturesProfile.tf}</span>
                </div>

                {/* Chart rows */}
                <div className="flex flex-col gap-0.5">
                  {zoomedProfile.length === 0 ? (
                    <div className="text-center py-12 bg-slate-900/20 border border-dashed border-slate-800 rounded-xl my-4 text-gray-500 text-xs flex flex-col items-center justify-center gap-2">
                      <span>📭 Nessun dato disponibile per questa scadenza</span>
                      <span className="text-[10px] text-gray-600 max-w-sm px-4">
                        (Nessuna opzione attiva trovata per la scadenza selezionata, ad esempio 0 DTE durante i giorni festivi o i fine settimana).
                      </span>
                    </div>
                  ) : (
                    zoomedProfile.slice().reverse().map((d) => {
                      const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
                      const futuresSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexData.spot;
                    const isClosest = Math.abs(d.futuresStrike - futuresSpot) === Math.min(...zoomedProfile.map(x => Math.abs(x.futuresStrike - futuresSpot)));
                    const isHVN = nodes.hvnStrikes.has(d.strike);
                    const lvnZone = mergedZones.find(z => d.strike >= z.low && d.strike <= z.high);
                    const isLVN = !!lvnZone;
                    const isTrough = nodes.lvnStrikes.has(d.strike);
                    // Kronos range is in PRICE space (dollar low/high), independent of
                    // the strike grid density, so the rendered band does NOT change
                    // when the expiry filter changes the strike spacing.
                    const isInKronosRange = !!(kronosBoundaries && d.levelPrice >= kronosBoundaries.min && d.levelPrice <= kronosBoundaries.max);
                    const flipPoint = indexData?.gexRegime?.flipPoint;
                    const isFlipRow = flipPoint
                      ? Math.abs(d.strike - flipPoint * basisMultiplier) === Math.min(...zoomedProfile.map(x => Math.abs(x.strike - flipPoint * basisMultiplier)))
                      : false;

                    // Kronos boundary rows: the grid rows whose PRICE is closest to
                    // the (continuous) low/high of the Kronos range. Used to draw the
                    // dashed border + the High/Low labels. Computed in price space so
                    // they don't depend on strike spacing.
                    const isKronosHighRow = !!(kronosBoundaries && zoomedProfile.length > 0 &&
                      Math.abs(d.levelPrice - kronosBoundaries.max) === Math.min(...zoomedProfile.map(x => Math.abs(x.levelPrice - kronosBoundaries.max))));
                    const isKronosLowRow = !!(kronosBoundaries && zoomedProfile.length > 0 &&
                      Math.abs(d.levelPrice - kronosBoundaries.min) === Math.min(...zoomedProfile.map(x => Math.abs(x.levelPrice - kronosBoundaries.min))));

                    const futBarWidth = ((hasFuturesData ? d.futuresVolume : d.indexVolume) / (hasFuturesData ? maxFuturesVolume : maxIndexVolume)) * 100;

                    // Market Profile level tags — true when this grid row is the
                    // nearest level to the POC / VAH / VAL of the selected tf.
                    // Makes timeframe switching visually obvious (levels move).
                    const isPOC = !!futuresMP && zoomedProfile.length > 0 &&
                      Math.abs(d.levelPrice - futuresMP.poc) === Math.min(...zoomedProfile.map(x => Math.abs(x.levelPrice - futuresMP.poc)));
                    const isVAH = !!futuresMP && zoomedProfile.length > 0 &&
                      Math.abs(d.levelPrice - futuresMP.vah) === Math.min(...zoomedProfile.map(x => Math.abs(x.levelPrice - futuresMP.vah)));
                    const isVAL = !!futuresMP && zoomedProfile.length > 0 &&
                      Math.abs(d.levelPrice - futuresMP.val) === Math.min(...zoomedProfile.map(x => Math.abs(x.levelPrice - futuresMP.val)));

                    // OI bar widths (normalized to max total OI) + per-side fractions.
                    // Total width shows magnitude; color split shows put/call dominance.
                    // When OI is 0 (pre-market / freshly-listed 0DTE), bar width falls
                    // back to today's volume and renders as a single orange bar so the
                    // chart is never empty.
                    const idxTotalOI = d.indexCallOI + d.indexPutOI;
                    const idxHasOI   = idxTotalOI > 0;
                    const idxPutFrac  = idxHasOI ? d.indexPutOI  / idxTotalOI : 0;
                    const idxCallFrac = idxHasOI ? d.indexCallOI / idxTotalOI : 0;
                    const idxOIWidth  = maxIndexTotalOI > 0 ? (idxTotalOI / maxIndexTotalOI) * 100 : 0;
                    // Volume overlay marker position (independent scale — today's flow)
                    const idxVolWidth = maxIndexTotalVol > 0 ? (d.indexTotalVol / maxIndexTotalVol) * 100 : 0;
                    const idxBarWidth = idxHasOI ? idxOIWidth : idxVolWidth;

                    const etfTotalOI = d.etfCallOI + d.etfPutOI;
                    const etfHasOI   = etfTotalOI > 0;
                    const etfPutFrac  = etfHasOI ? d.etfPutOI  / etfTotalOI : 0;
                    const etfCallFrac = etfHasOI ? d.etfCallOI / etfTotalOI : 0;
                    const etfOIWidth  = maxEtfTotalOI > 0 ? (etfTotalOI / maxEtfTotalOI) * 100 : 0;
                    const etfVolWidth = maxEtfTotalVol > 0 ? (d.etfTotalVol / maxEtfTotalVol) * 100 : 0;
                    const etfBarWidth = etfHasOI ? etfOIWidth : etfVolWidth;

                    // Cross-symbol CONFLUENCE flag for this row. Candidates are
                    // pre-selected (capped at CONFLUENCE_MAX_LEVELS, ranked by
                    // combined OI width) in the `confluenceStrikes` memo above;
                    // here we just check membership and pull the put/call type.
                    const confluenceType = confluenceStrikes.get(d.strike);
                    const isConfluence = confluenceType !== undefined;

                    // Blend backgrounds
                    let rowBg = 'transparent';
                    if (isClosest) {
                      rowBg = 'rgba(234,179,8,0.2)'; // Yellow highlight for spot price
                    } else if (isFlipRow) {
                      rowBg = 'rgba(249,115,22,0.08)'; // Orange highlight for GEX Flip row
                    } else if (isConfluence) {
                      rowBg = 'rgba(245,158,11,0.12)'; // Amber highlight for cross-symbol confluence
                    } else if (isInKronosRange) {
                      if (isHVN) {
                        rowBg = 'rgba(59,130,246,0.12)'; // Soft blue base + indigo HVN blend
                      } else if (isLVN) {
                        rowBg = 'rgba(244,63,94,0.12)'; // Rose blend
                      } else {
                        rowBg = 'rgba(59,130,246,0.08)'; // Soft blue fill for general Kronos range
                      }
                    } else if (isHVN) {
                      rowBg = 'rgba(99,102,241,0.03)';
                    } else if (isLVN) {
                      rowBg = 'rgba(244,63,94,0.02)';
                    }

                    let borderTopStyle = 'none';
                    let borderBottomStyle = 'none';

                    if (isClosest) {
                      borderTopStyle = '1px solid rgba(234,179,8,0.45)';
                      borderBottomStyle = '1px solid rgba(234,179,8,0.45)';
                    } else if (isFlipRow) {
                      borderTopStyle = '1px dashed rgba(249,115,22,0.5)';
                      borderBottomStyle = '1px dashed rgba(249,115,22,0.5)';
                    } else if (isConfluence) {
                      borderTopStyle = '1px dashed rgba(245,158,11,0.55)';
                      borderBottomStyle = '1px dashed rgba(245,158,11,0.55)';
                    } else {
                      if (isKronosHighRow) {
                        borderTopStyle = '1.5px dashed rgba(59, 130, 246, 0.85)';
                      }
                      if (isKronosLowRow) {
                        borderBottomStyle = '1.5px dashed rgba(59, 130, 246, 0.85)';
                      }
                    }

                    return (
                      <div
                        key={d.strike}
                        className="relative grid grid-cols-[1fr_150px_1fr_1fr] gap-2 items-center transition-colors duration-150 rounded"
                        title={isInKronosRange ? `All'interno del Range Atteso di Kronos AI (${kronosTimeframe})` : undefined}
                        style={{
                          height: `${rowHeight}px`,
                          backgroundColor: rowBg,
                          borderTop: borderTopStyle,
                          borderBottom: borderBottomStyle,
                          borderLeft: isInKronosRange ? '3px solid rgba(59, 130, 246, 0.75)' : 'none',
                          borderRight: isInKronosRange ? '3px solid rgba(59, 130, 246, 0.75)' : 'none',
                        }}
                      >
                        {/* GEX-Flip badge (structural volatility-regime marker). Wall badges
                            were removed — the OI bars now make walls visible by shape. */}
                        {isFlipRow && rowHeight >= 18 && (
                          <span className="absolute left-2 top-1/2 transform -translate-y-1/2 text-[8px] font-extrabold uppercase tracking-wider bg-orange-600/95 text-white px-1.5 py-0.5 rounded border border-orange-500/40 whitespace-nowrap z-30 shadow-md">
                            ⚡ GEX Flip: ${(indexData.gexRegime.flipPoint * basisMultiplier).toFixed(0)}
                          </span>
                        )}
                        {isConfluence && rowHeight >= 18 && (
                          <span className={`absolute right-2 top-1/2 transform -translate-y-1/2 text-[8px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap z-30 shadow-md ${
                            confluenceType === 'support'
                              ? 'bg-red-600/95 text-white border border-red-400/50'
                              : 'bg-emerald-600/95 text-white border border-emerald-400/50'
                          }`}>
                            ★ Confl. {confluenceType === 'support' ? 'Put' : 'Call'} {futuresSymbol} ${(d.levelPrice * basisMultiplier).toFixed(0)}
                          </span>
                        )}
                        {isKronosHighRow && rowHeight >= 18 && (
                          <span className="absolute left-2 -top-2.5 text-[8px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos High: ${kronosRange.high.toFixed(0)}
                          </span>
                        )}
                        {isKronosLowRow && rowHeight >= 18 && (
                          <span className="absolute left-2 -bottom-2.5 text-[8px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos Low: ${kronosRange.low.toFixed(0)}
                          </span>
                        )}

                        {/* Column 1: ETF Options — OI bar (put/call split, rounded-l) + volume strip.
                            Bottom layer = OI (structural, defines walls), split put(red)/call(green).
                            Top strip (amber) = today's volume (independent scale, intraday flow).
                            When OI is 0 (pre-market), the whole bar shows volume in orange.
                            Level-centric grid: each Index row looks up the nearest ETF strike.
                            Several Index strikes can share one ETF strike (QQQ 1pt vs NDX 5pt);
                            the ETF bar is rendered ONLY on the primary row (the Index strike whose
                            true ETF price is closest to that strike) and hidden on the others,
                            so each ETF strike appears exactly once — no duplicate numbers. */}
                          {d.etfIsPrimary ? (
                          <div className="relative flex justify-end w-full pr-1 transition-all duration-300"
                               style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                               title={`ETF OI — Calls: ${formatCompact(d.etfCallOI)} | Puts: ${formatCompact(d.etfPutOI)}${etfHasOI ? '' : ' (pre-market)'}\nVol oggi: ${formatCompact(d.etfTotalVol)}`}>
                            <div className="flex h-full items-stretch rounded-l overflow-hidden" style={{ width: `${Math.max(2, etfBarWidth)}%` }}>
                              {etfHasOI ? (
                                <>
                                  {/* PUT (red) — support side */}
                                  <div style={{ width: `${etfPutFrac * 100}%`, backgroundColor: 'rgba(239,68,68,0.62)' }} />
                                  {/* CALL (green) — resistance side */}
                                  <div className="flex items-center justify-end pr-1" style={{ width: `${etfCallFrac * 100}%`, backgroundColor: 'rgba(16,185,129,0.62)' }}>
                                    {etfOIWidth > 12 && rowHeight >= 14 && (
                                      <span className="text-[8px] font-mono text-emerald-50 whitespace-nowrap">{formatCompact(etfTotalOI)}</span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                /* OI not yet settled (pre-market 0DTE) — show today's volume in orange */
                                <div className="h-full w-full flex items-center justify-end pr-1.5" style={{ backgroundColor: 'rgba(249,115,22,0.42)' }}>
                                  {etfVolWidth > 12 && rowHeight >= 14 && (
                                    <span className="text-[8px] font-mono text-orange-100 whitespace-nowrap">{formatCompact(d.etfTotalVol)}</span>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* Volume strip (amber, top) — today's traded volume, independent scale.
                                Right-aligned to match the OI bar (ETF grows from the right). */}
                            {etfHasOI && etfVolWidth > 1 && (
                              <div className="absolute top-0 rounded-l-sm" style={{ right: '4px', width: `calc(${etfVolWidth}% - 4px)`, height: `${Math.min(4, Math.max(2, rowHeight / 5))}px`, backgroundColor: 'rgba(251,191,36,0.55)' }} />
                            )}
                          </div>
                          ) : (
                            <div className="w-full" style={{ height: `${Math.max(4, rowHeight - 4)}px` }} title="Livello ETF già mostrato sulla riga principale" />
                          )}

                        {/* Column 2: Center Strike Price */}
                        <div className="flex items-center justify-center font-mono relative w-full" style={{ height: `${rowHeight}px` }}>
                          <span
                            className={`font-bold transition-colors shrink-0 ${
                              rowHeight < 15 ? 'text-[7.5px]' :
                              rowHeight < 20 ? 'text-[8.5px]' :
                              rowHeight < 26 ? 'text-[9.5px]' : 'text-[11px]'
                            }`}
                            style={{
                              color: isClosest ? '#ffffff' : isHVN ? '#818cf8' : isLVN ? '#fb7185' : '#94a3b8',
                              backgroundColor: isClosest ? '#2563eb' : 'transparent',
                              padding: isClosest ? '1.5px 5px' : '0',
                              borderRadius: isClosest ? '4px' : '0',
                              lineHeight: 1,
                            }}
                          >
                            F: {d.levelPrice.toFixed(0)}{d.etfIsPrimary ? ` | E: ${d.etfPrice.toFixed(1)}` : ''}
                          </span>
                          {isClosest && rowHeight >= 18 && (
                            <span className="absolute -bottom-3 text-[8px] text-yellow-400 font-extrabold uppercase tracking-wider bg-[#0d1117]/95 px-1.5 py-0.5 rounded border border-yellow-500/40 z-35 shadow-md whitespace-nowrap">
                              Spot: F: {(() => {
                                const fs = market === 'SP500' ? 'ES' : 'NQ';
                                return (liveSpot[fs as keyof typeof liveSpot] || indexSpot).toFixed(1);
                              })()} | E: {etfCashSpot.toFixed(2)}
                            </span>
                          )}
                        </div>

                        {/* Column 4: Index Options — OI bar (put/call split, rounded-r) + volume strip.
                            Same design as the ETF bar. Bottom = OI structural, top strip (amber) = volume.
                            Duplicate Index-strike levels (rare at default zoom) render at reduced
                            opacity — data stays visible, primary level stands out. */}
                          <div className="relative flex justify-start w-full pl-1 transition-all duration-300"
                               style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                               title={`Index OI — Calls: ${formatCompact(d.indexCallOI)} | Puts: ${formatCompact(d.indexPutOI)}${idxHasOI ? '' : ' (pre-market)'}\nVol oggi: ${formatCompact(d.indexTotalVol)}`}>
                            <div className="flex h-full items-stretch rounded-r overflow-hidden" style={{ width: `${Math.max(2, idxBarWidth)}%` }}>
                              {idxHasOI ? (
                                <>
                                  {/* PUT (red) — support side */}
                                  <div style={{ width: `${idxPutFrac * 100}%`, backgroundColor: 'rgba(239,68,68,0.62)' }} />
                                  {/* CALL (green) — resistance side */}
                                  <div className="flex items-center justify-start pl-1" style={{ width: `${idxCallFrac * 100}%`, backgroundColor: 'rgba(16,185,129,0.62)' }}>
                                    {idxOIWidth > 12 && rowHeight >= 14 && (
                                      <span className="text-[8px] font-mono text-emerald-50 whitespace-nowrap">{formatCompact(idxTotalOI)}</span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <div className="h-full w-full flex items-center justify-start pl-1.5" style={{ backgroundColor: 'rgba(249,115,22,0.42)' }}>
                                  {idxVolWidth > 12 && rowHeight >= 14 && (
                                    <span className="text-[8px] font-mono text-orange-100 whitespace-nowrap">{formatCompact(d.indexTotalVol)}</span>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* Volume strip (amber, top) — left-aligned to match the OI bar (Index grows from the left) */}
                            {idxHasOI && idxVolWidth > 1 && (
                              <div className="absolute top-0 rounded-r-sm" style={{ left: '4px', width: `calc(${idxVolWidth}% - 4px)`, height: `${Math.min(4, Math.max(2, rowHeight / 5))}px`, backgroundColor: 'rgba(251,191,36,0.55)' }} />
                            )}
                          </div>

                        {/* Column 5: Futures Volume profile (oriented left) */}
                        <div className="flex justify-start w-full pl-1 relative transition-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
                          <div
                            className="h-full rounded-r flex items-center justify-start pl-1.5 overflow-hidden"
                            style={{
                              width: `${Math.max(2, futBarWidth)}%`,
                              backgroundColor: isInKronosRange
                                ? (isHVN ? 'rgba(129,140,248,0.55)' : isLVN ? 'rgba(244,63,94,0.15)' : 'rgba(34,197,94,0.45)')
                                : (isHVN ? 'rgba(129,140,248,0.35)' : isLVN ? 'rgba(244,63,94,0.06)' : 'rgba(34,197,94,0.22)'),
                              borderLeft: isLVN ? '1px dashed rgba(244,63,94,0.4)' : 'none',
                              borderRight: isLVN ? '1px dashed rgba(244,63,94,0.4)' : 'none',
                            }}
                          >
                            {futBarWidth > 8 && rowHeight >= 14 && (
                              <span className="text-[8px] font-mono text-green-200">
                                {formatCompact(hasFuturesData ? d.futuresVolume : d.indexVolume)}
                              </span>
                            )}
                          </div>

                          {/* Right-aligned node badges overlay */}
                          {rowHeight >= 14 && (
                            <div 
                              className="absolute right-2 top-0 flex gap-1 items-center"
                              style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                            >
                              {/* Market Profile levels of the selected tf — POC/VAH/VAL */}
                              {isVAL && (
                                <span title={`Value Area Low (${resolvedFuturesProfile.tf})`} className="px-1 py-0.5 rounded text-[8px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40 uppercase" style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}>VAL</span>
                              )}
                              {isVAH && (
                                <span title={`Value Area High (${resolvedFuturesProfile.tf})`} className="px-1 py-0.5 rounded text-[8px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40 uppercase" style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}>VAH</span>
                              )}
                              {isPOC && (
                                <span title={`Point of Control (${resolvedFuturesProfile.tf})`} className="px-1 py-0.5 rounded text-[8px] font-extrabold bg-amber-500/30 text-amber-200 border border-amber-400/50 uppercase" style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}>POC</span>
                              )}
                              {isHVN && (
                                <span 
                                  className="px-1 py-0.5 rounded text-[8px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 uppercase"
                                  style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}
                                >
                                  HVN
                                </span>
                              )}
                              {isLVN && isTrough && (
                                <span 
                                  className="px-1 py-0.5 rounded text-[8px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 uppercase"
                                  style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}
                                >
                                  LVN Zone
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }))}
                </div>
              </div>
            </div>
          </div>

          {/* ================================================================== */}
          {/* BOTTOM PANEL: STRUCTURAL ANALYSIS, FVA LIST, AND COLLAPSIBLE LEGEND */}
          {/* ================================================================== */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Structural Analysis Card */}
            <StructuralAnalysisCard analysis={analysis as StructuralAnalysis | null} />

            {/* Fair Value Areas List */}
            <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5 h-full">
              <h3 className="text-xs font-bold tracking-wider text-gray-400 uppercase mb-4">
                Aree di Fair Value (FVA)
              </h3>
              <div className="flex flex-col gap-3">
                {fairValueAreas.map((area) => (
                  <div
                    key={area.id}
                    className="p-3 rounded-xl border transition-all duration-200"
                    style={{
                      backgroundColor: area.status === 'current' ? 'rgba(59,130,246,0.05)' : 'rgba(255,255,255,0.01)',
                      borderColor: area.status === 'current' ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.05)',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-gray-400">FVA #{area.id}</span>
                      {area.status === 'current' && (
                        <span className="text-[9px] font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20 uppercase tracking-wide">
                          Prezzo Dentro
                        </span>
                      )}
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-xs text-gray-500">Range:</span>
                      <span className="text-xs font-mono font-bold text-gray-300">
                        ${area.low.toFixed(0)} - ${area.high.toFixed(0)}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline mt-1">
                      <span className="text-xs text-gray-500">POC (Strike Magnete):</span>
                      <span className="text-xs font-mono font-bold text-indigo-400">
                        ${area.poc.toFixed(0)}
                      </span>
                    </div>
                    {area.volumeShare != null && area.volumeShare > 0 && (
                      <div className="mt-1.5">
                        <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
                          <span>Quota volumi</span>
                          <span className="font-mono font-bold">{(area.volumeShare * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                          <div className="h-full rounded-full bg-indigo-500/60" style={{ width: `${Math.min(100, area.volumeShare * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

          </div>
            </>
          )}
        </div>
      </main>

      {/* ================================================================== */}
      {/* FOOTER                                                             */}
      {/* ================================================================== */}
      <footer className="border-t border-gray-800/50 px-4 py-2 mt-auto">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between text-[10px] text-gray-600">
          <span>QuantFlow AI</span>
          {lastRefreshed && (
            <span>Aggiornato il: {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
