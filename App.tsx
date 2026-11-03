import React, { useEffect, useState } from 'react';
import { DayView, type ChainSource } from './components/DayView';
import { StatsPanel } from './components/StatsPanel';
import { SeparationPanel } from './components/SeparationPanel';
import { Segmented, Collapsible } from './components/ui';
import { fetchLevelStats, type LevelStat } from './services/dayPlanService';

type Fut = 'ES' | 'NQ';

const CHAIN_SRC_KEY = 'qf-chain-source';

function loadChainSrc(): ChainSource {
  const v = localStorage.getItem(CHAIN_SRC_KEY);
  return v === 'index' || v === 'both' ? v : 'etf';
}

export default function App() {
  const [futures, setFutures] = useState<Fut>('ES');
  const [chainSrc, setChainSrc] = useState<ChainSource>(loadChainSrc);
  const [stats, setStats] = useState<Record<string, LevelStat>>({});

  const changeChainSrc = (v: ChainSource) => {
    setChainSrc(v);
    try { localStorage.setItem(CHAIN_SRC_KEY, v); } catch { /* private mode */ }
  };

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
          <div className="flex items-center gap-2 flex-wrap">
            <Segmented
              size="xs"
              value={chainSrc}
              onChange={changeChainSrc}
              options={[
                { value: 'etf', label: '📊 ETF', title: 'Livelli da catene SPY/QQQ — esercizio americano fisico, è la serie storica del track record' },
                { value: 'index', label: '🏛 Indici', title: 'Livelli da catene SPX/NDX — opzioni europee a regolamento in contanti, i dealer coprono la gamma sui futures' },
                { value: 'both', label: '🔀 Entrambi', title: 'Unione delle due fonti: dove coincidono emergono come confluenza ★' },
              ]}
            />
            <Segmented
              value={futures}
              onChange={(f) => setFutures(f)}
              options={[
                { value: 'ES', label: '🇺🇸 S&P (ES)' },
                { value: 'NQ', label: '💻 Nasdaq (NQ)' },
              ]}
            />
          </div>
        </div>
      </nav>

      <main className="flex-1 px-4 py-6">
        <div className="max-w-[1100px] mx-auto flex flex-col gap-5 w-full animate-fadeIn">
          <DayView futures={futures} chain={chainSrc} />
          <Collapsible title="Affidabilità storica dei livelli" icon="📐"
                       hint="quante volte ogni livello ha retto, su quante occorrenze">
            <StatsPanel stats={stats} />
            <div className="mt-4 pt-4 border-t border-slate-800">
              <h4 className="text-xs font-bold text-slate-300 mb-3">
                📊 Test di separazione — le feature spiegano gli esiti?
              </h4>
              <SeparationPanel stats={stats} />
            </div>
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
