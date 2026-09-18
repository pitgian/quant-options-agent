/**
 * MarketStructurePanels — bottom-row cards extracted from MarketStructureView.
 *
 *   - StructuralAnalysisCard : reads the `analysis` useMemo of
 *     MarketStructureView (fair-value area, nearest boundary).
 *
 * (LegendCard was removed in the UI restructure: the legend now lives in an
 * InfoHint popover inside the profile chart header.)
 *
 * @module components/MarketStructurePanels
 */

import React from 'react';

// ===========================================================================
// Shared types (mirror the shapes produced by MarketStructureView's useMemos)
// ===========================================================================

export interface StructuralAnalysis {
  currentArea: { low: number; high: number } | null;
  nearestBoundary: { type: string; low: number; pct: number } | null;
  suggestion: React.ReactNode;
}

// ===========================================================================
// Structural Analysis Card
// ===========================================================================

export function StructuralAnalysisCard({ analysis }: { analysis: StructuralAnalysis | null }) {
  if (!analysis) return null;
  return (
    <div className="bg-[#161b22] border border-gray-800 rounded-2xl p-5 h-full">
      <h3 className="text-sm font-bold text-gray-200 mb-3 flex items-center gap-2">
        <span>💡</span> Analisi di Struttura
      </h3>
      {analysis.currentArea && (
        <div className="mb-3">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Zona Fair Value Attuale:</span>
          <div className="text-sm text-gray-300 font-medium mt-0.5">
            ${analysis.currentArea.low.toFixed(0)} - ${analysis.currentArea.high.toFixed(0)}
          </div>
        </div>
      )}
      <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800 text-xs leading-relaxed text-gray-400">
        {analysis.suggestion}
      </div>
      {analysis.nearestBoundary && (
        <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span>Confine più vicino:</span>
            <span className="font-semibold text-rose-400">{analysis.nearestBoundary.type.split(' ')[0]}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span>Distanza dallo Spot:</span>
            <span className="font-mono font-bold text-amber-500">
              {analysis.nearestBoundary.pct > 0 ? '+' : ''}{analysis.nearestBoundary.pct.toFixed(2)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
