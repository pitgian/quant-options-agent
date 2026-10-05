import React from 'react';
import { Badge } from './ui';
import type { IntradayLevels } from '../types';
import { valuePosition } from '../lib/auction';

/**
 * AuctionState — la lettura AMT in 4 righe: apertura, value, IB, VWAP.
 *
 * Risponde in 5 secondi alla domanda "che giorno è oggi?":
 *   - Apertura fuori dalla value di ieri → giornata direzionale in ricerca
 *   - Apertura dentro → rotazionale (fade dei confini VAH/VAL)
 *   - IB rotto → trend day probabile
 *   - Prezzo sopra/sotto VWAP → bias intraday
 *
 * @module components/AuctionState
 */

export const AuctionState: React.FC<{
  playbook?: IntradayLevels;
  spotFut: number;
  futuresSymbol: string;
}> = ({ playbook, spotFut, futuresSymbol }) => {
  if (!playbook) return null;

  // Posizione del prezzo rispetto alla value di ieri (VAL/POC/VAH)
  const val = playbook.prev_day_profile?.val;
  const vah = playbook.prev_day_profile?.vah;
  const poc = playbook.prev_day_profile?.poc;
  const pos = spotFut && val && vah ? valuePosition(spotFut, { poc: poc ?? spotFut, vah, val, totalVol: 1 }) : null;

  const ibHigh = playbook.ib_high;
  const ibLow = playbook.ib_low;
  const ibStatus = ibHigh && ibLow && spotFut
    ? spotFut > ibHigh ? { label: 'IB rotto AL RIALZO', tone: 'good' as const, hint: 'probabile trend day ↑' }
      : spotFut < ibLow ? { label: 'IB rotto AL RIBASSO', tone: 'bad' as const, hint: 'probabile trend day ↓' }
      : { label: 'prezzo dentro l\u2019IB', tone: 'neutral' as const, hint: 'equilibrio iniziale' }
    : null;

  const vwap = playbook.vwap;
  const vwapStatus = vwap && spotFut
    ? spotFut > vwap
      ? { label: 'sopra VWAP', tone: 'good' as const, hint: 'bias intraday long — comprare i pullback verso VWAP' }
      : { label: 'sotto VWAP', tone: 'bad' as const, hint: 'bias intraday short — vendere i rimbalzi verso VWAP' }
    : null;

  const posText = pos === 'above_vah' ? 'sopra la value di ieri'
    : pos === 'below_val' ? 'sotto la value di ieri'
    : 'dentro la value di ieri';

  const rows: Array<{ icon: string; label: string; value: React.ReactNode; hint?: string }> = [
    {
      icon: '🔔',
      label: 'Apertura',
      value: playbook.open_type
        ? { above_vah: 'sopra la value', below_val: 'sotto la value', inside_va: 'dentro la value' }[playbook.open_type]
        : '—',
      hint: playbook.open_note,
    },
    {
      icon: '📐',
      label: 'Value adesso',
      value: posText,
      hint: poc ? `Magnete (POC di ieri): ${futuresSymbol} $${Math.round(poc).toLocaleString()}` : undefined,
    },
  ];
  if (ibStatus) {
    rows.push({
      icon: '⚖️',
      label: `Initial Balance (${ibLow ?? '—'}–${ibHigh ?? '—'})`,
      value: ibStatus.label,
      hint: ibStatus.hint,
    });
  }
  if (vwapStatus) {
    rows.push({
      icon: '📊',
      label: `VWAP ${Math.round(vwap ?? 0)}`,
      value: vwapStatus.label,
      hint: vwapStatus.hint,
    });
  }

  const tone = (t?: 'good' | 'bad' | 'neutral') =>
    t === 'good' ? 'text-emerald-400' : t === 'bad' ? 'text-red-400' : 'text-slate-300';

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-sm font-bold text-slate-200">🔔 Stato dell'asta</h3>
        <span className="text-[10px] text-gray-500">Auction Market Theory — la lettura in 5 secondi</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
        {rows.map(r => (
          <div key={r.label} className="flex items-start gap-2.5" title={r.hint}>
            <span className="text-sm mt-0.5">{r.icon}</span>
            <div className="min-w-0">
              <div className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">{r.label}</div>
              <div className={`text-xs font-semibold ${r.value === ibStatus?.label || r.value === vwapStatus?.label ? tone(r.value === ibStatus?.label ? ibStatus?.tone : vwapStatus?.tone) : 'text-slate-200'}`}>
                {typeof r.value === 'string' ? r.value : ''}
              </div>
              {r.hint && <div className="text-[10px] text-gray-500 leading-snug mt-0.5">{r.hint}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
