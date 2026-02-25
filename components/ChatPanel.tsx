
import React, { useState, useRef, useEffect, forwardRef } from 'react';
import { ChatMessage } from '../types';
import { IconSend, IconLoader, IconSparkles } from './Icons';
import { 
    AIProvider, 
    getStoredProvider, 
    setStoredProvider, 
    getStoredModel,
    setStoredModel,
    getAPIStatus, 
    getProviderInfo,
    getModelsForProvider,
    GEMINI_MODELS,
    GLM_MODELS
} from '../services/aiService';

interface ChatPanelProps {
  chatHistory: ChatMessage[];
  handleChatSubmit: (message: string) => void;
  isLoading: boolean;
  isReady: boolean;
}

const ChatBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const isModel = message.role === 'model';
  return (
    <div className={`flex items-start gap-3 ${isModel ? '' : 'flex-row-reverse'}`}>
      <div className={`p-4 rounded-2xl max-w-[95%] shadow-sm ${isModel ? 'bg-gray-800/40 text-gray-200 border border-gray-700/50' : 'bg-indigo-600/20 text-indigo-100 border border-indigo-500/30'}`}>
        <p className="text-sm leading-relaxed font-medium" style={{ whiteSpace: 'pre-wrap' }}>{message.parts[0].text}</p>
      </div>
    </div>
  );
};

export const ChatPanel = forwardRef<HTMLDivElement, ChatPanelProps>(({ chatHistory, handleChatSubmit, isLoading, isReady }, ref) => {
  const [input, setInput] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>(getStoredProvider);
  const [selectedModel, setSelectedModel] = useState<string>(getStoredModel(getStoredProvider()));
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const apiStatus = getAPIStatus();

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatHistory]);

  // Update model when provider changes
  useEffect(() => {
    const models = getModelsForProvider(selectedProvider);
    const currentModel = getStoredModel(selectedProvider);
    // Check if current model is valid for this provider
    const isValid = models.some(m => m.id === currentModel);
    if (!isValid) {
      const defaultModel = models[0].id;
      setSelectedModel(defaultModel);
      setStoredModel(selectedProvider, defaultModel);
    } else {
      setSelectedModel(currentModel);
    }
  }, [selectedProvider]);

  const handleProviderChange = (provider: AIProvider) => {
    setSelectedProvider(provider);
    setStoredProvider(provider);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    setStoredModel(selectedProvider, modelId);
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading && isReady) {
      handleChatSubmit(input.trim());
      setInput('');
    }
  };

  const models = getModelsForProvider(selectedProvider);
  const providerInfo = getProviderInfo(selectedProvider, selectedModel);

  return (
    <div ref={ref} className="bg-gray-900/40 p-6 rounded-3xl shadow-xl flex flex-col h-[750px] border border-gray-800/50 backdrop-blur-xl">
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-black text-white uppercase tracking-tighter">AI COPILOT</h2>
          
          {/* Provider Selector */}
          <div className="flex items-center gap-2">
            <select
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value as AIProvider)}
              className="appearance-none bg-gray-800/60 border border-gray-700/50 rounded-lg px-3 py-1.5 pr-8 text-xs font-medium text-gray-300 focus:outline-none focus:border-indigo-500 cursor-pointer hover:bg-gray-800 transition-colors"
            >
              <option value="gemini" disabled={!apiStatus.gemini}>
                Gemini {apiStatus.gemini ? '✓' : '(no key)'}
              </option>
              <option value="glm" disabled={!apiStatus.glm}>
                GLM {apiStatus.glm ? '✓' : '(no key)'}
              </option>
            </select>
          </div>
        </div>
        
        {/* Model Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Model:</span>
          <select
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="flex-1 appearance-none bg-gray-800/40 border border-gray-700/30 rounded-lg px-3 py-1 text-xs font-medium text-gray-400 focus:outline-none focus:border-indigo-500/50 cursor-pointer hover:bg-gray-800/60 transition-colors"
          >
            {models.map(model => (
              <option key={model.id} value={model.id}>
                {model.name} - {model.description}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      {!isReady ? (
        <div className="flex-grow flex flex-col items-center justify-center text-center p-6 opacity-50">
            <div className="p-6 rounded-full mb-4 border border-indigo-500/20">
                <IconSparkles />
            </div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Waiting for market data</p>
        </div>
      ) : (
        <>
          <div ref={chatContainerRef} className="flex-grow overflow-y-auto pr-2 space-y-4 mb-6 scrollbar-thin">
            {chatHistory.slice(1).map((msg, index) => (
              <ChatBubble key={index} message={msg} />
            ))}
            {isLoading && (
                <div className="flex items-start gap-3">
                     <div className="p-4 rounded-xl bg-gray-800/20 border border-gray-700/30 animate-pulse">
                        <IconLoader />
                    </div>
                </div>
            )}
          </div>
          <form onSubmit={onFormSubmit} className="relative mt-auto">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask the AI..."
                className="flex-grow bg-gray-800/40 border border-gray-700/50 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50 transition-colors"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="p-3 bg-indigo-600 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-500 transition-colors"
              >
                <IconSend />
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
});
