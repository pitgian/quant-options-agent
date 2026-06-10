import React from 'react';
import { MarketStructureView } from './components/MarketStructureView';
import { useOptionsData } from './hooks/useOptionsData';

export default function App() {
  const sharedState = useOptionsData();

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      {/* Sleek Navigation Header */}
      <nav className="border-b border-gray-800 bg-[#161b22] px-6 py-4">
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
              Delta & Gamma Quant Portal
            </span>
            <span className="text-[10px] uppercase font-bold tracking-widest bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">
              PRO
            </span>
          </div>
          <div className="text-xs text-gray-500 font-semibold tracking-wider uppercase">
            3-Profile Unified Dashboard
          </div>
        </div>
      </nav>

      {/* Render Main Quant View with Shared State */}
      <MarketStructureView sharedState={sharedState} />
    </div>
  );
}
