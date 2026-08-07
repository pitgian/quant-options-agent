/**
 * Formatting Utilities
 *
 * Shared formatting helpers for the Options Wall Analyzer UI.
 *
 * @module utils/formatting
 */

/** Format a number as compact (e.g. 1.2M, 345K) */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

/** Format a strike price */
export function formatStrike(strike: number): string {
  return strike.toFixed(2);
}

/** Calculate % distance from spot */
export function distancePct(strike: number, spot: number): number {
  return ((strike - spot) / spot) * 100;
}

/** Format GEX value with sign and appropriate scale */
export function formatGEX(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '';
  if (abs >= 1_000_000_000) return sign + (n / 1_000_000_000).toFixed(2) + 'B';
  if (abs >= 1_000_000) return sign + (n / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return sign + (n / 1_000).toFixed(1) + 'K';
  return sign + n.toFixed(0);
}

/** Format a timestamp to a readable string */
export function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

/** Return a color string based on GEX sign (green for positive, red for negative) */
export function formatGEXColor(value: number): string {
  return value >= 0 ? '#10B981' : '#EF4444';
}

/** Format a percentage distance with explicit sign, e.g. "+0.5%" or "-1.2%" */
export function formatDistance(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
