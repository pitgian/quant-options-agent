/**
 * LoadingState — Full-page loading spinner
 *
 * @module components/LoadingState
 */

import React from 'react';
import { IconLoader } from './Icons';

export const LoadingState: React.FC = () => (
  <div className="flex flex-col items-center justify-center min-h-[60vh] text-gray-400">
    <IconLoader className="h-8 w-8 mb-4" />
    <p className="text-lg">Loading options data...</p>
    <p className="text-sm text-gray-500 mt-1">Fetching from GitHub</p>
  </div>
);
