/**
 * Shared UI constants for expiry filtering.
 *
 * Previously duplicated (with subtly different Italian/English labels)
 * between MarketStructureView and DayTradingView.
 *
 * @module lib/expiry
 */

import { ExpiryFilter } from '../types';

export const EXPIRY_OPTIONS: { key: ExpiryFilter; label: string }[] = [
  { key: '0dte', label: '0 DTE' },
  { key: '1-7dte', label: '1-7 DTE' },
  { key: '8-30dte', label: '8-30 DTE' },
  { key: '30+dte', label: '30+ DTE' },
  { key: 'all', label: 'Tutte' },
];
