import React, { useMemo } from 'react';
import { Badge } from './ui';
import type { DayTradingLevel, IntradayLevels } from '../types';
import { buildLadder, type LadderLevel, type LadderInput } from '../lib/auction';

/**
 * LevelLadder — LA SCALA dei livelli di oggi.
 *
 * Una sola lista ordinata per prezzo: resistenze sopra, spot al centro,
 * supporti sotto. Ogni riga dice COSA è il livello (Max di ieri, VWAP, Muro
 * Call in pin…), da dove viene (📐 AMT / 💵 Prezzo / ⚙️ Opzioni) e quante
 * fonti indipendenti confluiscono (★ = zona ad alta opportunità).
 *
 * @module components/LevelLadder
 */

export interface LevelLadderProps {
  playbook?: IntradayLevels;
  /** Muri da opzioni in scala ETF (strike) — convertiti qui in futures. */
  walls: DayTradingLevel[];
  /** GEX flip in scala ETF (strike). */
  gexFlipEtf?: number | null;
  /** Prezzo futures live. */
  spotFut: number;
  /** Fattore di conversione ETF → futures (live). */
  etfToFut: number;
  /** Fattore di conversione indice → futures (live). */
  indexToFut: number;
  futuresSymbol: string;
}

const SOURCE_ICON: Record<string, string> = {
  amt: '📐', price: '💵', options: '⚙️',
};

const Row: React.FC<{ l: LadderLevel; symbol: string }> = ({ l, symbol }) => (
  <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
    l.merged > 1 ? 'border-slate-700/60 bg-slate-900/30' : 'border-transparent'
  } hover:bg-slate-900/50`}>
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-sm font-extrabold text-slate-100 tnum">
        {symbol} ${l.price.toLocaleString()}
      </span>
      {l.merged > 1 && (
        <Badge tone="good" title={`${l.merged} livelli distinti confluiscono qui: zona ad alta opportunità`}>
          ★ {l.merged} in conflu.
        </Badge>
      )}
      {l.isNaked && <Badge tone="info" title="POC mai rivisitato: il prezzo tende a tornarci a cercare volume">Magnete</Badge>}
      {l.isFlip && <Badge tone="violet" title="GEX flip: cambio di regime gamma">Flip</Badge>}
      {l.gammaSign === 'pin' && <Badge tone="info" title="Gamma lunga: i dealer fanno trading contro il movimento — respinge">Pin</Badge>}
      {l.gammaSign === 'trigger' && <Badge tone="warn" title="Gamma corta: le coperture accelerano il movimento — rottura probabile">Trg</Badge>}
    </div>
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-[11px] text-gray-400 hidden sm:inline whitespace-nowrap">{l.label}</span>
      <span className={`text-[9px] font-extrabold uppercase px-1 py-0.5 rounded ${SOURCE_ICON[l.family] === '📐' ? 'bg-violet-500/15 text-violet-300' : SOURCE_ICON[l.family] === '⚙️' ? 'bg-amber-500/15 text-amber-300' : 'bg-blue-500/15 text-blue-300'}`}
            title={l.family === 'amt' ? 'Auction Market Theory: struttura di volume/value' : l.family === 'options' ? 'Derivato dal posizionamento sulle opzioni' : 'Livello di prezzo puro'}>
        {SOURCE_ICON[l.family]}
      </span>
    </div>
  </div>
);

export const LevelLadder: React.FC<LevelLadderProps> = ({
  playbook, walls, gexFlipEtf, spotFut, etfToFut, indexToFut, futuresSymbol,
}) => {
  const ladder = useMemo(() => {
    if (!spotFut) return { above: [], below: [] };

    const inputs: LadderInput[] = [];

    // 💵 Prezzo + 📐 AMT dal playbook (già in scala futures nativa)
    for (const l of playbook?.levels ?? []) {
      inputs.push({
        label: l.label,
        price: l.price,
        family: l.label.startsWith('NAKED') || ['VAH-1d', 'POC-1d', 'VAL-1d', 'POC-dev', 'IB-HIGH', 'IB-LOW'].includes(l.label) ? 'amt' : 'price',
        isNaked: l.label === 'NAKED POC',
      });
    }

    // ⚙️ Opzioni: muri (strike ETF → futures) con meccanismo gamma
    for (const w of walls) {
      inputs.push({
        label: w.type === 'support' ? 'Muro Put' : 'Muro Call',
        price: w.strike * etfToFut,
        family: 'options',
        gammaSign: w.gammaSign,
      });
    }

    // ⚙️ GEX flip (strike indice → futures)
    if (gexFlipEtf) {
      inputs.push({
        label: 'GEX Flip',
        price: gexFlipEtf * indexToFut,
        family: 'options',
        isFlip: true,
      });
    }

    return buildLadder(inputs, spotFut, 5, 6);
  }, [playbook, walls, gexFlipEtf, spotFut, etfToFut, indexToFut]);

  if (!spotFut || (ladder.above.length === 0 && ladder.below.length === 0)) return null;

  return (
    <div className="bg-[#161b22] border border-slate-700 rounded-2xl p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-sm font-bold text-slate-200">🎯 La scala di oggi</h3>
        <div className="flex items-center gap-2 text-[9px] text-gray-500">
          <span title="Auction Market Theory: struttura di volume/value">📐 AMT</span>
          <span title="Livelli di prezzo puro dai futures">💵 Prezzo</span>
          <span title="Derivati dal posizionamento sulle opzioni">⚙️ Opzioni</span>
          <span>— ★ = confluenza di più fonti</span>
        </div>
      </div>

      {ladder.above.map(l => <Row key={`a-${l.price}`} l={l} symbol={futuresSymbol} />)}

      <div className="flex items-center gap-3 px-1 py-2.5">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
        <span className="text-xs font-extrabold text-blue-300 uppercase tracking-wider tnum">
          ⚡ Spot {futuresSymbol} ${spotFut.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-blue-500/50 via-transparent to-transparent" />
      </div>

      {ladder.below.map(l => <Row key={`b-${l.price}`} l={l} symbol={futuresSymbol} />)}

      <p className="text-[10px] text-gray-500 leading-relaxed mt-2 px-1">
        Zona = livello arrotondato a 5 punti. Quando più livelli distinti confluiscono sulla stessa
        zona (★), la reazione è statisticamente più affidabile. Il meccanismo atteso è dichiarato:
        <b> Pin</b> respinge, <b>Trg</b> accelera la rottura, <b>Magnete</b> attira.
      </p>
    </div>
  );
};
