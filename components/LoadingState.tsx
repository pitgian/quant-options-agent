import React from 'react';
import { Skeleton } from './ui';

/**
 * LoadingState — skeleton placeholder shown while the data pipeline loads.
 *
 * Previously a spinner; skeletons communicate the layout that is coming and
 * feel faster. Used by MarketStructureView and available to any view.
 *
 * @module components/LoadingState
 */

const LoadingState: React.FC<{ label?: string }> = ({ label = 'Caricamento dati…' }) => (
  <div className="min-h-[60vh] flex flex-col items-center justify-center px-4" role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    <div className="w-full max-w-[1200px] flex flex-col gap-4">
      {/* ticker strip */}
      <Skeleton className="h-16 w-full" />
      {/* hero panel */}
      <Skeleton className="h-72 w-full" />
      {/* bottom cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  </div>
);

export { LoadingState };
