import React, { useState, useRef, useLayoutEffect } from 'react';
import { MarketStructureView } from './components/MarketStructureView';
import { KronosForecastView } from './components/KronosForecastView';
import { TrustView } from './components/TrustView';
import { useOptionsData } from './hooks/useOptionsData';

type Tab = 'market' | 'forecast' | 'trust';

const TABS: { key: Tab; label: string; short: string; icon: string }[] = [
  { key: 'market', label: 'Mercato', short: 'Mercato', icon: '📈' },
  { key: 'forecast', label: 'Proiezioni', short: 'Proiezioni', icon: '🔮' },
  { key: 'trust', label: 'Affidabilità', short: 'Affidab.', icon: '✅' },
];

export default function App() {
  const sharedState = useOptionsData();
  const [activeTab, setActiveTab] = useState<Tab>('market');
  const navRef = useRef<HTMLElement>(null);

  // Publish the nav height as a CSS variable so each view's control bar can
  // stick exactly below the nav. The nav height is responsive, so we
  // re-measure on resize via ResizeObserver instead of hardcoding a value.
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
      {/* Sticky nav: brand + the three sections. One freshness indicator lives
          in each view's ControlBar — never duplicated here. */}
      <nav ref={navRef} className="sticky top-0 z-50 border-b border-gray-800 bg-[#161b22]/95 backdrop-blur px-4 py-2.5 sm:px-6">
        <div className="max-w-[1850px] mx-auto flex items-center justify-between gap-3">
          <span className="text-base sm:text-lg font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent whitespace-nowrap">
            QuantFlow AI
          </span>

          <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-xs font-semibold transition-all duration-150 flex items-center gap-1.5 ${
                  activeTab === t.key ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300'
                }`}
                style={{ backgroundColor: activeTab === t.key ? '#1e293b' : 'transparent' }}
              >
                <span>{t.icon}</span>
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.short}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Selected view */}
      {activeTab === 'market' && <MarketStructureView sharedState={sharedState} />}
      {activeTab === 'forecast' && <KronosForecastView sharedState={sharedState} />}
      {activeTab === 'trust' && <TrustView sharedState={sharedState} />}
    </div>
  );
}
