
import React, { useState, useCallback, useRef } from 'react';
import { getAnalysis, getChat } from './services/aiService';
import { AnalysisLevel, ChatMessage, DailyOutlook, MarketDataset } from './types';
import { QuantPanel } from './components/QuantPanel';
import { ChatPanel } from './components/ChatPanel';
import { Content } from '@google/genai';

const App: React.FC = () => {
  const [datasets, setDatasets] = useState<MarketDataset[]>([]);
  const [currentPrice, setCurrentPrice] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<AnalysisLevel[] | null>(null);
  const [dailyOutlook, setDailyOutlook] = useState<DailyOutlook | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState<boolean>(false);
  const [isLoadingChat, setIsLoadingChat] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);

  const addDataset = (d: MarketDataset) => setDatasets(prev => [...prev, d]);
  const removeDataset = (id: string) => setDatasets(prev => prev.filter(d => d.id !== id));

  const handleReset = useCallback(() => {
    setDatasets([]);
    setCurrentPrice('');
    setAnalysisResult(null);
    setDailyOutlook(null);
    setChatHistory([]);
    setError(null);
  }, []);

  const handleAnalysis = useCallback(async () => {
    if (datasets.length === 0 || !currentPrice.trim()) {
      setError("Dati insufficienti.");
      return;
    }
    setIsLoadingAnalysis(true);
    setError(null);
    try {
      const response = await getAnalysis(datasets, currentPrice);
      setAnalysisResult(response.levels);
      setDailyOutlook(response.outlook);
      const initialContext: ChatMessage = {
        role: 'user',
        parts: [{ text: `RISONANZA: Spot ${currentPrice}. Dataset totali: ${datasets.length}. Livelli: ${JSON.stringify(response.levels)}` }]
      };
      setChatHistory([initialContext]);
    } catch (err: any) {
      setError("Errore scansione risonanza.");
    } finally {
      setIsLoadingAnalysis(false);
    }
  }, [datasets, currentPrice]);

  const handleChatSubmit = useCallback(async (message: string) => {
    const userMessage: ChatMessage = { role: 'user', parts: [{ text: message }] };
    const newHistory = [...chatHistory, userMessage];
    setChatHistory(newHistory);
    setIsLoadingChat(true);
    try {
      const modelResponse = await getChat(newHistory as Content[]);
      setChatHistory(prev => [...prev, { role: 'model', parts: [{ text: modelResponse }] }]);
    } catch (err: any) {
      setChatHistory(prev => [...prev, { role: 'model', parts: [{ text: `Errore.` }] }]);
    } finally {
      setIsLoadingChat(false);
    }
  }, [chatHistory]);

  const handleLevelClick = useCallback((level: AnalysisLevel) => {
    if (isLoadingChat || !analysisResult) return;
    handleChatSubmit(`Analisi strike ${level.prezzo} (${level.scadenzaTipo}). Spiega la risonanza armonica di questo livello.`);
    chatPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [handleChatSubmit, isLoadingChat, analysisResult]);

  return (
    <div className="min-h-screen bg-[#050505] text-gray-100 p-4 sm:p-6 font-sans">
      <div className="max-w-screen-xl mx-auto">
        <header className="mb-8 flex justify-between items-end border-b border-gray-800 pb-4">
          <div>
            <h1 className="text-3xl font-black text-white tracking-tighter uppercase">
              Quant <span className="text-indigo-500">Terminal</span>
            </h1>
            <p className="text-[10px] text-gray-500 font-mono tracking-widest uppercase font-bold">
              Harmonic Resonance Engine v5.0
            </p>
          </div>
          <div className="hidden sm:block text-right">
             <div className="text-[9px] text-gray-600 font-bold uppercase tracking-widest">Market Status</div>
             <div className="text-[10px] text-indigo-500 font-bold">RESONANCE MODE ACTIVE</div>
          </div>
        </header>

        <main className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
          <div className="xl:col-span-3">
            <QuantPanel 
                datasets={datasets}
                addDataset={addDataset}
                removeDataset={removeDataset}
                currentPrice={currentPrice}
                setCurrentPrice={setCurrentPrice}
                handleAnalysis={handleAnalysis}
                onReset={handleReset}
                isLoading={isLoadingAnalysis}
                error={error}
                analysisResult={analysisResult}
                dailyOutlook={dailyOutlook}
                onLevelClick={handleLevelClick}
            />
          </div>
          <div className="xl:col-span-2 h-full">
            <ChatPanel 
                ref={chatPanelRef}
                chatHistory={chatHistory}
                handleChatSubmit={handleChatSubmit}
                isLoading={isLoadingChat}
                isReady={!!analysisResult}
            />
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
