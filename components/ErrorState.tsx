/**
 * ErrorState — Full-page error display with retry button
 *
 * @module components/ErrorState
 */

import React from 'react';
import { IconRefresh } from './Icons';

export interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center min-h-[60vh] text-gray-400">
    <div className="text-4xl mb-4">⚠️</div>
    <p className="text-lg text-red-400 mb-2">Failed to load data</p>
    <p className="text-sm text-gray-500 mb-4">{message}</p>
    <button
      onClick={onRetry}
      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
    >
      <IconRefresh className="h-4 w-4" /> Retry
    </button>
  </div>
);
