/**
 * MarketStructurePanels — bottom-row cards extracted from MarketStructureView.
 *
 * Two focused sub-components (Phase 2b step 2):
 *   - StructuralAnalysisCard : reads the `analysis` useMemo
 *   - LegendCard             : ~100 lines of static Italian explainer HTML,
 *                              gated by a local collapse toggle
 *
 * Both are visually identical to the inline originals.
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
// Legend / Operational Guide Card
// ===========================================================================

export function LegendCard({
  isGuideOpen,
  setIsGuideOpen,
}: {
  isGuideOpen: boolean;
  setIsGuideOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="bg-[#161b22] border border-gray-800 rounded-2xl overflow-hidden transition-all duration-300 h-full flex flex-col">
      <button
        onClick={() => setIsGuideOpen(!isGuideOpen)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-800/20 transition-colors shrink-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-sm">💡</span>
          <span className="text-xs font-bold uppercase tracking-wider text-gray-300">Guida Operativa & Legenda</span>
        </div>
        <span className={`text-xs text-gray-500 transition-transform duration-300 ${isGuideOpen ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>

      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2 border-t border-slate-800/50 text-xs text-gray-400 space-y-4">
        {isGuideOpen ? (
          <>
            <div className="border-b border-slate-850 pb-3">
              <h4 className="font-bold text-indigo-400 mb-1 uppercase tracking-wide">🎯 WORKFLOW OPERATIVO (Vantaggio Statistico)</h4>
              <p className="leading-relaxed text-[11px] text-gray-300 mb-2">
                <strong>1. Analisi del Regime (GEX):</strong> Sopra il GEX Flip (Positive Gamma) prevale stabilità e compressione di volatilità. Sotto il GEX Flip (Negative Gamma) si attivano espansioni repentine e trend direzionali accelerati dai Market Maker.
              </p>
              <p className="leading-relaxed text-[11px] text-gray-300 mb-2">
                <strong>2. Nodi Volumetrici:</strong> Il POC (Point of Control) e gli HVN agiscono come magneti del prezzo (aree ad alto volume). Gli LVN (Low Volume Nodes) indicano vuoti di liquidità: fungono da barriere reattive o zone di accelerazione rapida.
              </p>
              <p className="leading-relaxed text-[11px] text-gray-300">
                <strong>3. Confluenza & Esecuzione:</strong> Cerca ingressi ad alta probabilità (Mean Reversion) quando il prezzo tocca gli estremi del <em>Range Kronos AI</em> in concomitanza con barriere opzioni rilevanti (Call/Put Wall) o POC/HVN, preferibilmente in regime di Gamma Positivo.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-amber-500 mb-0.5">⚡ GEX Flip Point</h4>
              <p className="leading-relaxed text-[11px] text-gray-450">
                Livello critico che separa il regime a volatilità controllata (positivo, sopra il flip) dal regime a volatilità esplosiva (negativo, sotto il flip). Guida la scelta tra strategie di rimbalzo o di breakout.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-amber-500 mb-0.5">POC Magnete (Point of Control)</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Prezzo con la massima concentrazione di contratti futures/opzioni scambiati. Funge da baricentro o prezzo di equilibrio verso cui il mercato tende naturalmente a ritornare.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-blue-400 mb-0.5">VAL / VAH (Value Area Boundaries)</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Limiti inferiore (VAL) e superiore (VAH) del 70% dei volumi scambiati. Uscite decise da questo range segnalano squilibri e l'avvio di forti impulsi direzionali.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-purple-400 mb-0.5">HVN (High Volume Node)</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Nodi ad alto volume. Rappresentano supporti e resistenze statiche orizzontali solide dove il prezzo tende a rallentare e consolidare in range.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-rose-400 mb-0.5">LVN Zone (Low Volume Node)</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Zone a basso volume scambiato. Essendo vuoti di liquidità, il prezzo tende a rimbalzarvi contro violentemente o ad attraversarle con estrema rapidità.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-blue-400 mb-0.5">🤖 Range Atteso Kronos AI</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Area sfumata blu racchiusa da parentesi sul grafico. Indica i limiti statistici di oscillazione previsti dall'IA per il timeframe attivo. Ottimo da usare in confluenza con le barriere opzioni.
              </p>
            </div>

            <div>
              <h4 className="font-bold text-slate-350 mb-0.5">📊 Triplo Allineamento Strike (F | C | E)</h4>
              <p className="leading-relaxed text-[11px] text-gray-455">
                Al centro del grafico sono visualizzati tre prezzi per ogni riga di strike:
                <br />
                • <strong>F (Futures)</strong>: Il livello di prezzo equivalente sul contratto futures (ES / NQ) rettificato per la base attuale.
                <br />
                • <strong>C (Cash Index)</strong>: Lo strike effettivo delle opzioni sull'indice cash (SPX / NDX).
                <br />
                • <strong>E (ETF)</strong>: Lo strike effettivo delle opzioni sull'ETF corrispondente (SPY / QQQ).
                <br />
                Questo consente di individuare all'istante le confluenze volumetriche e delle opzioni direttamente sul prezzo dei futures che scambi.
              </p>
            </div>
          </>
        ) : (
          <div className="text-gray-500 italic flex items-center justify-center h-24">
            Clicca su "Guida Operativa & Legenda" per visualizzare le spiegazioni.
          </div>
        )}
      </div>
    </div>
  );
}
