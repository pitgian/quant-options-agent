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
import { formatCompact, formatTimestamp } from '../utils/formatting';
import { IconRefresh } from './Icons';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { EXPIRY_OPTIONS } from '../lib/expiry';
import { KRONOS_TIMEFRAMES, getActiveKronosForecast, type KronosTimeframe } from '../lib/kronos';
import { MarketStructureHeader, type FuturesTimeframe } from './MarketStructureHeader';
import { StructuralAnalysisCard, LegendCard, type StructuralAnalysis } from './MarketStructurePanels';

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
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [showKronosDetails, setShowKronosDetails] = useState(false);
  const [kronosTimeframe, setKronosTimeframe] = useState<KronosTimeframe>('1h');

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

  // ---- Extract and Merge Profile Data ----
  const profileData = useMemo(() => {
    if (!indexData || !etfData) return [];

    const indexSpot = indexData.spot;
    const etfSpot = etfData.spot;
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

    // ---- Build the level grid ----
    // Uniform % step from the structural anchor; ~100 rows regardless of zoom so the
    // bar density stays readable. Level prices are real (non-rounded) futures
    // prices so they can be copied straight to an execution chart.
    const targetRows = 100;
    const stepPct = Math.max(0.01, (2 * zoomPct) / targetRows);
    const rows: any[] = [];
    let idxPtr = 0, etfPtr = 0; // moving pointers for O(1)-amortized nearest-strike walk

    // Per-instrument de-duplication: the grid step (~0.08%) is finer than the
    // ETF strike spacing (1pt ≈ 0.14% at SPY), so 2-3 grid levels round to the
    // same SPY strike and would render identical bars. For each unique strike
    // we mark the grid level nearest to its true price as 'primary'; the rest
    // render a faint connector so the level grid stays aligned across columns
    // (you can still read across a row) without showing duplicate bars.
    const etfPrimaryLevel = new Map<number, number>(); // etfStrike → best grid levelPrice
    const idxPrimaryLevel = new Map<number, number>();

    for (let i = 0; i <= targetRows; i++) {
      const dPct = -zoomPct + i * stepPct;
      if (Math.abs(dPct) > zoomPct + 1e-9) continue;

      const levelPrice = gridAnchor * (1 + dPct / 100); // ES/futures scale (~ SPX)
      const etfPrice   = etfSpot   * (1 + dPct / 100);   // SPY scale

      // nearest Index strike to the futures-scale level price (monotonic walk)
      while (idxPtr + 1 < indexStrikes.length && Math.abs(indexStrikes[idxPtr + 1] - levelPrice) < Math.abs(indexStrikes[idxPtr] - levelPrice)) idxPtr++;
      // nearest ETF strike to the ETF-scale level price
      while (etfPtr + 1 < etfStrikes.length && Math.abs(etfStrikes[etfPtr + 1] - etfPrice) < Math.abs(etfStrikes[etfPtr] - etfPrice)) etfPtr++;

      const nearestIdxStrike = indexStrikes[idxPtr];
      const nearestEtfStrike = etfStrikes[etfPtr];
      // Track the grid level nearest to each strike's TRUE price
      const curIdx = idxPrimaryLevel.get(nearestIdxStrike);
      if (curIdx === undefined || Math.abs(levelPrice - nearestIdxStrike) < Math.abs(curIdx - nearestIdxStrike)) idxPrimaryLevel.set(nearestIdxStrike, levelPrice);
      const curEtf = etfPrimaryLevel.get(nearestEtfStrike);
      const trueEtf = nearestEtfStrike;
      if (curEtf === undefined || Math.abs(etfPrice - trueEtf) < Math.abs(curEtf - trueEtf)) etfPrimaryLevel.set(nearestEtfStrike, etfPrice);

      const indexStrikeData = indexByStrike.get(nearestIdxStrike);
      const etfStrikeData   = etfByStrike.get(nearestEtfStrike);

      const idxCallOI  = indexStrikeData?.callOI    ?? 0;
      const idxPutOI   = indexStrikeData?.putOI     ?? 0;
      const idxCallVol = indexStrikeData?.callVolume ?? 0;
      const idxPutVol  = indexStrikeData?.putVolume  ?? 0;
      const etfCallOI  = etfStrikeData?.callOI    ?? 0;
      const etfPutOI   = etfStrikeData?.putOI     ?? 0;
      const etfCallVol = etfStrikeData?.callVolume ?? 0;
      const etfPutVol  = etfStrikeData?.putVolume  ?? 0;

      const indexVolume = idxCallOI + idxPutOI + idxCallVol + idxPutVol;
      const etfVolume   = etfCallOI + etfPutOI + etfCallVol + etfPutVol;
      const futuresVolume = futuresVolAt(levelPrice);

      rows.push({
        strike: levelPrice,        // unique row id (futures-scale price)
        futuresStrike: levelPrice, // alias — Kronos boundary / isClosest logic
        etfStrike: nearestEtfStrike,
        indexStrike: nearestIdxStrike, // nearest Index strike (for de-dup lookup)
        etfPrice,                  // exact ETF price at this level (for label)
        levelPrice,                // exact futures price (for label)
        distancePct: dPct,
        indexVolume, etfVolume, futuresVolume,
        indexCallOI: idxCallOI, indexPutOI: idxPutOI,
        etfCallOI, etfPutOI,
        indexTotalOI: idxCallOI + idxPutOI,
        indexTotalVol: idxCallVol + idxPutVol,
        etfTotalOI: etfCallOI + etfPutOI,
        etfTotalVol: etfCallVol + etfPutVol,
        etfIsPrimary: false,   // filled in post-pass below
        indexIsPrimary: false,
      });
    }
    // Post-pass: stamp each row with whether it is the primary level for its
    // ETF strike / Index strike (the grid level nearest to that strike's true
    // price). Done after the loop so the primary maps are complete.
    for (const r of rows) {
      r.etfIsPrimary   = etfPrimaryLevel.get(r.etfStrike) === r.etfPrice;
      r.indexIsPrimary = idxPrimaryLevel.get(r.indexStrike) === r.levelPrice;
    }
    return rows;
  }, [indexData, etfData, expiryFilter, selectedFuturesTf, basisMultiplier, market, zoomPct]);

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
  const kronosBoundaries = useMemo(() => {
    if (!kronosRange || zoomedProfile.length === 0) return null;
    const strikesInRange = zoomedProfile.filter(d => d.futuresStrike >= kronosRange.low && d.futuresStrike <= kronosRange.high);
    
    if (strikesInRange.length > 0) {
      const strikes = strikesInRange.map(d => d.strike);
      return {
        min: Math.min(...strikes),
        max: Math.max(...strikes)
      };
    }

    // If range is extremely narrow (no strikes inside), snap to closest strikes
    const closestToLow = zoomedProfile.reduce((prev, curr) => 
      Math.abs(curr.futuresStrike - kronosRange.low) < Math.abs(prev.futuresStrike - kronosRange.low) ? curr : prev
    );
    const closestToHigh = zoomedProfile.reduce((prev, curr) => 
      Math.abs(curr.futuresStrike - kronosRange.high) < Math.abs(prev.futuresStrike - kronosRange.high) ? curr : prev
    );

    return {
      min: Math.min(closestToLow.strike, closestToHigh.strike),
      max: Math.max(closestToLow.strike, closestToHigh.strike)
    };
  }, [kronosRange, zoomedProfile]);

  const hasFuturesData = useMemo(() => {
    return zoomedProfile.some(d => d.futuresVolume > 0);
  }, [zoomedProfile]);

  // ---- Node detection (HVN & LVN) using Futures/Combined volume ----
  const nodes = useMemo(() => {
    if (zoomedProfile.length === 0) {
      return { hvnStrikes: new Set<number>(), lvnStrikes: new Set<number>(), lvnZones: new Map<number, { low: number; high: number }>() };
    }

    const targetVolumes = zoomedProfile
      .map(d => hasFuturesData ? d.futuresVolume : (d.etfVolume + d.indexVolume))
      .filter(v => v > 0);
    targetVolumes.sort((a, b) => a - b);
    const medianVolume = targetVolumes.length > 0 ? targetVolumes[Math.floor(targetVolumes.length / 2)] : 0;

    const hvnStrikes = new Set<number>();
    const lvnStrikes = new Set<number>();
    const lvnZones = new Map<number, { low: number; high: number }>();

    for (let i = 2; i < zoomedProfile.length - 2; i++) {
      const window = [
        zoomedProfile[i - 2],
        zoomedProfile[i - 1],
        zoomedProfile[i],
        zoomedProfile[i + 1],
        zoomedProfile[i + 2],
      ].map(d => hasFuturesData ? d.futuresVolume : (d.etfVolume + d.indexVolume));

      const v_curr = window[2];
      const max_val = Math.max(...window);
      const min_val = Math.min(...window);
      const max_surrounding = Math.max(window[0], window[1], window[3], window[4]);

      // Peak (HVN)
      if (v_curr === max_val && v_curr > medianVolume * 1.15) {
        hvnStrikes.add(zoomedProfile[i].strike);
      }

      // Trough (LVN)
      if (v_curr === min_val && max_surrounding > 0 && v_curr <= max_surrounding * 0.5 && v_curr < medianVolume * 0.8) {
        lvnStrikes.add(zoomedProfile[i].strike);

        let leftIdx = i;
        while (leftIdx > 0) {
          const v_left = hasFuturesData ? zoomedProfile[leftIdx - 1].futuresVolume : (zoomedProfile[leftIdx - 1].etfVolume + zoomedProfile[leftIdx - 1].indexVolume);
          if (v_left <= v_curr * 1.5 && v_left < medianVolume * 0.7) {
            leftIdx--;
          } else {
            break;
          }
        }

        let rightIdx = i;
        while (rightIdx < zoomedProfile.length - 1) {
          const v_right = hasFuturesData ? zoomedProfile[rightIdx + 1].futuresVolume : (zoomedProfile[rightIdx + 1].etfVolume + zoomedProfile[rightIdx + 1].indexVolume);
          if (v_right <= v_curr * 1.5 && v_right < medianVolume * 0.7) {
            rightIdx++;
          } else {
            break;
          }
        }

        lvnZones.set(zoomedProfile[i].strike, {
          low: zoomedProfile[leftIdx].strike,
          high: zoomedProfile[rightIdx].strike,
        });
      }
    }

    return { hvnStrikes, lvnStrikes, lvnZones };
  }, [zoomedProfile]);

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
      if (strikesInArea.length === 0) return;

      let poc = strikesInArea[0].strike;
      let maxVol = -1;
      const hasFutures = strikesInArea.some(d => d.futuresVolume > 0);

      for (const d of strikesInArea) {
        const vol = hasFutures ? d.futuresVolume : (d.etfVolume + d.indexVolume);
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
        status,
      });
    });

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
      <MarketStructureHeader
        market={market}
        setMarket={setMarket}
        zoomPct={zoomPct}
        setZoomPct={setZoomPct}
        rowHeight={rowHeight}
        setRowHeight={setRowHeight}
        expiryFilter={expiryFilter}
        setExpiryFilter={setExpiryFilter}
        selectedFuturesTf={selectedFuturesTf}
        setSelectedFuturesTf={setSelectedFuturesTf}
        kronosTimeframe={kronosTimeframe}
        setKronosTimeframe={setKronosTimeframe}
        refreshing={refreshing}
        handleRefresh={handleRefresh}
        timeSinceUpdate={timeSinceUpdate}
        isBackgroundRefreshing={isBackgroundRefreshing}
        flashVisible={flashVisible}
      />
      {/* ================================================================== */}
      {/* MAIN CONTENT AREA                                                 */}
      {/* ================================================================== */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col gap-6 w-full animate-fadeIn">
          
          {/* ================================================================== */}
          {/* TOP PANEL: METRICS & SPOT                                          */}
          {/* ================================================================== */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            
            {/* Spot & Futures Prices */}
            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Prezzi Spot & Futures</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[9px] text-gray-400 font-medium uppercase font-semibold">ETF Cash ({etfSymbol})</span>
                  <div className="text-sm font-mono font-bold text-white">
                    ${etfCashSpot.toFixed(2)}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[9px] text-blue-400 font-medium uppercase font-semibold">Futures ({futuresSymbol})</span>
                  <div className="text-sm font-mono font-bold text-blue-400 font-semibold">
                    ${futuresSpot.toFixed(1)}
                  </div>
                </div>
              </div>
            </div>

            {/* GEX Regimes */}
            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col justify-center">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Regime GEX & Covariate</span>
              <div className="mt-2 grid grid-cols-2 gap-4">
                <div>
                  <span className="text-[9px] text-gray-400 font-medium block">Indice ({indexData.symbol})</span>
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      backgroundColor: indexData.gexRegime.regime === 'positive' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                      color: indexData.gexRegime.regime === 'positive' ? '#4ade80' : '#f87171',
                    }}
                  >
                    {indexData.gexRegime.regime === 'positive' ? '▲ Positivo' : '▼ Negativo'}
                  </span>
                  {indexData.gexRegime.flipPoint && (
                    <div className="text-[9px] text-gray-500 mt-0.5 font-mono">
                      Flip: ${indexData.gexRegime.flipPoint.toFixed(0)}
                    </div>
                  )}
                  {indexData.volatilitySkew25d !== undefined && (
                    <div className="text-[9px] text-gray-400 mt-1 font-mono">
                      Skew: <span className="text-amber-400 font-bold">{indexData.volatilitySkew25d > 0 ? '+' : ''}{(indexData.volatilitySkew25d * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {indexData.putCallOiRatio !== undefined && (
                    <div className="text-[9px] text-gray-400 font-mono">
                      PCR (OI): <span className="text-indigo-400 font-bold">{indexData.putCallOiRatio.toFixed(2)}</span>
                    </div>
                  )}
                </div>
                <div>
                  <span className="text-[9px] text-gray-400 font-medium block">ETF ({etfData.symbol})</span>
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      backgroundColor: etfData.gexRegime.regime === 'positive' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                      color: etfData.gexRegime.regime === 'positive' ? '#4ade80' : '#f87171',
                    }}
                  >
                    {etfData.gexRegime.regime === 'positive' ? '▲ Positivo' : '▼ Negativo'}
                  </span>
                  {etfData.gexRegime.flipPoint && (
                    <div className="text-[9px] text-gray-500 mt-0.5 font-mono">
                      Flip: ${etfData.gexRegime.flipPoint.toFixed(1)}
                    </div>
                  )}
                  {etfData.volatilitySkew25d !== undefined && (
                    <div className="text-[9px] text-gray-400 mt-1 font-mono">
                      Skew: <span className="text-amber-400 font-bold">{etfData.volatilitySkew25d > 0 ? '+' : ''}{(etfData.volatilitySkew25d * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {etfData.putCallOiRatio !== undefined && (
                    <div className="text-[9px] text-gray-400 font-mono">
                      PCR (OI): <span className="text-indigo-400 font-bold">{etfData.putCallOiRatio.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Quick Market State */}
            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col justify-center">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Stato di Mercato</span>
              {analysis && (
                <div className="mt-1 text-xs leading-snug">
                  {analysis.currentArea ? (
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400">Fair Value Area:</span>
                      <span className="font-mono font-bold text-gray-200">${analysis.currentArea.low.toFixed(0)} - ${analysis.currentArea.high.toFixed(0)}</span>
                    </div>
                  ) : (
                    <div className="text-gray-400">Prezzo fuori dai nodi principali</div>
                  )}
                  {analysis.nearestBoundary && (
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-gray-400">Confine {analysis.nearestBoundary.type.split(' ')[0]}:</span>
                      <span className="font-mono font-bold text-rose-400">${analysis.nearestBoundary.low.toFixed(0)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Kronos Predictor */}
            <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col justify-between min-h-[140px] relative">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Kronos AI Predictor</span>
                    {kronosForecast && (
                      <span 
                        className="text-[8px] text-gray-650 font-mono"
                        title={`Aggiornato: ${new Date(kronosForecast.updated_at).toLocaleString()}`}
                      >
                        ({new Date(kronosForecast.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                      </span>
                    )}
                  </div>
                </div>
                {(() => {
                  if (!kronosForecast) {
                    return <div className="text-xs text-gray-500 mt-2">Caricamento previsioni...</div>;
                  }
                  if (!activeKronosForecast) {
                    return <div className="text-xs text-gray-500 mt-2">Dati non disponibili</div>;
                  }
                  
                  const isBullish = activeKronosForecast.trendBias === 'BULLISH';
                  const isBearish = activeKronosForecast.trendBias === 'BEARISH';
                  const trendColor = isBullish ? '#4ade80' : isBearish ? '#f87171' : '#94a3b8';
                  const trendBg = isBullish ? 'rgba(34,197,94,0.12)' : isBearish ? 'rgba(239,68,68,0.12)' : 'rgba(148,163,184,0.12)';
                  
                  // Volatility Classification
                  let volLabel = "Moderata";
                  let volColor = "#eab308"; // yellow
                  let volBg = "rgba(234,179,8,0.1)";
                  if (activeKronosForecast.volatilityPct < 0.2) {
                    volLabel = "Bassa";
                    volColor = "#4ade80"; // green
                    volBg = "rgba(34,197,94,0.1)";
                  } else if (activeKronosForecast.volatilityPct >= 0.5) {
                    volLabel = "Elevata";
                    volColor = "#f87171"; // red
                    volBg = "rgba(239,68,68,0.1)";
                  }

                  // Sparkline path math
                  let sparklineSvg = null;
                  if (activeKronosForecast.candles && activeKronosForecast.candles.length > 0) {
                    const prices = [activeKronosForecast.lastPrice, ...activeKronosForecast.candles.map(c => c.close)];
                    const minP = Math.min(...prices);
                    const maxP = Math.max(...prices);
                    const pRange = maxP - minP || 1;
                    
                    const w = 180;
                    const h = 32;
                    const padding = 3;
                    
                    const points = prices.map((p, i) => {
                      const x = (i / (prices.length - 1)) * (w - 20) + 10;
                      const y = h - ((p - minP) / pRange) * (h - 2 * padding) - padding;
                      return { x, y, price: p };
                    });
                    
                    const pointsStr = points.map(pt => `${pt.x},${pt.y}`).join(' ');
                    
                    sparklineSvg = (
                      <div className="flex flex-col items-center mt-2 p-1.5 bg-slate-900/30 rounded-lg border border-slate-800/40">
                        <span className="text-[8px] text-gray-500 mb-1 font-semibold uppercase tracking-wider">Traiettoria prezzi (Sparkline)</span>
                        <svg width={w} height={h} className="overflow-visible">
                          <polyline
                            fill="none"
                            stroke={trendColor}
                            strokeWidth="1.5"
                            strokeDasharray="1 1"
                            points={pointsStr}
                          />
                          {points.map((pt, i) => (
                            <g key={i}>
                              <circle
                                cx={pt.x}
                                cy={pt.y}
                                r={i === 0 ? "2.5" : i === points.length - 1 ? "3" : "2"}
                                fill={i === 0 ? "#ffffff" : trendColor}
                                stroke={i === 0 ? "#3b82f6" : "none"}
                                strokeWidth={i === 0 ? "1" : "0"}
                              />
                              <title>Step {i}: ${pt.price.toFixed(2)}</title>
                            </g>
                          ))}
                        </svg>
                        <div className="flex justify-between w-full text-[8px] text-gray-500 px-1 mt-1 font-mono">
                          <span>Spot</span>
                          {kronosTimeframe !== '15m' && (
                            <span>
                              {kronosTimeframe === '30m' ? '+15m' :
                               kronosTimeframe === '1h' ? '+30m' :
                               kronosTimeframe === '2h' ? '+1h' :
                               kronosTimeframe === '4h' ? '+2h' :
                               kronosTimeframe === 'EOD' ? '+3h' :
                               kronosTimeframe === '2D' ? '+8h' :
                               kronosTimeframe === '3D' ? '+12h' : '+3 G'}
                            </span>
                          )}
                          <span>+{kronosTimeframe}</span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className="mt-1.5 text-xs leading-tight">
                      {/* Bias and Strength */}
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">Bias:</span>
                        <span
                          className="font-bold px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
                          style={{ backgroundColor: trendBg, color: trendColor }}
                        >
                          {isBullish ? '🟢 Rialzista' : isBearish ? '🔴 Ribassista' : '⚪ Neutrale'}
                        </span>
                      </div>

                      {/* Expected Price Range */}
                      <div className="flex flex-col gap-1 mt-1.5 pt-1.5 border-t border-slate-800/30">
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 font-medium">Range Atteso ({kronosTimeframe}):</span>
                          <span className="font-mono font-semibold text-blue-400">
                            ${kronosRange ? kronosRange.low.toFixed(0) : '0'} - ${kronosRange ? kronosRange.high.toFixed(0) : '0'}
                          </span>
                        </div>
                      </div>

                      {/* Expected Volatility */}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-gray-400 font-medium">Volatilità Prevista:</span>
                        <span
                          className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider font-mono"
                          style={{ backgroundColor: volBg, color: volColor }}
                          title={`Volatilità stimata sul range: ${activeKronosForecast.volatilityPct.toFixed(3)}%`}
                        >
                          {activeKronosForecast.volatilityPct.toFixed(2)}% ({volLabel})
                        </span>
                      </div>

                      {sparklineSvg}

                      {/* Expandable detailed timeline */}
                      <div className="mt-2 pt-2 border-t border-slate-800/40">
                        <button
                          onClick={() => setShowKronosDetails(!showKronosDetails)}
                          className="w-full text-center text-[9px] text-blue-400 hover:text-blue-300 font-semibold tracking-wider uppercase transition-colors"
                        >
                          {showKronosDetails ? '▲ Nascondi Timeline' : `▼ Mostra Proiezioni 15m (${kronosTimeframe})`}
                        </button>
                        
                        {showKronosDetails && activeKronosForecast.candles && (
                          <div className="mt-1.5 max-h-[120px] overflow-y-auto pr-0.5 custom-scrollbar text-[10px] bg-slate-900/50 rounded-lg p-2 border border-slate-800/60 font-mono">
                            <div className="grid grid-cols-3 text-[8px] text-gray-500 font-bold uppercase pb-1 border-b border-slate-800">
                              <span>Candela</span>
                              <span className="text-center">Prezzo</span>
                              <span className="text-right">Var.</span>
                            </div>
                            {activeKronosForecast.candles.map((candle, idx) => {
                              const stepDelta = ((candle.close - activeKronosForecast.lastPrice) / activeKronosForecast.lastPrice) * 100;
                              return (
                                <div key={idx} className="grid grid-cols-3 py-0.5 text-gray-300 border-b border-slate-850/40 last:border-b-0">
                                  <span className="text-gray-400 font-sans">+{15 * (idx + 1)}m</span>
                                  <span className="text-center font-bold">${candle.close.toFixed(2)}</span>
                                  <span 
                                    className="text-right font-bold" 
                                    style={{ color: stepDelta > 0 ? '#4ade80' : stepDelta < 0 ? '#f87171' : '#94a3b8' }}
                                  >
                                    {stepDelta > 0 ? '+' : ''}{stepDelta.toFixed(2)}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                    </div>
                  );
                })()}
              </div>
            </div>

          </div>

          {/* ================================================================== */}
          {/* PROFILE CHART (WIDESCREEN FULL WIDTH)                              */}
          {/* ================================================================== */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 flex flex-col w-full">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                  📊 Profilo Volumi Unificato (3-Profile Chart)
                  {!hasFuturesData && (
                    <span className="text-xs font-normal text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      Fallback Opzioni
                    </span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Analisi incrociata delle opzioni retail (ETF) a sinistra, opzioni istituzionali (Indice) al centro-destra e volumi futures a destra.
                </p>
                <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-slate-850 text-[10px] text-gray-400">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-5 rounded-full overflow-hidden flex" style={{ background: 'linear-gradient(to right, rgba(16,185,129,0.7) 50%, rgba(239,68,68,0.7) 50%)' }}></span>
                    <span><strong>Larghezza barra:</strong> Open Interest totale (livello strutturale — definisce i wall)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-3 rounded-full" style={{ background: 'linear-gradient(to right, rgba(16,185,129,0.7), rgba(239,68,68,0.7))' }}></span>
                    <span><strong>Colore barra:</strong> 🟢 Call OI (resistenza) · 🔴 Put OI (supporto)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-1 w-5 rounded-sm" style={{ backgroundColor: 'rgba(251,191,36,0.55)' }}></span>
                    <span><strong>Striscia ambra in cima:</strong> Volume scambiato oggi (scala indipendente — flusso intraday)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="px-1 py-0.5 rounded text-[8px] font-extrabold bg-amber-500/30 text-amber-200 border border-amber-400/50 uppercase">POC</span>
                    <span><strong>Point of Control</strong> del timeframe futures selezionato (prezzo a maggior volume)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40 uppercase">VAH · VAL</span>
                    <span><strong>Value Area High/Low</strong> — range col 70% del volume del tf selezionato</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-0.5 rounded-sm" style={{ backgroundColor: 'rgba(148,163,184,0.5)' }}></span>
                    <span><strong>Trattino grigio:</strong> strike già mostrato sulla riga principale (griglia ETF più fine di quella livello)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500/40"></span>
                    <span>
                      <strong>Volumi Futures:</strong> Storico {
                        selectedFuturesTf === 'auto' ? 'allineato alla scadenza' : 'personalizzato'
                      } ({
                        (() => {
                          let tf = '30d';
                          if (selectedFuturesTf === 'auto') {
                            if (expiryFilter === '0dte') tf = '2d';
                            else if (expiryFilter === '1-7dte') tf = '7d';
                            else if (expiryFilter === '8-30dte') tf = '30d';
                            else if (expiryFilter === '30+dte') tf = '90d';
                          } else {
                            tf = selectedFuturesTf;
                          }
                          return tf === '1d' ? 'Giornaliero' :
                                 tf === '2d' ? '2 Giorni' :
                                 tf === '5d' ? 'Settimanale' :
                                 tf === '7d' ? '7 Giorni' :
                                 tf === '30d' ? 'Mensile' :
                                 tf === '90d' ? 'Trimestrale' :
                                 tf === 'max' ? 'Cumulativo' : tf;
                        })()
                      })
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scrollable container for mobile responsiveness */}
            <div className="overflow-x-auto select-none">
              <div className="min-w-[700px] md:min-w-0">
                {/* Header labels for profiles */}
                <div className="grid grid-cols-[1fr_150px_1fr_1fr] gap-2 mb-2 px-2 text-[9px] font-bold tracking-wider text-gray-500 uppercase">
                  <span className="text-right">Opzioni ETF (OI+Vol)</span>
                  <span className="text-center">Prezzo Livello (F | E)</span>
                  <span className="text-left">Opzioni Indice (OI+Vol)</span>
                  <span className="text-left">Volumi Futures</span>
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
                    const isInKronosRange = !!(kronosBoundaries && d.strike >= kronosBoundaries.min && d.strike <= kronosBoundaries.max);
                    const flipPoint = indexData?.gexRegime?.flipPoint;
                    const isFlipRow = flipPoint
                      ? Math.abs(d.strike - flipPoint * basisMultiplier) === Math.min(...zoomedProfile.map(x => Math.abs(x.strike - flipPoint * basisMultiplier)))
                      : false;

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

                    // Blend backgrounds
                    let rowBg = 'transparent';
                    if (isClosest) {
                      rowBg = 'rgba(234,179,8,0.2)'; // Yellow highlight for spot price
                    } else if (isFlipRow) {
                      rowBg = 'rgba(249,115,22,0.08)'; // Orange highlight for GEX Flip row
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
                    } else {
                      if (kronosBoundaries && d.strike === kronosBoundaries.max) {
                        borderTopStyle = '1.5px dashed rgba(59, 130, 246, 0.85)';
                      }
                      if (kronosBoundaries && d.strike === kronosBoundaries.min) {
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
                        {kronosBoundaries && d.strike === kronosBoundaries.max && rowHeight >= 18 && (
                          <span className="absolute left-2 -top-2.5 text-[8px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos High: ${kronosRange.high.toFixed(0)}
                          </span>
                        )}
                        {kronosBoundaries && d.strike === kronosBoundaries.min && rowHeight >= 18 && (
                          <span className="absolute left-2 -bottom-2.5 text-[8px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos Low: ${kronosRange.low.toFixed(0)}
                          </span>
                        )}

                        {/* Column 1: ETF Options — OI bar (put/call split, rounded-l) + volume strip.
                            Bottom layer = OI (structural, defines walls), split put(red)/call(green).
                            Top strip (amber) = today's volume (independent scale, intraday flow).
                            When OI is 0 (pre-market), the whole bar shows volume in orange.
                            Level-centric grid: each row looks up the nearest ETF strike to this
                            row's price level, so the ETF bar always reflects the level you're
                            reading across the row. When multiple grid levels round to the same
                            ETF strike (ETF grid is coarser than the level grid), only the primary
                            level renders the full bar; duplicates show a thin connector so the
                            row stays aligned for cross-row reading without showing identical bars. */}
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
                                    {etfOIWidth > 22 && rowHeight >= 18 && (
                                      <span className="text-[8px] font-mono text-emerald-50 whitespace-nowrap">{formatCompact(etfTotalOI)}</span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                /* OI not yet settled (pre-market 0DTE) — show today's volume in orange */
                                <div className="h-full w-full flex items-center justify-end pr-1.5" style={{ backgroundColor: 'rgba(249,115,22,0.42)' }}>
                                  {etfVolWidth > 22 && rowHeight >= 18 && (
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
                          /* Duplicate ETF strike (same SPY strike as the primary level nearby) —
                              thin gray connector keeps the row aligned for cross-column reading
                              without repeating the identical bar. */
                          <div className="relative flex justify-end w-full pr-1"
                               style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                               title={`ETF ${d.etfStrike} — livello già mostrato sulla riga principale vicina`}>
                            <div className="absolute top-1/2 -translate-y-1/2 right-1 rounded-sm"
                                 style={{ width: '2px', height: '55%', backgroundColor: 'rgba(148,163,184,0.28)' }} />
                          </div>
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
                            F: {d.levelPrice.toFixed(0)} | E: {d.etfPrice.toFixed(1)}
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
                            indexIsPrimary guards against duplicate Index-strike bars (same mechanism as
                            the ETF column, though the Index grid rarely duplicates at default zoom). */}
                        {d.indexIsPrimary ? (
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
                                    {idxOIWidth > 22 && rowHeight >= 18 && (
                                      <span className="text-[8px] font-mono text-emerald-50 whitespace-nowrap">{formatCompact(idxTotalOI)}</span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <div className="h-full w-full flex items-center justify-start pl-1.5" style={{ backgroundColor: 'rgba(249,115,22,0.42)' }}>
                                  {idxVolWidth > 22 && rowHeight >= 18 && (
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
                        ) : (
                          /* Duplicate Index strike — thin gray connector (mirrors the ETF column). */
                          <div className="relative flex justify-start w-full pl-1"
                               style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                               title={`Index ${d.strike.toFixed(0)} — livello già mostrato`}>
                            <div className="absolute top-1/2 -translate-y-1/2 left-1 rounded-sm"
                                 style={{ width: '2px', height: '55%', backgroundColor: 'rgba(148,163,184,0.28)' }} />
                          </div>
                        )}

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
                            {futBarWidth > 18 && rowHeight >= 18 && (
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
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
                  </div>
                ))}
              </div>
            </div>

            {/* Legend Card */}
            <LegendCard isGuideOpen={isGuideOpen} setIsGuideOpen={setIsGuideOpen} />

          </div>
        </div>
      </main>

      {/* ================================================================== */}
      {/* FOOTER                                                             */}
      {/* ================================================================== */}
      <footer className="border-t border-gray-800/50 px-4 py-2 mt-auto">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between text-[10px] text-gray-600">
          <span>Gamma & Volatility Analytics Portal</span>
          {lastRefreshed && (
            <span>Aggiornato il: {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
