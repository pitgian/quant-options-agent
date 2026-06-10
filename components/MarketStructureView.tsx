/**
 * MarketStructureView — Premium volume profile and market structure analysis view.
 *
 * Displays a dual horizontal volume profile (Options Activity vs. Futures Volume),
 * identifies High Volume Nodes (HVNs) and Low Volume Nodes (LVNs), defines
 * Fair Value Areas (FVAs), and provides narrative trading insights.
 *
 * @module components/MarketStructureView
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ExpiryFilter } from '../types';
import { useOptionsData } from '../hooks/useOptionsData';
import { formatCompact, formatStrike, formatGEX, formatTimestamp } from '../utils/formatting';
import { IconRefresh } from './Icons';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

const SYMBOLS = ['SPY', 'QQQ', 'SPX', 'NDX'] as const;

const EXPIRY_OPTIONS: { key: ExpiryFilter; label: string }[] = [
  { key: '0dte', label: '0 DTE' },
  { key: '1-7dte', label: '1-7 DTE' },
  { key: '8-30dte', label: '8-30 DTE' },
  { key: '30+dte', label: '30+ DTE' },
  { key: 'all', label: 'All' },
];

const ZOOM_OPTIONS = [
  { label: '± 1.5%', value: 1.5 },
  { label: '± 3.0%', value: 3.0 },
  { label: '± 5.0%', value: 5.0 },
];

interface MarketStructureViewProps {
  sharedState?: any;
}

export function MarketStructureView({ sharedState }: MarketStructureViewProps) {
  const localState = useOptionsData();
  const state = sharedState || localState;

  const {
    data,
    loading,
    error,
    symbol,
    setSymbol,
    refreshing,
    isBackgroundRefreshing,
    showUpdatedFlash,
    expiryFilter,
    setExpiryFilter,
    handleRefresh,
    lastRefreshed,
  } = state;

  const [zoomPct, setZoomPct] = useState(3.0);
  const [rowHeight, setRowHeight] = useState(20);
  const [flashVisible, setFlashVisible] = useState(false);
  const [selectedFuturesTf, setSelectedFuturesTf] = useState<'auto' | '2d' | '7d' | '30d' | '90d'>('auto');

  useEffect(() => {
    if (showUpdatedFlash) {
      setFlashVisible(true);
      const timer = setTimeout(() => setFlashVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showUpdatedFlash]);

  // ---- Last updated text ----
  const lastUpdatedText = useMemo(() => {
    if (!data?.timestamp) return '';
    return formatTimestamp(data.timestamp);
  }, [data?.timestamp]);

  // ---- Extract and Merge Profile Data ----
  const profileData = useMemo(() => {
    if (!data) return [];

    const spot = data.spot;
    const strikes = data.gexStrikeData.map(d => d.strike).sort((a, b) => a - b);
    if (strikes.length === 0) return [];

    // Map each strike to option metrics and futures volumes
    const rawProfile = strikes.map(strike => {
      const sd = data.gexStrikeData.find(d => d.strike === strike);
      const optionsVolume = sd ? (sd.callOI + sd.putOI + sd.callVolume + sd.putVolume) : 0;

      // Look up in futures volume profile based on selected expiryFilter or manual override
      let futuresVolume = 0;
      if (data.futuresVolumeProfiles) {
        let tf = '30d';
        if (selectedFuturesTf === 'auto') {
          // Map expiryFilter ('0dte' | '1-7dte' | '8-30dte' | '30+dte' | 'all') to timeframe ('2d' | '7d' | '30d' | '90d' | '30d')
          if (expiryFilter === '0dte') tf = '2d';
          else if (expiryFilter === '1-7dte') tf = '7d';
          else if (expiryFilter === '8-30dte') tf = '30d';
          else if (expiryFilter === '30+dte') tf = '90d';
          else if (expiryFilter === 'all') tf = '30d';
        } else {
          tf = selectedFuturesTf;
        }

        const profileForTf = data.futuresVolumeProfiles[tf];
        if (profileForTf) {
          futuresVolume = profileForTf[strike.toString()]
            || profileForTf[strike.toFixed(1)]
            || profileForTf[strike.toFixed(2)]
            || profileForTf[strike.toFixed(0)]
            || 0;
        }
      } else if (data.futuresVolumeProfile) {
        // Fallback to legacy single profile
        const exactVal = data.futuresVolumeProfile[strike.toString()]
          || data.futuresVolumeProfile[strike.toFixed(1)]
          || data.futuresVolumeProfile[strike.toFixed(2)]
          || data.futuresVolumeProfile[strike.toFixed(0)]
          || 0;
        futuresVolume = exactVal;
      }

      const distancePct = ((strike - spot) / spot) * 100;

      return {
        strike,
        optionsVolume,
        futuresVolume,
        distancePct,
      };
    });

    return rawProfile;
  }, [data, expiryFilter, selectedFuturesTf]);

  // ---- Filter profile based on zoom percentage around spot ----
  const zoomedProfile = useMemo(() => {
    return profileData.filter(d => Math.abs(d.distancePct) <= zoomPct);
  }, [profileData, zoomPct]);

  // ---- Node detection (HVN & LVN) ----
  const nodes = useMemo(() => {
    if (zoomedProfile.length === 0) {
      return { hvnStrikes: new Set<number>(), lvnStrikes: new Set<number>(), lvnZones: new Map<number, { low: number; high: number }>() };
    }

    const hasFutures = zoomedProfile.some(d => d.futuresVolume > 0);

    // Median values of target volume for significance filters (computed on raw volumes)
    const targetVolumes = zoomedProfile
      .map(d => hasFutures ? d.futuresVolume : d.optionsVolume)
      .filter(v => v > 0);
    targetVolumes.sort((a, b) => a - b);
    const medianVolume = targetVolumes.length > 0 ? targetVolumes[Math.floor(targetVolumes.length / 2)] : 0;

    const hvnStrikes = new Set<number>();
    const lvnStrikes = new Set<number>();
    const lvnZones = new Map<number, { low: number; high: number }>();

    // Detect local peaks (HVNs) and local troughs (LVNs) using a 5-strike window on RAW volumes
    for (let i = 2; i < zoomedProfile.length - 2; i++) {
      const window = [
        zoomedProfile[i - 2],
        zoomedProfile[i - 1],
        zoomedProfile[i],
        zoomedProfile[i + 1],
        zoomedProfile[i + 2],
      ].map(d => hasFutures ? d.futuresVolume : d.optionsVolume);

      const v_curr = window[2];
      const max_val = Math.max(...window);
      const min_val = Math.min(...window);
      const max_surrounding = Math.max(window[0], window[1], window[3], window[4]);

      // Peak (HVN): must be the absolute maximum in the 5-strike window
      // and must be higher than medianVolume * 1.15
      if (v_curr === max_val && v_curr > medianVolume * 1.15) {
        hvnStrikes.add(zoomedProfile[i].strike);
      }

      // Trough (LVN): deepest valley in the 5-strike neighborhood
      // Must be a deep drop (<= 50% of surrounding peaks), and must be low volume overall (< medianVolume * 0.8)
      // Also ensure there is some non-zero volume surrounding it (max_surrounding > 0) to avoid tagging empty strikes
      if (v_curr === min_val && max_surrounding > 0 && v_curr <= max_surrounding * 0.5 && v_curr < medianVolume * 0.8) {
        lvnStrikes.add(zoomedProfile[i].strike);

        // Expand left to define the transition zone
        let leftIdx = i;
        while (leftIdx > 0) {
          const v_left = hasFutures ? zoomedProfile[leftIdx - 1].futuresVolume : zoomedProfile[leftIdx - 1].optionsVolume;
          if (v_left <= v_curr * 1.5 && v_left < medianVolume * 0.7) {
            leftIdx--;
          } else {
            break;
          }
        }

        // Expand right to define the transition zone
        let rightIdx = i;
        while (rightIdx < zoomedProfile.length - 1) {
          const v_right = hasFutures ? zoomedProfile[rightIdx + 1].futuresVolume : zoomedProfile[rightIdx + 1].optionsVolume;
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
        // Overlap: merge
        last.high = Math.max(last.high, current.high);
      } else {
        merged.push({ ...current });
      }
    }
    return merged;
  }, [nodes.lvnZones]);

  // ---- Value Area / Fair Value Areas (FVAs) Grouping ----
  const fairValueAreas = useMemo(() => {
    if (!data || zoomedProfile.length === 0) return [];

    const strikes = zoomedProfile.map(d => d.strike).sort((a, b) => a - b);
    const spot = data.spot;

    const areas: {
      id: number;
      low: number;
      high: number;
      poc: number;
      maxVolume: number;
      status: 'current' | 'above' | 'below';
    }[] = [];

    // FVA low and high bounds are defined by the spaces between merged LVN zones
    const ranges: { low: number; high: number }[] = [];

    if (mergedZones.length === 0) {
      ranges.push({ low: strikes[0], high: strikes[strikes.length - 1] });
    } else {
      // First range: from min strike to first zone low
      if (strikes[0] < mergedZones[0].low) {
        ranges.push({ low: strikes[0], high: mergedZones[0].low });
      }

      // Middle ranges: from zone[i].high to zone[i+1].low
      for (let i = 0; i < mergedZones.length - 1; i++) {
        const low = mergedZones[i].high;
        const high = mergedZones[i + 1].low;
        if (low < high) {
          ranges.push({ low, high });
        }
      }

      // Last range: from last zone high to max strike
      const lastZone = mergedZones[mergedZones.length - 1];
      if (lastZone.high < strikes[strikes.length - 1]) {
        ranges.push({ low: lastZone.high, high: strikes[strikes.length - 1] });
      }
    }

    // Now populate FVA details for each range
    ranges.forEach((range, idx) => {
      const strikesInArea = zoomedProfile.filter(d => d.strike >= range.low && d.strike <= range.high);
      if (strikesInArea.length === 0) return;

      let poc = strikesInArea[0].strike;
      let maxVol = -1;
      const hasFutures = strikesInArea.some(d => d.futuresVolume > 0);

      for (const d of strikesInArea) {
        const vol = hasFutures ? d.futuresVolume : d.optionsVolume;
        if (vol > maxVol) {
          maxVol = vol;
          poc = d.strike;
        }
      }

      let status: 'current' | 'above' | 'below' = 'above';
      if (spot >= range.low && spot <= range.high) {
        status = 'current';
      } else if (spot < range.low) {
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
  }, [mergedZones, zoomedProfile, data]);

  // ---- Actionable Trading Analysis Card ----
  const analysis = useMemo(() => {
    if (!data || fairValueAreas.length === 0) return null;
    const spot = data.spot;

    // Find if spot is inside a Fair Value Area
    const currentArea = fairValueAreas.find(a => a.status === 'current');

    // Or check if spot is inside an LVN transition zone
    const currentLvnZone = mergedZones.find(z => spot >= z.low && spot <= z.high);

    if (currentLvnZone) {
      return {
        isInsideLvn: true,
        lvnZone: currentLvnZone,
        suggestion: `Il prezzo si trova all'interno di una Zona di Transizione a basso volume ($${currentLvnZone.low.toFixed(0)} - $${currentLvnZone.high.toFixed(0)}). I volumi in questa fascia sono molto scarsi. Questo indica instabilità: il prezzo tende ad attraversare rapidamente quest'area per raggiungere una zona di Fair Value adiacente o subire un netto rigetto verso la zona precedente. Monitorare la forza dei volumi per identificare un breakout confermato.`,
      };
    }

    if (!currentArea) {
      return {
        message: "Il prezzo si trova al di fuori dei nodi ad alto volume rilevati.",
        suggestion: "Monitorare la reazione del prezzo sui confini dell'area di Fair Value più vicina.",
      };
    }

    const distanceToUpper = currentArea.high - spot;
    const distanceToLower = spot - currentArea.low;

    const nearestBoundary = distanceToUpper < distanceToLower
      ? { low: currentArea.high, high: currentArea.high, type: 'Confine Superiore (LVN)', dist: distanceToUpper, pct: (distanceToUpper / spot) * 100 }
      : { low: currentArea.low, high: currentArea.low, type: 'Confine Inferiore (LVN)', dist: distanceToLower, pct: (distanceToLower / spot) * 100 };

    const lvnZone = mergedZones.find(z => z.low === nearestBoundary.low || z.high === nearestBoundary.high);
    const boundaryText = lvnZone
      ? `Zona LVN a $${lvnZone.low.toFixed(0)} - $${lvnZone.high.toFixed(0)}`
      : `$${nearestBoundary.low.toFixed(0)}`;

    let suggestion = "";
    if (nearestBoundary.pct < 0.6) {
      suggestion = `Il prezzo spot è in prossimità del limite critico (${nearestBoundary.type}) definito dalla ${boundaryText} (distanza: ${nearestBoundary.pct.toFixed(2)}%). Un rifiuto dei volumi su questa soglia suggerisce una reazione di rimbalzo (Mean Reversion) verso il POC interno a $${currentArea.poc.toFixed(0)}. Al contrario, una rottura decisa dei volumi (Breakout) indicherà una rapida transizione attraverso la zona di rifiuto verso l'FVA adiacente.`;
    } else {
      suggestion = `Il prezzo si sta muovendo in equilibrio all'interno della zona di Fair Value ($${currentArea.low.toFixed(0)} - $${currentArea.high.toFixed(0)}). Il magnete principale (Point of Control) è a $${currentArea.poc.toFixed(0)}, che agisce come centro di gravità. Le soglie esterne ($${currentArea.low.toFixed(0)} e $${currentArea.high.toFixed(0)}) delimitano le zone LVN di rigetto strutturale.`;
    }

    return {
      currentArea,
      nearestBoundary: lvnZone ? { ...lvnZone, type: nearestBoundary.type, pct: nearestBoundary.pct } : null,
      suggestion,
    };
  }, [fairValueAreas, mergedZones, data]);

  // ---- Max values for bar sizing ----
  const { maxOptionsVolume, maxFuturesVolume } = useMemo(() => {
    let maxOpt = 1;
    let maxFut = 1;
    for (const d of zoomedProfile) {
      if (d.optionsVolume > maxOpt) maxOpt = d.optionsVolume;
      if (d.futuresVolume > maxFut) maxFut = d.futuresVolume;
    }
    return { maxOptionsVolume: maxOpt, maxFuturesVolume: maxFut };
  }, [zoomedProfile]);

  // ---- Cross-Symbol Level mapping for chart visualization ----
  const crossSymbolLevelsMap = useMemo(() => {
    const map = new Map<number, any>();
    if (!data || !data.crossSymbolConfluence) return map;

    const upperSymbol = symbol.toUpperCase();
    const pairKey = (upperSymbol === 'SPY' || upperSymbol === 'SPX') ? 'SPY_SPX' : 'QQQ_NDX';
    const pair = data.crossSymbolConfluence[pairKey as keyof typeof data.crossSymbolConfluence];
    if (!pair) return map;

    for (const level of pair.levels) {
      const etfIsPrimary = level.etf.symbol.toUpperCase() === upperSymbol;
      const indexIsPrimary = level.index.symbol.toUpperCase() === upperSymbol;
      if (!etfIsPrimary && !indexIsPrimary) continue;

      const primary = etfIsPrimary ? level.etf : level.index;
      const paired = etfIsPrimary ? level.index : level.etf;

      // Only include cross-symbol levels with meaningful confluence score
      if (level.cross_score < 60) continue;

      map.set(primary.strike, {
        strike: primary.strike,
        type: level.type,
        crossScore: Math.min(100, Math.round(level.cross_score)),
        pairedSymbol: paired.symbol,
        pairedStrike: paired.strike,
        pairedScore: paired.score,
        pairedWallType: paired.wall_type,
        pairedOI: paired.total_oi,
        pairedVol: paired.total_vol,
        combinedOI: level.combined_oi,
        combinedVol: level.combined_vol,
        combinedActivity: level.combined_activity,
      });
    }
    return map;
  }, [data, symbol]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={handleRefresh} />;
  if (!data) return <ErrorState message="No data available" onRetry={handleRefresh} />;

  const { spot, gexRegime } = data;
  const hasFuturesData = zoomedProfile.some(d => d.futuresVolume > 0);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0d1117' }}>
      {/* ================================================================== */}
      {/* CONTROL HEADER                                                     */}
      {/* ================================================================== */}
      <header className="border-b border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          {/* Symbols */}
          <div className="flex items-center gap-1">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150"
                style={{
                  backgroundColor: symbol === s ? '#1e293b' : 'transparent',
                  color: symbol === s ? '#e2e8f0' : '#64748b',
                  border: symbol === s ? '1px solid #334155' : '1px solid transparent',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3">
            {/* Range Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Range:</span>
              <div className="flex items-center bg-[#1e293b] rounded-lg p-0.5 border border-gray-700">
                {ZOOM_OPTIONS.map((zo) => (
                  <button
                    key={zo.value}
                    onClick={() => setZoomPct(zo.value)}
                    className="px-2 py-1 rounded text-[10px] font-semibold transition-all duration-150"
                    style={{
                      backgroundColor: zoomPct === zo.value ? '#334155' : 'transparent',
                      color: zoomPct === zo.value ? '#e2e8f0' : '#64748b',
                    }}
                  >
                    {zo.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Row Height Spacing Zoom Controls */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Zoom:</span>
              <div className="flex items-center gap-1 bg-[#1e293b] rounded-lg p-1 border border-gray-700">
                {/* Squeeze / Zoom Out (decreases height) */}
                <button
                  onClick={() => setRowHeight(h => Math.max(12, h - 2))}
                  disabled={rowHeight <= 12}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#334155] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                  title="Stringi righe (più livelli visibili)"
                >
                  🔍⁻
                </button>
                
                {/* Slider */}
                <input
                  type="range"
                  min="12"
                  max="36"
                  step="2"
                  value={rowHeight}
                  onChange={(e) => setRowHeight(Number(e.target.value))}
                  className="w-16 sm:w-20 accent-blue-500 cursor-pointer h-1 bg-gray-700 rounded-lg appearance-none"
                  title={`Altezza righe: ${rowHeight}px`}
                />
                
                {/* Expand / Zoom In (increases height) */}
                <button
                  onClick={() => setRowHeight(h => Math.min(36, h + 2))}
                  disabled={rowHeight >= 36}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-[#334155] disabled:opacity-30 disabled:hover:bg-transparent font-bold text-xs"
                  title="Allarga righe (dettaglio)"
                >
                  🔍⁺
                </button>
              </div>
            </div>

            {/* DTE Selector */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Opzioni:</span>
              <select
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
                className="bg-[#1e293b] border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Futures Timeframe Selector */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Futures:</span>
              <select
                value={selectedFuturesTf}
                onChange={(e) => setSelectedFuturesTf(e.target.value as 'auto' | '2d' | '7d' | '30d' | '90d')}
                className="bg-[#1e293b] border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500"
              >
                <option value="auto">Auto (Allineato)</option>
                <option value="2d">2 Giorni (15m)</option>
                <option value="7d">7 Giorni (30m)</option>
                <option value="30d">30 Giorni (1h)</option>
                <option value="90d">90 Giorni (1d)</option>
              </select>
            </div>

            {/* Refresh */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              title={lastUpdatedText ? `Last updated: ${lastUpdatedText}` : 'Refresh'}
            >
              <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdatedText && (
                <span className="text-[11px] text-gray-500">{lastUpdatedText}</span>
              )}
            </button>

            {/* Background refresh status */}
            {isBackgroundRefreshing && (
              <span className="inline-flex items-center gap-1 text-[11px] text-blue-400/80 animate-pulse">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
                Refreshing…
              </span>
            )}

            {/* Success flash */}
            {flashVisible && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 animate-pulse">
                ✓ Aggiornato
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ================================================================== */}
      {/* MAIN CONTENT AREA                                                 */}
      {/* ================================================================== */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
          
          {/* ---- PROFILE CHART CARD ---- */}
          <div className="bg-slate-900/40 border border-gray-800 rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                  📊 Profilo dei Volumi Incrociato
                  {!hasFuturesData && (
                    <span className="text-xs font-normal text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      Fallback Opzioni
                    </span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Distribuzione dell'Open Interest + Volume delle Opzioni (sinistra) e dei Volumi dei Futures (destra).
                </p>
                <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-gray-800/60 text-[11px] text-gray-400">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500/50"></span>
                    <span><strong>Profilo Opzioni:</strong> Posizionamento corrente (Open Interest + Volume Intraday)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500/50"></span>
                    <span>
                      <strong>Profilo Futures:</strong> Storico {
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
                          return tf === '2d' ? '2 Giorni, candele a 15m' :
                                 tf === '7d' ? '7 Giorni, candele a 30m' :
                                 tf === '30d' ? '30 Giorni, candele a 1h' :
                                 tf === '90d' ? '90 Giorni, candele a 1d' :
                                 '30 Giorni, candele a 1h';
                        })()
                      }, indicizzato allo spot)
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Header labels for profiles */}
            <div className="grid grid-cols-[1fr_80px_1fr] gap-2 mb-2 px-2 text-[10px] font-bold tracking-wider text-gray-500 uppercase">
              <span className="text-right">Profilo Opzioni (OI + Vol)</span>
              <span className="text-center">Strike</span>
              <span className="text-left">{hasFuturesData ? 'Profilo Futures (Vol)' : 'Profilo Opzioni (Vol)'}</span>
            </div>

            {/* Chart rows */}
            <div className="flex flex-col gap-0.5">
              {zoomedProfile.slice().reverse().map((d) => {
                const isClosest = Math.abs(d.strike - spot) === Math.min(...zoomedProfile.map(x => Math.abs(x.strike - spot)));
                const isHVN = nodes.hvnStrikes.has(d.strike);
                const lvnZone = mergedZones.find(z => d.strike >= z.low && d.strike <= z.high);
                const isLVN = !!lvnZone;
                const isTrough = nodes.lvnStrikes.has(d.strike);
                const crossLvl = crossSymbolLevelsMap.get(d.strike);

                const optBarWidth = (d.optionsVolume / maxOptionsVolume) * 100;
                const futBarWidth = ((hasFuturesData ? d.futuresVolume : d.optionsVolume) / (hasFuturesData ? maxFuturesVolume : maxOptionsVolume)) * 100;

                return (
                  <div
                    key={d.strike}
                    className="relative grid grid-cols-[1fr_80px_1fr] gap-2 items-center transition-colors duration-150 rounded"
                    style={{
                      height: `${rowHeight}px`,
                      backgroundColor: isClosest
                        ? 'rgba(59,130,246,0.18)'
                        : isHVN
                        ? 'rgba(99,102,241,0.03)'
                        : isLVN
                        ? 'rgba(244,63,94,0.02)'
                        : 'transparent',
                      borderTop: isClosest ? '1px solid rgba(59,130,246,0.45)' : 'none',
                      borderBottom: isClosest ? '1px solid rgba(59,130,246,0.45)' : 'none',
                    }}
                  >
                    {/* Left profile bar: Options Activity */}
                    <div className="flex justify-end w-full pr-1 animate-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
                      <div
                        className="h-full rounded-l flex items-center justify-end pr-2 overflow-hidden"
                        style={{
                          width: `${Math.max(2, optBarWidth)}%`,
                          backgroundColor: isHVN
                            ? 'rgba(99,102,241,0.45)'
                            : isLVN
                            ? 'rgba(244,63,94,0.08)'
                            : 'rgba(59,130,246,0.25)',
                        }}
                      >
                        {optBarWidth > 15 && rowHeight >= 18 && (
                          <span className="text-[9px] font-mono text-blue-200">
                            {formatCompact(d.optionsVolume)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Center Strike Price & Badges */}
                    <div className="flex flex-col items-center justify-center font-mono relative" style={{ height: `${rowHeight}px` }}>
                      <span
                        className={`font-bold transition-colors ${
                          rowHeight < 15 ? 'text-[9px]' :
                          rowHeight < 20 ? 'text-[10px]' :
                          rowHeight < 26 ? 'text-xs' : 'text-sm'
                        }`}
                        style={{
                          color: isClosest ? '#ffffff' : isHVN ? '#818cf8' : isLVN ? '#fb7185' : '#94a3b8',
                          backgroundColor: isClosest ? '#2563eb' : 'transparent',
                          padding: isClosest ? '1px 5px' : '0',
                          borderRadius: isClosest ? '4px' : '0',
                          lineHeight: 1,
                        }}
                      >
                        ${d.strike.toFixed(0)}
                      </span>
                      {isClosest && rowHeight >= 24 && (
                        <span className="absolute -bottom-2.5 text-[7px] text-blue-400 font-bold uppercase tracking-wider bg-[#0d1117] px-1 rounded border border-blue-500/30 z-10">
                          Spot
                        </span>
                      )}
                    </div>

                    {/* Right profile bar: Futures Volume */}
                    <div className="flex justify-start w-full pl-1 relative animate-all duration-300" style={{ height: `${Math.max(4, rowHeight - 4)}px` }}>
                      <div
                        className="h-full rounded-r flex items-center justify-start pl-2 overflow-hidden"
                        style={{
                          width: `${Math.max(2, futBarWidth)}%`,
                          backgroundColor: isHVN
                            ? 'rgba(129,140,248,0.45)'
                            : isLVN
                            ? 'rgba(244,63,94,0.08)'
                            : 'rgba(34,197,94,0.25)',
                          borderLeft: isLVN ? '1px dashed rgba(244,63,94,0.4)' : 'none',
                          borderRight: isLVN ? '1px dashed rgba(244,63,94,0.4)' : 'none',
                        }}
                      >
                        {futBarWidth > 15 && rowHeight >= 18 && (
                          <span className="text-[9px] font-mono text-green-200">
                            {formatCompact(hasFuturesData ? d.futuresVolume : d.optionsVolume)}
                          </span>
                        )}
                      </div>

                      {/* Right-aligned node badges */}
                      {rowHeight >= 16 && (
                        <div 
                          className="absolute right-2 top-0 flex gap-1 items-center"
                          style={{ height: `${Math.max(4, rowHeight - 4)}px` }}
                        >
                          {crossLvl && (
                            <span
                              className="px-1 py-0.5 rounded text-[8px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase flex items-center gap-0.5 cursor-help"
                              title={`Confluenza Cross-Symbol con ${crossLvl.pairedSymbol} a strike $${crossLvl.pairedStrike.toFixed(0)} (Score: ${crossLvl.crossScore})`}
                              style={{ transform: rowHeight < 20 ? 'scale(0.85)' : 'none', transformOrigin: 'right center' }}
                            >
                              🔗 {crossLvl.pairedSymbol} ${crossLvl.pairedStrike.toFixed(0)}
                            </span>
                          )}
                          {isHVN && (
                            <span 
                              className="px-1 py-0.5 rounded text-[8px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 uppercase"
                              style={{ transform: rowHeight < 20 ? 'scale(0.85)' : 'none', transformOrigin: 'right center' }}
                            >
                              HVN
                            </span>
                          )}
                          {isLVN && isTrough && (
                            <span 
                              className="px-1 py-0.5 rounded text-[8px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 uppercase"
                              style={{ transform: rowHeight < 20 ? 'scale(0.85)' : 'none', transformOrigin: 'right center' }}
                            >
                              LVN Zone
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---- INSIGHTS & STRUCTURAL TABLES ---- */}
          <div className="flex flex-col gap-6">
            
            {/* Spot & Regime Card */}
            <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5">
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Spot Price</span>
                  <div className="text-2xl font-mono font-bold text-white">${spot.toFixed(2)}</div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">GEX Regime</span>
                  <div className="mt-1">
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold"
                      style={{
                        backgroundColor: gexRegime.regime === 'positive' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                        color: gexRegime.regime === 'positive' ? '#4ade80' : '#f87171',
                      }}
                    >
                      {gexRegime.regime === 'positive' ? '▲ Positive' : '▼ Negative'}
                    </span>
                  </div>
                </div>
              </div>

              {gexRegime.flipPoint && (
                <div className="border-t border-gray-800 pt-3 flex items-center justify-between text-xs text-gray-400">
                  <span>Soglia Gamma Flip:</span>
                  <span className="font-mono font-bold text-gray-200">${gexRegime.flipPoint.toFixed(0)}</span>
                </div>
              )}
            </div>

            {/* Structural Analysis Card */}
            {analysis && (
              <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5">
                <h3 className="text-sm font-bold text-gray-200 mb-3 flex items-center gap-2">
                  <span>💡</span> Analisi di Struttura
                </h3>
                
                {analysis.currentArea && (
                  <div className="mb-4">
                    <span className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold">Zona Fair Value Attuale:</span>
                    <div className="text-sm text-gray-300 font-medium mt-1">
                      ${analysis.currentArea.low.toFixed(0)} - ${analysis.currentArea.high.toFixed(0)}
                    </div>
                  </div>
                )}

                <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800 text-xs leading-relaxed text-gray-400">
                  {analysis.suggestion}
                </div>

                {analysis.nearestBoundary && (
                  <div className="mt-4 border-t border-gray-850 pt-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                      <span>Confine più vicino:</span>
                      <span className="font-semibold text-rose-400">{analysis.nearestBoundary.type.split(' ')[0]}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                      <span>Prezzo Confine:</span>
                      <span className="font-mono font-bold text-gray-200 text-right">
                        {analysis.nearestBoundary.low === analysis.nearestBoundary.high
                          ? `$${analysis.nearestBoundary.low.toFixed(0)}`
                          : `$${analysis.nearestBoundary.low.toFixed(0)} - $${analysis.nearestBoundary.high.toFixed(0)}`}
                      </span>
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
            <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5">
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

          </div>
        </div>
      </main>

      {/* ================================================================== */}
      {/* FOOTER                                                             */}
      {/* ================================================================== */}
      <footer className="border-t border-gray-800/50 px-4 py-2 mt-auto">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[10px] text-gray-600">
          <span>Market Structure & Volume Profile</span>
          {lastRefreshed && (
            <span>Data dell'ultimo aggiornamento: {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
