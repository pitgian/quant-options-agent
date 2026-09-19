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
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    market: null, forecast: null, trust: null,
  });

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

  // Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
  const onTabKeyDown = (e: React.KeyboardEvent, current: Tab) => {
    const idx = TABS.findIndex((t) => t.key === current);
    let next: Tab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length].key;
    if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length].key;
    if (e.key === 'Home') next = TABS[0].key;
    if (e.key === 'End') next = TABS[TABS.length - 1].key;
    if (next) {
      e.preventDefault();
      setActiveTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      {/* Sticky nav: brand + the three sections. One freshness indicator lives
          in each view's ControlBar — never duplicated here. */}
      <nav ref={navRef} className="sticky top-0 z-50 border-b border-gray-800 bg-[#161b22]/95 backdrop-blur px-4 py-2.5 sm:px-6">
        <div className="max-w-[1850px] mx-auto flex items-center justify-between gap-3 flex-wrap">
          <span className="text-base sm:text-lg font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent whitespace-nowrap">
            QuantFlow AI
          </span>

          <div
            role="tablist"
            aria-label="Sezioni dell'app"
            className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800"
          >
            {TABS.map((t) => {
              const selected = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  ref={(el) => { tabRefs.current[t.key] = el; }}
                  role="tab"
                  id={`tab-${t.key}`}
                  aria-selected={selected}
                  aria-controls={`panel-${t.key}`}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={(e) => onTabKeyDown(e, t.key)}
                  onClick={() => setActiveTab(t.key)}
                  className={`px-3 sm:px-4 py-1.5 rounded-md text-xs font-semibold transition-all duration-150 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 ${
                    selected ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  style={{ backgroundColor: selected ? '#1e293b' : 'transparent' }}
                >
                  <span aria-hidden="true">{t.icon}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                  <span className="sm:hidden">{t.short}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Selected view — keyed so each tab remounts with the fade transition */}
      <div
        key={activeTab}
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="flex flex-col flex-1 animate-fadeIn"
      >
        {activeTab === 'market' && <MarketStructureView sharedState={sharedState} />}
        {activeTab === 'forecast' && <KronosForecastView sharedState={sharedState} />}
        {activeTab === 'trust' && <TrustView sharedState={sharedState} />}
      </div>
    </div>
  );
}
