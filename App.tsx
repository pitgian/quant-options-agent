import React, { useState } from 'react';
import { MarketStructureView } from './components/MarketStructureView';
import { DayTradingView } from './components/DayTradingView';
import { KronosForecastView } from './components/KronosForecastView';
import { useOptionsData } from './hooks/useOptionsData';

export default function App() {
  const sharedState = useOptionsData();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'levels' | 'kronos'>('dashboard');

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      {/* Sleek Navigation Header */}
      <nav className="border-b border-gray-800 bg-[#161b22] px-6 py-4">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                Gamma & Volatility Analytics Portal
              </span>
              <span className="text-[10px] uppercase font-bold tracking-widest bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">
                PRO
              </span>
            </div>
            
            {/* Elegant Tab Navigation */}
            <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800 ml-0 md:ml-4 shrink-0">
              <button
                onClick={() => setActiveTab('dashboard')}
                className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'dashboard' ? '#1e293b' : 'transparent',
                  color: activeTab === 'dashboard' ? '#e2e8f0' : '#64748b',
                }}
              >
                📊 Dashboard Volumi
              </button>
              <button
                onClick={() => setActiveTab('levels')}
                className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'levels' ? '#1e293b' : 'transparent',
                  color: activeTab === 'levels' ? '#e2e8f0' : '#64748b',
                }}
              >
                🎯 Livelli Intraday
              </button>
              <button
                onClick={() => setActiveTab('kronos')}
                className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: activeTab === 'kronos' ? '#1e293b' : 'transparent',
                  color: activeTab === 'kronos' ? '#e2e8f0' : '#64748b',
                }}
              >
                🎯 Proiezioni Kronos AI
              </button>
            </div>
          </div>
          <div className="text-xs text-gray-500 font-semibold tracking-wider uppercase">
            {activeTab === 'dashboard' ? '3-Profile Unified Dashboard' : 
             activeTab === 'levels' ? 'Day Trading Key Levels' : 'Kronos AI Detailed Forecast'}
          </div>
        </div>
      </nav>

      {/* Render Selected View */}
      {activeTab === 'dashboard' && <MarketStructureView sharedState={sharedState} />}
      {activeTab === 'levels' && <DayTradingView sharedState={sharedState} />}
      {activeTab === 'kronos' && <KronosForecastView sharedState={sharedState} />}
    </div>
  );
}
