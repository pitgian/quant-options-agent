import React, { useState, useRef, useLayoutEffect } from 'react';
import { MarketStructureView } from './components/MarketStructureView';
import { DayTradingView } from './components/DayTradingView';
import { KronosForecastView } from './components/KronosForecastView';
import { AdapterStatusView } from './components/AdapterStatusView';
import { useOptionsData } from './hooks/useOptionsData';

export default function App() {
  const sharedState = useOptionsData();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'levels' | 'kronos' | 'adapter'>('dashboard');
  const navRef = useRef<HTMLElement>(null);

  // Publish the nav height as a CSS variable so each view's filter header can
  // stick exactly below the nav. The nav height is responsive (taller on
  // mobile where the title + tabs stack into two rows), so we re-measure on
  // resize via ResizeObserver instead of hardcoding a value.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = () => {
      document.documentElement.style.setProperty('--app-nav-h', `${nav.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      {/* Sleek Navigation Header — always visible (sticky) so tabs are reachable at any scroll position */}
      <nav ref={navRef} className="sticky top-0 z-50 border-b border-gray-800 bg-[#161b22]/95 backdrop-blur px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="max-w-[1850px] mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full sm:w-auto">
            <div className="flex items-center gap-2">
              <span className="text-sm sm:text-base md:text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent whitespace-nowrap">
                QuantFlow AI
              </span>
              <span className="text-[9px] uppercase font-bold tracking-widest bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20">
                PRO
              </span>
            </div>
            
            {/* Elegant Tab Navigation */}
            <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800 w-full sm:w-auto justify-between sm:justify-start">
              <button
                onClick={() => setActiveTab('dashboard')}
                className="flex-1 sm:flex-none px-2.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'dashboard' ? '#1e293b' : 'transparent',
                  color: activeTab === 'dashboard' ? '#e2e8f0' : '#64748b',
                }}
              >
                <span className="hidden sm:inline">📊 Dashboard Volumi</span>
                <span className="sm:hidden">📊 Volumi</span>
              </button>
              <button
                onClick={() => setActiveTab('levels')}
                className="flex-1 sm:flex-none px-2.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'levels' ? '#1e293b' : 'transparent',
                  color: activeTab === 'levels' ? '#e2e8f0' : '#64748b',
                }}
              >
                <span className="hidden sm:inline">🎯 Livelli Intraday</span>
                <span className="sm:hidden">🎯 Livelli</span>
              </button>
              <button
                onClick={() => setActiveTab('kronos')}
                className="flex-1 sm:flex-none px-2.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'kronos' ? '#1e293b' : 'transparent',
                  color: activeTab === 'kronos' ? '#e2e8f0' : '#64748b',
                }}
              >
                <span className="hidden sm:inline">🎯 Proiezioni Kronos AI</span>
                <span className="sm:hidden">🎯 Kronos</span>
              </button>
              <button
                onClick={() => setActiveTab('adapter')}
                className="flex-1 sm:flex-none px-2.5 py-1.5 rounded-md text-[11px] sm:text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'adapter' ? '#1e293b' : 'transparent',
                  color: activeTab === 'adapter' ? '#e2e8f0' : '#64748b',
                }}
              >
                <span className="hidden sm:inline">🧠 Adapter AI</span>
                <span className="sm:hidden">🧠 Adapter</span>
              </button>
            </div>
          </div>
          <div className="hidden md:block text-[10px] sm:text-xs text-gray-500 font-semibold tracking-wider uppercase">
            {activeTab === 'dashboard' ? '3-Profile Unified Dashboard' : 
             activeTab === 'levels' ? 'Day Trading Key Levels' : 
             activeTab === 'kronos' ? 'Kronos AI Detailed Forecast' : 'Covariate Adapter Health & Training'}
          </div>
        </div>
      </nav>

      {/* Render Selected View */}
      {activeTab === 'dashboard' && <MarketStructureView sharedState={sharedState} />}
      {activeTab === 'levels' && <DayTradingView sharedState={sharedState} />}
      {activeTab === 'kronos' && <KronosForecastView sharedState={sharedState} />}
      {activeTab === 'adapter' && <AdapterStatusView sharedState={sharedState} />}
    </div>
  );
}
