import React, { useEffect, useState } from 'react';
import { IconClose } from './Icons';
import { clearAllCaches, getLastUpdateTime } from '../services/dataService';

interface SettingsPanelProps {
  onClose: () => void;
  currentSymbol?: string;
}

export function SettingsPanel({ onClose, currentSymbol = 'SPY' }: SettingsPanelProps) {
  const [lastUpdate, setLastUpdate] = useState<string>('Loading...');
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    getLastUpdateTime(currentSymbol).then(setLastUpdate);
  }, [currentSymbol]);

  const handleClearCache = () => {
    clearAllCaches();
    setCleared(true);
    setTimeout(() => setCleared(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <IconClose />
          </button>
        </div>

        {/* Last Update */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Last Data Update
          </label>
          <p className="text-sm text-gray-400">{lastUpdate}</p>
        </div>

        {/* Cache */}
        <div className="mb-5">
          <button
            onClick={handleClearCache}
            className="w-full bg-gray-700 hover:bg-gray-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            {cleared ? '✓ Cache Cleared' : 'Clear Cache'}
          </button>
          <p className="text-xs text-gray-500 mt-1">
            Clears local and in-memory data cache
          </p>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-gray-700">
          <p className="text-xs text-gray-500 text-center">
            Options Wall Analyzer • Data from Yahoo Finance via GitHub Actions
          </p>
        </div>
      </div>
    </div>
  );
}
