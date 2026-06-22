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

const ZOOM_OPTIONS = [
  { label: '± 1.5%', value: 1.5 },
  { label: '± 3.0%', value: 3.0 },
  { label: '± 5.0%', value: 5.0 },
];

export function MarketStructureView({ sharedState }: { sharedState?: any }) {
  const localState = useOptionsData();
  const state = sharedState || localState;

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
  const [selectedFuturesTf, setSelectedFuturesTf] = useState<'auto' | '1d' | '2d' | '5d' | '7d' | '30d' | '90d' | 'max'>('auto');
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

  // ---- Extract and Merge Profile Data ----
  const profileData = useMemo(() => {
    if (!indexData || !etfData) return [];

    const indexSpot = indexData.spot;
    const etfSpot = etfData.spot;
    const ratio = indexSpot / etfSpot;

    const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const futuresSpot = liveSpot[futuresSymbol as keyof typeof liveSpot] || indexSpot;

    // Get all strikes from the Index data and sort them ascending
    const strikes = indexData.gexStrikeData.map(d => d.strike).sort((a, b) => a - b);
    if (strikes.length === 0) return [];

    return strikes.map(strike => {
      // Find corresponding ETF strike
      const etfStrike = Math.round(strike / ratio);

      const indexStrikeData = indexData.gexStrikeData.find(d => d.strike === strike);
      const etfStrikeData = etfData.gexStrikeData.find(d => d.strike === etfStrike);

      // Volume + OI for Index and ETF
      const indexVolume = indexStrikeData ? (indexStrikeData.callOI + indexStrikeData.putOI + indexStrikeData.callVolume + indexStrikeData.putVolume) : 0;
      const etfVolume = etfStrikeData ? (etfStrikeData.callOI + etfStrikeData.putOI + etfStrikeData.callVolume + etfStrikeData.putVolume) : 0;

      // Look up in futures volume profile based on selected timeframe
      let futuresVolume = 0;
      if (indexData.futuresVolumeProfiles) {
        let tf = '30d';
        if (selectedFuturesTf === 'auto') {
          if (expiryFilter === '0dte') tf = '2d';
          else if (expiryFilter === '1-7dte') tf = '7d';
          else if (expiryFilter === '8-30dte') tf = '30d';
          else if (expiryFilter === '30+dte') tf = '90d';
          else if (expiryFilter === 'all') tf = '30d';
        } else {
          tf = selectedFuturesTf;
        }

        const profileForTf = indexData.futuresVolumeProfiles[tf];
        if (profileForTf) {
          futuresVolume = profileForTf[strike.toString()]
            || profileForTf[strike.toFixed(1)]
            || profileForTf[strike.toFixed(2)]
            || profileForTf[strike.toFixed(0)]
            || 0;
        }
      } else if (indexData.futuresVolumeProfile) {
        const exactVal = indexData.futuresVolumeProfile[strike.toString()]
          || indexData.futuresVolumeProfile[strike.toFixed(1)]
          || indexData.futuresVolumeProfile[strike.toFixed(2)]
          || indexData.futuresVolumeProfile[strike.toFixed(0)]
          || 0;
        futuresVolume = exactVal;
      }

      // Compute futures-equivalent strike price
      const futuresStrike = strike * basisMultiplier;

      // Distance should be calculated using the futures-equivalent strike compared to the futures spot price
      const distancePct = ((futuresStrike - futuresSpot) / futuresSpot) * 100;

      return {
        strike,
        etfStrike,
        futuresStrike,
        indexVolume,
        etfVolume,
        futuresVolume,
        distancePct,
      };
    });
  }, [indexData, etfData, expiryFilter, selectedFuturesTf, basisMultiplier, liveSpot, market]);

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
    const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
    const cashSpot = liveSpot[indexSymbol as keyof typeof liveSpot] || indexSpot;

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
      if (cashSpot >= range.low && cashSpot <= range.high) {
        status = 'current';
      } else if (cashSpot < range.low) {
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
    
    const indexSymbol = market === 'SP500' ? 'SPX' : 'NDX';
    const cashSpot = liveSpot[indexSymbol as keyof typeof liveSpot] || indexData.spot;

    const currentArea = fairValueAreas.find(a => a.status === 'current');
    const currentLvnZone = mergedZones.find(z => cashSpot >= z.low && cashSpot <= z.high);

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

    const distanceToUpper = currentArea.high - cashSpot;
    const distanceToLower = cashSpot - currentArea.low;

    const nearestBoundary = distanceToUpper < distanceToLower
      ? { low: currentArea.high, high: currentArea.high, type: 'Confine Superiore (LVN)', dist: distanceToUpper, pct: (distanceToUpper / cashSpot) * 100 }
      : { low: currentArea.low, high: currentArea.low, type: 'Confine Inferiore (LVN)', dist: distanceToLower, pct: (distanceToLower / cashSpot) * 100 };

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
  const { maxEtfVolume, maxIndexVolume, maxFuturesVolume } = useMemo(() => {
    let maxEtf = 1;
    let maxIdx = 1;
    let maxFut = 1;
    for (const d of zoomedProfile) {
      if (d.etfVolume > maxEtf) maxEtf = d.etfVolume;
      if (d.indexVolume > maxIdx) maxIdx = d.indexVolume;
      if (d.futuresVolume > maxFut) maxFut = d.futuresVolume;
    }
    return { maxEtfVolume: maxEtf, maxIndexVolume: maxIdx, maxFuturesVolume: maxFut };
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
      {/* ================================================================== */}
      {/* CONTROL HEADER                                                     */}
      {/* ================================================================== */}
      <header className="border-b border-gray-800 bg-[#161b22]/50 backdrop-blur px-4 py-3 sticky top-0 z-20">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 flex-wrap">
          {/* Market selector (S&P 500 vs Nasdaq 100) */}
          <div className="flex bg-slate-900 rounded-xl p-1 border border-slate-800">
            <button
              onClick={() => setMarket('SP500')}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
              style={{
                backgroundColor: market === 'SP500' ? '#1e293b' : 'transparent',
                color: market === 'SP500' ? '#e2e8f0' : '#64748b',
              }}
            >
              🇺🇸 S&P 500
            </button>
            <button
              onClick={() => setMarket('NASDAQ100')}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
              style={{
                backgroundColor: market === 'NASDAQ100' ? '#1e293b' : 'transparent',
                color: market === 'NASDAQ100' ? '#e2e8f0' : '#64748b',
              }}
            >
              💻 Nasdaq 100
            </button>
          </div>

          {/* Controls & Zooms */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Range selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Range:</span>
              <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800">
                {ZOOM_OPTIONS.map((zo) => (
                  <button
                    key={zo.value}
                    onClick={() => setZoomPct(zo.value)}
                    className="px-2.5 py-1 rounded text-[10px] font-semibold transition-all duration-150"
                    style={{
                      backgroundColor: zoomPct === zo.value ? '#1e293b' : 'transparent',
                      color: zoomPct === zo.value ? '#e2e8f0' : '#64748b',
                    }}
                  >
                    {zo.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Row Height Spacing Control */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Zoom:</span>
              <div className="flex items-center gap-1.5 bg-[#161b22] rounded-lg px-2 py-1 border border-slate-800">
                <button
                  onClick={() => setRowHeight(h => Math.max(14, h - 2))}
                  disabled={rowHeight <= 14}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                  title="Stringi righe (più livelli visibili)"
                >
                  -
                </button>
                <input
                  type="range"
                  min="14"
                  max="36"
                  step="2"
                  value={rowHeight}
                  onChange={(e) => setRowHeight(Number(e.target.value))}
                  className="w-16 accent-blue-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
                  title={`Altezza righe: ${rowHeight}px`}
                />
                <button
                  onClick={() => setRowHeight(h => Math.min(36, h + 2))}
                  disabled={rowHeight >= 36}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#1e293b] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                  title="Allarga righe (maggior dettaglio)"
                >
                  +
                </button>
              </div>
            </div>

            {/* Expiry filter */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Scadenza:</span>
              <select
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
                className="bg-slate-900 border border-slate-850 text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Futures Timeframe selector */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Futures:</span>
              <select
                value={selectedFuturesTf}
                onChange={(e) => setSelectedFuturesTf(e.target.value as 'auto' | '1d' | '2d' | '5d' | '7d' | '30d' | '90d' | 'max')}
                className="bg-slate-900 border border-slate-850 text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                <option value="auto">Auto (Allineato)</option>
                <option value="1d">Giornaliero (5m)</option>
                <option value="5d">Settimanale (15m)</option>
                <option value="30d">Mensile (1h)</option>
                <option value="90d">Trimestrale (1d)</option>
                <option value="max">Cumulativo (Max)</option>
              </select>
            </div>

            {/* Kronos AI Timeframe selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Kronos:</span>
              <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800">
                {KRONOS_TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.key}
                    onClick={() => setKronosTimeframe(tf.key)}
                    className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all duration-150"
                    style={{
                      backgroundColor: kronosTimeframe === tf.key ? '#1e293b' : 'transparent',
                      color: kronosTimeframe === tf.key ? '#e2e8f0' : '#64748b',
                    }}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Refresh */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              title={timeSinceUpdate ? `Aggiornato: ${timeSinceUpdate}` : 'Aggiorna'}
            >
              <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {timeSinceUpdate && (
                <span className="text-[11px] text-gray-500">{timeSinceUpdate}</span>
              )}
            </button>

            {/* Background refresh status */}
            {isBackgroundRefreshing && (
              <span className="inline-flex items-center gap-1 text-[11px] text-blue-400/80 animate-pulse">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
                Aggiornamento in corso…
              </span>
            )}

            {/* Success flash */}
            {flashVisible && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 animate-pulse">
                ✓ Dati aggiornati
              </span>
            )}
          </div>
        </div>
      </header>

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
                        <div className="flex justify-between w-full text-[7px] text-gray-500 px-1 mt-1 font-mono">
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
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500/40"></span>
                    <span><strong>Opzioni ETF:</strong> {etfData.symbol} OI+Vol</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500/40"></span>
                    <span><strong>Opzioni Indice:</strong> {indexData.symbol} OI+Vol</span>
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
                  <span className="text-center">Strike (F | E)</span>
                  <span className="text-left">Opzioni Indice (OI+Vol)</span>
                  <span className="text-left">{hasFuturesData ? 'Volumi Futures' : 'Opzioni Indice (Vol)'}</span>
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
                      ? Math.abs(d.strike - flipPoint) === Math.min(...zoomedProfile.map(x => Math.abs(x.strike - flipPoint)))
                      : false;

                    const etfBarWidth = (d.etfVolume / maxEtfVolume) * 100;
                    const indexBarWidth = (d.indexVolume / maxIndexVolume) * 100;
                    const futBarWidth = ((hasFuturesData ? d.futuresVolume : d.indexVolume) / (hasFuturesData ? maxFuturesVolume : maxIndexVolume)) * 100;

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
                        {/* Floating Labels at the absolute left of the row to prevent strike price overlap */}
                        {isFlipRow && rowHeight >= 18 && (
                          <span className="absolute left-2 top-1/2 transform -translate-y-1/2 text-[6.5px] font-extrabold uppercase tracking-wider bg-orange-600/95 text-white px-1.5 py-0.5 rounded border border-orange-500/40 whitespace-nowrap z-30 shadow-md">
                            ⚡ GEX Flip: ${(indexData.gexRegime.flipPoint * basisMultiplier).toFixed(0)}
                          </span>
                        )}
                        {kronosBoundaries && d.strike === kronosBoundaries.max && rowHeight >= 18 && (
                          <span className="absolute left-2 -top-2.5 text-[6.5px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos High: ${kronosRange.high.toFixed(0)}
                          </span>
                        )}
                        {kronosBoundaries && d.strike === kronosBoundaries.min && rowHeight >= 18 && (
                          <span className="absolute left-2 -bottom-2.5 text-[6.5px] font-extrabold uppercase tracking-wider bg-blue-600 text-white px-1.5 py-0.5 rounded border border-blue-400 whitespace-nowrap z-25 shadow-md">
                            🎯 Kronos Low: ${kronosRange.low.toFixed(0)}
                          </span>
                        )}

                        {/* Column 1: ETF Options profile (oriented right, aligns to center) */}
                        <div className="flex justify-end w-full pr-1 animate-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
                          <div
                            className="h-full rounded-l flex items-center justify-end pr-1.5 overflow-hidden"
                            style={{
                              width: `${Math.max(2, etfBarWidth)}%`,
                              backgroundColor: isInKronosRange
                                ? (isHVN ? 'rgba(99,102,241,0.55)' : isLVN ? 'rgba(244,63,94,0.15)' : 'rgba(59,130,246,0.45)')
                                : (isHVN ? 'rgba(99,102,241,0.35)' : isLVN ? 'rgba(244,63,94,0.06)' : 'rgba(59,130,246,0.22)'),
                            }}
                          >
                            {etfBarWidth > 18 && rowHeight >= 18 && (
                              <span className="text-[8px] font-mono text-blue-200">
                                {formatCompact(d.etfVolume)}
                              </span>
                            )}
                          </div>
                        </div>

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
                            F: {d.futuresStrike.toFixed(0)} | E: {d.etfStrike.toFixed(0)}
                          </span>
                          {isClosest && rowHeight >= 18 && (
                            <span className="absolute -bottom-3 text-[6.5px] text-yellow-400 font-extrabold uppercase tracking-wider bg-[#0d1117]/95 px-1.5 py-0.5 rounded border border-yellow-500/40 z-35 shadow-md whitespace-nowrap">
                              Spot: F: {(() => {
                                const fs = market === 'SP500' ? 'ES' : 'NQ';
                                return (liveSpot[fs as keyof typeof liveSpot] || indexSpot).toFixed(1);
                              })()} | E: {etfCashSpot.toFixed(2)}
                            </span>
                          )}
                        </div>

                        {/* Column 4: Index Options profile (oriented left) */}
                        <div className="flex justify-start w-full pl-1 animate-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
                          <div
                            className="h-full rounded-r flex items-center justify-start pl-1.5 overflow-hidden"
                            style={{
                              width: `${Math.max(2, indexBarWidth)}%`,
                              backgroundColor: isInKronosRange
                                ? (isHVN ? 'rgba(99,102,241,0.55)' : isLVN ? 'rgba(244,63,94,0.15)' : 'rgba(129,140,248,0.45)')
                                : (isHVN ? 'rgba(99,102,241,0.35)' : isLVN ? 'rgba(244,63,94,0.06)' : 'rgba(129,140,248,0.22)'),
                            }}
                          >
                            {indexBarWidth > 18 && rowHeight >= 18 && (
                              <span className="text-[8px] font-mono text-indigo-200">
                                {formatCompact(d.indexVolume)}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Column 5: Futures Volume profile (oriented left) */}
                        <div className="flex justify-start w-full pl-1 relative animate-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
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
                              {isHVN && (
                                <span 
                                  className="px-1 py-0.5 rounded text-[7px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 uppercase"
                                  style={{ transform: `scale(${rowHeight < 20 ? 0.75 : 0.9})`, transformOrigin: 'right center' }}
                                >
                                  HVN
                                </span>
                              )}
                              {isLVN && isTrough && (
                                <span 
                                  className="px-1 py-0.5 rounded text-[7px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 uppercase"
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
            {analysis && (
              <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5 h-full">
                <h3 className="text-sm font-bold text-gray-200 mb-3 flex items-center gap-2">
                  <span>💡</span> Analisi di Struttura
                </h3>
                {analysis.currentArea && (
                  <div className="mb-3">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Zona Fair Value Attuale:</span>
                    <div className="text-sm text-gray-300 font-medium mt-0.5">
                      ${analysis.currentArea.low.toFixed(0)} - ${analysis.currentArea.high.toFixed(0)}
                    </div>
                  </div>
                )}
                <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800 text-xs leading-relaxed text-gray-400">
                  {analysis.suggestion}
                </div>
                {analysis.nearestBoundary && (
                  <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                      <span>Confine più vicino:</span>
                      <span className="font-semibold text-rose-400">{analysis.nearestBoundary.type.split(' ')[0]}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                      <span>Distanza dallo Spot:</span>
                      <span className="font-mono font-bold text-amber-500">
                        {analysis.nearestBoundary.pct > 0 ? '+' : ''}{analysis.nearestBoundary.pct.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

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
            <div className="bg-[#161b22] border border-gray-800 rounded-2xl overflow-hidden transition-all duration-300 h-full flex flex-col">
              <button
                onClick={() => setIsGuideOpen(!isGuideOpen)}
                className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-800/20 transition-colors shrink-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-amber-400 text-sm">💡</span>
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-300">Guida Operativa & Legenda</span>
                </div>
                <span className={`text-xs text-gray-500 transition-transform duration-300 ${isGuideOpen ? 'rotate-180' : ''}`}>
                  ▼
                </span>
              </button>
              
              <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2 border-t border-slate-800/50 text-xs text-gray-400 space-y-4">
                {isGuideOpen ? (
                  <>
                    <div className="border-b border-slate-850 pb-3">
                      <h4 className="font-bold text-indigo-400 mb-1 uppercase tracking-wide">🎯 WORKFLOW OPERATIVO (Vantaggio Statistico)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-300 mb-2">
                        <strong>1. Analisi del Regime (GEX):</strong> Sopra il GEX Flip (Positive Gamma) prevale stabilità e compressione di volatilità. Sotto il GEX Flip (Negative Gamma) si attivano espansioni repentine e trend direzionali accelerati dai Market Maker.
                      </p>
                      <p className="leading-relaxed text-[11px] text-gray-300 mb-2">
                        <strong>2. Nodi Volumetrici:</strong> Il POC (Point of Control) e gli HVN agiscono come magneti del prezzo (aree ad alto volume). Gli LVN (Low Volume Nodes) indicano vuoti di liquidità: fungono da barriere reattive o zone di accelerazione rapida.
                      </p>
                      <p className="leading-relaxed text-[11px] text-gray-300">
                        <strong>3. Confluenza & Esecuzione:</strong> Cerca ingressi ad alta probabilità (Mean Reversion) quando il prezzo tocca gli estremi del <em>Range Kronos AI</em> in concomitanza con barriere opzioni rilevanti (Call/Put Wall) o POC/HVN, preferibilmente in regime di Gamma Positivo.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-amber-500 mb-0.5">⚡ GEX Flip Point</h4>
                      <p className="leading-relaxed text-[11px] text-gray-450">
                        Livello critico che separa il regime a volatilità controllata (positivo, sopra il flip) dal regime a volatilità esplosiva (negativo, sotto il flip). Guida la scelta tra strategie di rimbalzo o di breakout.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-amber-500 mb-0.5">POC Magnete (Point of Control)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Prezzo con la massima concentrazione di contratti futures/opzioni scambiati. Funge da baricentro o prezzo di equilibrio verso cui il mercato tende naturalmente a ritornare.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-blue-400 mb-0.5">VAL / VAH (Value Area Boundaries)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Limiti inferiore (VAL) e superiore (VAH) del 70% dei volumi scambiati. Uscite decise da questo range segnalano squilibri e l'avvio di forti impulsi direzionali.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-purple-400 mb-0.5">HVN (High Volume Node)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Nodi ad alto volume. Rappresentano supporti e resistenze statiche orizzontali solide dove il prezzo tende a rallentare e consolidare in range.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-rose-400 mb-0.5">LVN Zone (Low Volume Node)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Zone a basso volume scambiato. Essendo vuoti di liquidità, il prezzo tende a rimbalzarvi contro violentemente o ad attraversarle con estrema rapidità.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-blue-400 mb-0.5">🤖 Range Atteso Kronos AI</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Area sfumata blu racchiusa da parentesi sul grafico. Indica i limiti statistici di oscillazione previsti dall'IA per il timeframe attivo. Ottimo da usare in confluenza con le barriere opzioni.
                      </p>
                    </div>

                    <div>
                      <h4 className="font-bold text-slate-350 mb-0.5">📊 Triplo Allineamento Strike (F | C | E)</h4>
                      <p className="leading-relaxed text-[11px] text-gray-455">
                        Al centro del grafico sono visualizzati tre prezzi per ogni riga di strike:
                        <br />
                        • <strong>F (Futures)</strong>: Il livello di prezzo equivalente sul contratto futures (ES / NQ) rettificato per la base attuale.
                        <br />
                        • <strong>C (Cash Index)</strong>: Lo strike effettivo delle opzioni sull'indice cash (SPX / NDX).
                        <br />
                        • <strong>E (ETF)</strong>: Lo strike effettivo delle opzioni sull'ETF corrispondente (SPY / QQQ).
                        <br />
                        Questo consente di individuare all'istante le confluenze volumetriche e delle opzioni direttamente sul prezzo dei futures che scambi.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="text-gray-500 italic flex items-center justify-center h-24">
                    Clicca su "Guida Operativa & Legenda" per visualizzare le spiegazioni.
                  </div>
                )}
              </div>
            </div>

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
