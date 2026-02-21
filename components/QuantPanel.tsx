
import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { AnalysisLevel, DailyOutlook, MarketDataset } from '../types';
import { IconAnalyze, IconLoader, IconUpload } from './Icons';
import { PythonBridge } from './PythonBridge';
import {
  fetchOptionsData,
  fetchFromBackend,
  convertToDatasets,
  getTimeSinceUpdate,
  clearCache,
  clearBackendCache,
  getCacheStatus
} from '../services/dataService';

// Supported symbols for the dropdown
const SUPPORTED_SYMBOLS = [
  { value: 'SPY', label: 'SPY', description: 'S&P 500 ETF' },
  { value: 'QQQ', label: 'QQQ', description: 'Nasdaq 100 ETF' },
  { value: 'SPX', label: 'SPX', description: 'S&P 500 Index' },
  { value: 'NDX', label: 'NDX', description: 'Nasdaq 100 Index' },
] as const;

type SymbolType = typeof SUPPORTED_SYMBOLS[number]['value'];

interface QuantPanelProps {
  datasets: MarketDataset[];
  addDataset: (d: MarketDataset) => void;
  removeDataset: (id: string) => void;
  currentPrice: string;
  setCurrentPrice: (price: string) => void;
  handleAnalysis: () => void;
  onReset: () => void;
  isLoading: boolean;
  error: string | null;
  analysisResult: AnalysisLevel[] | null;
  dailyOutlook: DailyOutlook | null;
  onLevelClick: (level: AnalysisLevel) => void;
}

// Auto-fetch icon component
const IconAutoFetch: React.FC = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const LevelRow: React.FC<{ 
  level: AnalysisLevel; 
  onClick: () => void; 
  spot: number;
}> = ({ level, onClick, spot }) => {
    const distancePct = spot > 0 ? ((level.prezzo - spot) / spot) * 100 : 0;
    const isVeryClose = Math.abs(distancePct) <= 0.6; // Entro lo 0.6% è considerato critico

    const isResonance = 
        level.ruolo === 'CONFLUENCE' || 
        level.lato === 'BOTH' || 
        level.scadenzaTipo?.toUpperCase().includes('MULTI') ||
        level.scadenzaTipo?.toUpperCase().includes('ALL') ||
        level.importanza >= 96;

    const getTheme = () => {
        if (isResonance) return {
            border: 'border-amber-500/60',
            bg: 'bg-amber-500/10',
            label: 'bg-amber-500 text-black font-black',
            price: 'text-amber-400',
            icon: '💎',
            bar: 'from-amber-600 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.5)]',
            pulse: 'animate-pulse'
        };
        if (level.lato === 'GAMMA_FLIP') return {
            border: 'border-indigo-500/40',
            bg: 'bg-indigo-950/20',
            label: 'bg-indigo-600 text-white',
            price: 'text-indigo-300',
            icon: '⚖️',
            bar: 'from-indigo-600 to-blue-400',
            pulse: ''
        };
        if (level.lato === 'CALL') return {
            border: 'border-red-900/30',
            bg: 'bg-red-900/5',
            label: 'bg-red-500/10 text-red-400 border border-red-500/20',
            price: 'text-red-400',
            icon: '🛡️',
            bar: 'from-red-600 to-orange-500',
            pulse: ''
        };
        if (level.lato === 'PUT') return {
            border: 'border-green-900/30',
            bg: 'bg-green-900/5',
            label: 'bg-green-500/10 text-green-400 border border-green-500/20',
            price: 'text-green-400',
            icon: '🛡️',
            bar: 'from-green-600 to-emerald-400',
            pulse: ''
        };
        return {
            border: 'border-gray-800',
            bg: 'bg-gray-800/10',
            label: 'bg-gray-700 text-gray-300',
            price: 'text-gray-300',
            icon: '📍',
            bar: 'from-gray-600 to-gray-400',
            pulse: ''
        };
    };

    const t = getTheme();

    return (
        <div 
            onClick={onClick} 
            className={`group relative p-4 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-6 
            ${t.bg} ${t.border} ${level.isDayTrade ? 'ring-1 ring-white/10' : ''} hover:scale-[1.01] hover:border-white/20`}
        >
            <div className="flex-grow min-w-0">
                <div className="flex items-center gap-3 mb-2">
                    <span className={`text-[10px] font-black uppercase tracking-tight px-2.5 py-0.5 rounded shadow-sm ${t.label} ${t.pulse}`}>
                        {t.icon} {isResonance ? 'RESONANCE' : level.livello}
                    </span>
                    <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">
                        {level.lato} • {level.scadenzaTipo}
                    </span>
                    {isVeryClose && (
                        <span className="text-[8px] font-black text-white bg-indigo-600 px-2 py-0.5 rounded animate-pulse border border-indigo-400">PROXIMATE</span>
                    )}
                </div>
                
                <div className="flex items-start gap-2 mb-1.5">
                    <div className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isVeryClose ? 'bg-indigo-400 animate-ping' : 'bg-gray-600'}`} />
                    <h4 className="text-[14px] font-black text-white uppercase tracking-tight leading-tight">
                        {level.sintesiOperativa}
                    </h4>
                </div>

                <p className={`text-[12px] font-medium leading-tight truncate mb-3 italic ${isResonance || level.lato === 'GAMMA_FLIP' ? 'text-gray-400' : 'text-gray-500'}`}>
                    {level.motivazione}
                </p>

                <div className="flex items-center gap-3">
                    <div className="flex-grow h-2 bg-black/60 rounded-full border border-white/5 overflow-hidden">
                        <div 
                            className={`h-full bg-gradient-to-r transition-all duration-1000 ease-out ${t.bar}`} 
                            style={{ width: `${level.importanza}%` }}
                        ></div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                        <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest">Power</span>
                        <span className={`text-[11px] font-black font-mono ${isResonance ? 'text-amber-400' : 'text-white'}`}>
                            {level.importanza}%
                        </span>
                    </div>
                </div>
            </div>

            <div className="text-right shrink-0">
                <div className="flex flex-col items-end">
                    <span className={`text-2xl font-black font-mono tracking-tighter ${t.price}`}>
                        {level.prezzo.toFixed(2)}
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`text-[11px] font-black font-mono ${distancePct > 0 ? 'text-red-500' : 'text-green-500'}`}>
                            {distancePct > 0 ? '+' : ''}{distancePct.toFixed(2)}%
                        </span>
                        <span className="text-[8px] font-bold text-gray-600 uppercase tracking-widest">DIST</span>
                    </div>
                    <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mt-1">Strike Price</span>
                </div>
            </div>
        </div>
    );
};

export const QuantPanel: React.FC<QuantPanelProps> = ({
  datasets,
  addDataset,
  removeDataset,
  currentPrice,
  setCurrentPrice,
  handleAnalysis,
  onReset,
  isLoading,
  analysisResult,
  dailyOutlook,
  onLevelClick,
}) => {
    const spot = parseFloat(currentPrice) || 0;
    const fileRef = useRef<HTMLInputElement>(null);
    
    // Auto-fetch state
    const [isAutoFetching, setIsAutoFetching] = useState(false);
    const [autoFetchError, setAutoFetchError] = useState<string | null>(null);
    const [lastUpdateTime, setLastUpdateTime] = useState<string | null>(null);
    const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
    const [fromCache, setFromCache] = useState(false);
    
    // Symbol selection and spot price editing
    const [selectedSymbol, setSelectedSymbol] = useState<SymbolType>('SPY');
    const [originalSpotPrice, setOriginalSpotPrice] = useState<number | null>(null);
    const [isEditingSpot, setIsEditingSpot] = useState(false);

    const { aboveSpot, belowSpot } = useMemo(() => {
        if (!analysisResult) return { aboveSpot: [], belowSpot: [] };
        const sorted = [...analysisResult].sort((a, b) => b.prezzo - a.prezzo);
        return {
            aboveSpot: sorted.filter(l => l.prezzo > spot),
            belowSpot: sorted.filter(l => l.prezzo <= spot)
        };
    }, [analysisResult, spot]);

    // Check cache status on mount
    useEffect(() => {
      const cacheStatus = getCacheStatus();
      if (cacheStatus.cached && cacheStatus.expiresAt) {
        // Estimate last update time from cache
        const estimatedTime = new Date(cacheStatus.expiresAt - 5 * 60 * 1000);
        setLastUpdateTime(estimatedTime.toISOString());
        setFromCache(true);
      }
    }, []);

    // Auto-refresh effect
    useEffect(() => {
      if (!autoRefreshEnabled) return;
      
      const intervalId = setInterval(() => {
        handleAutoFetch(true);
      }, 5 * 60 * 1000); // Refresh every 5 minutes
      
      return () => clearInterval(intervalId);
    }, [autoRefreshEnabled]);

    // Handle auto-fetch from backend
    const handleAutoFetch = useCallback(async (forceRefresh: boolean = false) => {
      setIsAutoFetching(true);
      setAutoFetchError(null);
      
      try {
        // Try backend first
        const result = await fetchFromBackend(selectedSymbol, forceRefresh);
        
        if (!result.success || !result.data) {
          // Fallback to static file if backend is not available
          if (result.error?.includes('Backend non disponibile')) {
            console.log('Backend not available, falling back to static file...');
            const fallbackResult = await fetchOptionsData(forceRefresh);
            
            if (!fallbackResult.success || !fallbackResult.data) {
              setAutoFetchError(fallbackResult.error || 'Errore nel caricamento dei dati');
              setIsAutoFetching(false);
              return;
            }
            
            setFromCache(fallbackResult.fromCache || false);
            const { datasets: newDatasets, extractedSpotPrice } = convertToDatasets(fallbackResult.data);
            
            if (extractedSpotPrice) {
              setOriginalSpotPrice(extractedSpotPrice);
              if (!currentPrice) {
                setCurrentPrice(extractedSpotPrice.toString());
              }
            }
            
            newDatasets.forEach(dataset => {
              addDataset(dataset);
            });
            
            if (fallbackResult.data.metadata?.timestamp) {
              setLastUpdateTime(fallbackResult.data.metadata.timestamp);
            } else if (fallbackResult.data.generated) {
              setLastUpdateTime(fallbackResult.data.generated);
            } else {
              setLastUpdateTime(new Date().toISOString());
            }
            
            setAutoFetchError(null);
            setIsAutoFetching(false);
            return;
          }
          
          setAutoFetchError(result.error || 'Errore nel caricamento dei dati');
          setIsAutoFetching(false);
          return;
        }
        
        setFromCache(result.fromCache || false);
        
        // Convert to datasets
        const { datasets: newDatasets, extractedSpotPrice } = convertToDatasets(result.data);
        
        // Update spot price if extracted
        if (extractedSpotPrice) {
          setOriginalSpotPrice(extractedSpotPrice);
          setCurrentPrice(extractedSpotPrice.toString());
        }
        
        // Add datasets
        newDatasets.forEach(dataset => {
          addDataset(dataset);
        });
        
        // Update last update time
        if (result.data.metadata?.timestamp) {
          setLastUpdateTime(result.data.metadata.timestamp);
        } else if (result.data.generated) {
          setLastUpdateTime(result.data.generated);
        } else {
          setLastUpdateTime(new Date().toISOString());
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Errore sconosciuto';
        setAutoFetchError(errorMessage);
      } finally {
        setIsAutoFetching(false);
      }
    }, [currentPrice, setCurrentPrice, addDataset, selectedSymbol]);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const text = (ev.target?.result as string).trim();
                const sM = text.match(/SPOT[:\s|]+(\d+\.?\d*)/i);
                if (sM?.[1]) setCurrentPrice(sM[1]);

                if (text.includes('=== START_EXPIRY:')) {
                    const sections = text.split('=== START_EXPIRY:');
                    sections.forEach(section => {
                        if (!section.trim() || !section.includes('=== END_EXPIRY:')) return;
                        const headerLine = section.split('\n')[0];
                        const expiryLabel = headerLine.split('|')[0].trim() as any;
                        const dateMatch = headerLine.match(/DATE:\s*([\d-]+)/);
                        const date = dateMatch ? dateMatch[1] : expiryLabel;
                        const content = section.split('=== END_EXPIRY:')[0].split('\n').slice(1).join('\n').trim();
                        addDataset({
                            id: Math.random().toString(36).substr(2, 9),
                            name: `${expiryLabel} (${date})`,
                            content: content,
                            type: expiryLabel.includes('0DTE') ? '0DTE' : 
                                  expiryLabel.includes('WEEKLY') ? 'WEEKLY' : 
                                  expiryLabel.includes('MONTHLY') ? 'MONTHLY' : 'OTHER'
                        });
                    });
                } else {
                    let type: '0DTE' | 'WEEKLY' | 'MONTHLY' | 'OTHER' = 'OTHER';
                    if (file.name.toLowerCase().includes('0dte')) type = '0DTE';
                    else if (file.name.toLowerCase().includes('monthly')) type = 'MONTHLY';
                    addDataset({
                        id: Math.random().toString(36).substr(2, 9),
                        name: file.name,
                        content: text,
                        type
                    });
                }
                e.target.value = '';
            };
            reader.readAsText(file);
        }
    };

    return (
    <div className="bg-[#08080a] p-6 rounded-3xl shadow-2xl flex flex-col h-full border border-gray-800/40 backdrop-blur-3xl">
      <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-black text-white uppercase tracking-tighter">RESONANCE ENGINE</h2>
            <p className="text-[10px] text-green-500 font-bold uppercase tracking-widest opacity-80">Smart Sweep Active</p>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdateTime && (
              <span className="text-[9px] text-gray-500 font-medium">
                Ultimo agg: {getTimeSinceUpdate(lastUpdateTime)}
                {fromCache && ' (cache)'}
              </span>
            )}
            <button onClick={onReset} className="text-[10px] text-gray-600 hover:text-white uppercase font-bold px-3 py-2 border border-gray-800 rounded-lg transition-colors">RESET ALL</button>
          </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        {/* Symbol Dropdown */}
        <div className="bg-black/60 p-3 rounded-xl border border-gray-800/50 flex flex-col justify-center">
            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">SIMBOLO</label>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value as SymbolType)}
              className="w-full bg-transparent text-xl text-white font-mono font-bold outline-none cursor-pointer appearance-none"
            >
              {SUPPORTED_SYMBOLS.map((sym) => (
                <option key={sym.value} value={sym.value} className="bg-gray-900 text-white">
                  {sym.label}
                </option>
              ))}
            </select>
        </div>
        
        {/* Spot Price - Editable */}
        <div className="bg-black/60 p-3 rounded-xl border border-gray-800/50 flex flex-col justify-center relative">
            <div className="flex items-center justify-between">
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">LIVE SPOT</label>
              {originalSpotPrice && originalSpotPrice !== parseFloat(currentPrice) && (
                <button
                  onClick={() => setCurrentPrice(originalSpotPrice.toString())}
                  className="text-[8px] text-indigo-400 hover:text-indigo-300 underline"
                  title={`Ripristina: ${originalSpotPrice}`}
                >
                  Reset
                </button>
              )}
            </div>
            <input
              type="text"
              value={currentPrice}
              onChange={(e) => setCurrentPrice(e.target.value)}
              className={`w-full bg-transparent text-xl font-mono font-bold outline-none ${
                originalSpotPrice && originalSpotPrice !== parseFloat(currentPrice)
                  ? 'text-amber-400'
                  : 'text-white'
              }`}
              placeholder="0.00"
            />
            {originalSpotPrice && originalSpotPrice !== parseFloat(currentPrice) && (
              <span className="text-[8px] text-gray-500 mt-0.5">Originale: {originalSpotPrice.toFixed(2)}</span>
            )}
        </div>
        
        <div className="md:col-span-3 flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
            {/* Auto Fetch Button */}
            <button
                onClick={() => handleAutoFetch(false)}
                disabled={isAutoFetching}
                className={`shrink-0 w-32 flex flex-col items-center justify-center p-3 rounded-xl border transition-all text-gray-500
                  ${isAutoFetching
                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400'
                    : 'border-dashed border-gray-700 hover:border-green-500 hover:bg-green-500/5 hover:text-green-400'
                  }`}
            >
                {isAutoFetching ? (
                  <>
                    <IconLoader />
                    <span className="text-[9px] font-bold uppercase mt-1">Caricamento...</span>
                  </>
                ) : (
                  <>
                    <IconAutoFetch />
                    <span className="text-[9px] font-bold uppercase mt-1">Auto Fetch</span>
                    <span className="text-[8px] text-gray-600 font-medium">{selectedSymbol}</span>
                  </>
                )}
            </button>
            
            {/* Manual Upload Button */}
            <button 
                onClick={() => fileRef.current?.click()}
                className="shrink-0 w-32 flex flex-col items-center justify-center p-3 rounded-xl border border-dashed border-gray-700 hover:border-indigo-500 hover:bg-indigo-500/5 transition-all text-gray-500 hover:text-indigo-400"
            >
                <IconUpload />
                <span className="text-[9px] font-bold uppercase mt-1">Carica Sweep</span>
                <input type="file" ref={fileRef} onChange={handleFile} className="hidden" accept=".txt" />
            </button>
            
            {datasets.map(d => (
                <div key={d.id} className="shrink-0 w-40 p-3 rounded-xl bg-gray-800/20 border border-gray-700/50 relative group">
                    <button onClick={() => removeDataset(d.id)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-[8px] font-bold opacity-0 group-hover:opacity-100 transition-opacity">X</button>
                    <span className="text-[8px] font-black text-indigo-400 uppercase block">{d.type}</span>
                    <span className="text-[10px] font-bold text-gray-300 truncate block">{d.name}</span>
                </div>
            ))}
        </div>
      </div>

      {/* Auto-refresh toggle and error display */}
      <div className="flex items-center justify-between mb-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefreshEnabled}
            onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-gray-900"
          />
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
            Aggiorna automaticamente (5 min)
          </span>
        </label>
        
        {autoFetchError && (
          <div className="flex items-center gap-2 text-red-400">
            <span className="text-[10px] font-medium">⚠️ {autoFetchError}</span>
            <button
              onClick={() => {
                clearBackendCache(selectedSymbol);
                clearCache();
                handleAutoFetch(true);
              }}
              className="text-[9px] text-red-400 hover:text-red-300 underline"
            >
              Riprova
            </button>
          </div>
        )}
      </div>

      <PythonBridge />

      <button 
        onClick={handleAnalysis} 
        disabled={isLoading || datasets.length === 0 || !currentPrice} 
        className="mt-6 w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-4 rounded-xl shadow-lg transition-all disabled:opacity-20 uppercase tracking-[0.2em] text-sm flex items-center justify-center gap-2"
      >
        {isLoading ? <><IconLoader /> SCANSIONE RISONANZA...</> : <><IconAnalyze /> ANALIZZA TUTTE LE SCADENZE</>}
      </button>

      {analysisResult && dailyOutlook && (
        <div className="mt-8 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
                <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">SENTIMENT</span>
                <span className={`text-lg font-black uppercase ${dailyOutlook.sentiment.toLowerCase().includes('bull') ? 'text-green-400' : 'text-red-400'}`}>{dailyOutlook.sentiment}</span>
            </div>
            <div className="bg-gray-800/20 p-4 rounded-xl border border-gray-700/30 text-center">
                <span className="text-[9px] font-bold text-gray-500 uppercase block mb-1 tracking-widest">GAMMA FLIP CLUSTER</span>
                <span className="text-lg font-black text-indigo-400 uppercase">{dailyOutlook.gammaFlipZone}</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
                {aboveSpot.map((l, i) => (
                    <LevelRow key={`above-${i}`} level={l} onClick={() => onLevelClick(l)} spot={spot} />
                ))}
                <div className="py-6 flex items-center gap-6">
                    <div className="h-[1px] flex-grow bg-gradient-to-r from-transparent via-indigo-500/40 to-indigo-500/40"></div>
                    <div className="shrink-0 bg-indigo-600 px-6 py-2 rounded-full border border-indigo-400 shadow-[0_0_15px_rgba(79,70,229,0.3)]">
                        <span className="text-[12px] font-black text-white uppercase tracking-[0.2em]">LIVE SPOT: {currentPrice}</span>
                    </div>
                    <div className="h-[1px] flex-grow bg-gradient-to-l from-transparent via-indigo-500/40 to-indigo-500/40"></div>
                </div>
                {belowSpot.map((l, i) => (
                    <LevelRow key={`below-${i}`} level={l} onClick={() => onLevelClick(l)} spot={spot} />
                ))}
          </div>

          <div className="mt-6 p-5 bg-indigo-950/10 border border-indigo-500/20 rounded-2xl">
             <span className="text-[9px] font-black text-indigo-500 uppercase tracking-widest block mb-2 underline underline-offset-8">HARMONIC RESONANCE SUMMARY</span>
             <p className="text-sm text-gray-200 font-bold leading-relaxed italic">"{dailyOutlook.summary}"</p>
          </div>
        </div>
      )}
    </div>
  );
};
