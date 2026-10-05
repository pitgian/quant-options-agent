import React, { useEffect, useState } from 'react';
import { DayView } from './components/DayView';
import { StatsPanel } from './components/StatsPanel';
import { Segmented, Collapsible } from './components/ui';
import { fetchLevelStats, type LevelStat } from './services/dayPlanService';

type Fut = 'ES' | 'NQ';

export default function App() {
  const [futures, setFutures] = useState<Fut>('ES');
  const [stats, setStats] = useState<Record<string, LevelStat>>({});

  useEffect(() => {
    fetchLevelStats().then(setStats).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen flex flex-col text-slate-100" style={{ backgroundColor: '#0d1117' }}>
      <nav className="sticky top-0 z-50 border-b border-gray-800 bg-[#161b22]/95 backdrop-blur px-4 py-2.5 sm:px-6">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-3 flex-wrap">
          <span className="text-base sm:text-lg font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent whitespace-nowrap">
            QuantFlow — Livelli di oggi
          </span>
          <Segmented
            value={futures}
            onChange={(f) => setFutures(f)}
            options={[
              { value: 'ES', label: '🇺🇸 S&P (ES)' },
              { value: 'NQ', label: '💻 Nasdaq (NQ)' },
            ]}
          />
        </div>
      </nav>

      <main className="flex-1 px-4 py-6">
        <div className="max-w-[1100px] mx-auto flex flex-col gap-5 w-full animate-fadeIn">
          <DayView futures={futures} />
          <Collapsible title="Affidabilità storica dei livelli" icon="📐"
                       hint="quante volte ogni livello ha retto, su quante occorrenze">
            <StatsPanel stats={stats} />
          </Collapsible>
        </div>
      </main>

      <footer className="border-t border-gray-800/40 px-6 py-2.5 text-[10px] text-gray-600 flex justify-between">
        <span>QuantFlow — livelli da opzioni, volumi e auction market theory</span>
        <span>non è consulenza finanziaria</span>
      </footer>
    </div>
  );
}
