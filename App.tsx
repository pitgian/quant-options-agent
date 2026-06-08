import React, { useState } from 'react';
import { DayTradingView } from './components/DayTradingView';
import { MarketStructureView } from './components/MarketStructureView';
import { useOptionsData } from './hooks/useOptionsData';

export default function App() {
  const [activeTab, setActiveTab] = useState<'levels' | 'structure'>('levels');
  const sharedState = useOptionsData();

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      {/* Sleek Navigation Header */}
      <nav className="border-b border-gray-800 bg-[#161b22] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
              Delta & Gamma Quant Portal
            </span>
            <span className="text-[10px] uppercase font-bold tracking-widest bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">
              PRO
            </span>
          </div>

          <div className="flex bg-slate-900 rounded-xl p-1 border border-slate-800">
            <button
              onClick={() => setActiveTab('levels')}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
              style={{
                backgroundColor: activeTab === 'levels' ? '#1e293b' : 'transparent',
                color: activeTab === 'levels' ? '#e2e8f0' : '#64748b',
              }}
            >
              🎯 Livelli Day Trading
            </button>
            <button
              onClick={() => setActiveTab('structure')}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
              style={{
                backgroundColor: activeTab === 'structure' ? '#1e293b' : 'transparent',
                color: activeTab === 'structure' ? '#e2e8f0' : '#64748b',
              }}
            >
              📊 Struttura di Mercato & Volume Profile
            </button>
          </div>
        </div>
      </nav>

      {/* Render Active View with Shared State */}
      {activeTab === 'levels' ? (
        <DayTradingView sharedState={sharedState} />
      ) : (
        <MarketStructureView sharedState={sharedState} />
      )}
    </div>
  );
}
