/**
 * Volume-profile node detection — HVN / LVN with topographic prominence.
 *
 * WHY THIS EXISTS: the previous inline heuristic marked an HVN at every local
 * maximum of a +-2 window whose volume exceeded 1.15x the median. On the
 * 1-point futures grid that flags dozens of micro-wiggles ("molti HVN"),
 * which then fragment the LVN zones and, downstream, the Fair Value Areas.
 *
 * The standard approach (mirrored from Market/TradingView profile tools):
 *   1. candidate peaks = local maxima (±2) above a share of max volume;
 *   2. keep a peak only if its topographic PROMINENCE is significant —
 *      prominence = how far the profile drops on BOTH sides before rising
 *      back to the peak's level. Real participation shelves survive; noise
 *      between two big nodes does not;
 *   3. dedup by radius (one HVN per neighborhood) and cap, ranked by
 *      prominence.
 *
 * LVN troughs keep the original thresholds (they were already strict) and
 * are expanded into zones by walking outward while volume stays depressed.
 *
 * All functions are PURE and operate on index space; callers map indices
 * back to strikes.
 *
 * @module lib/volumeProfile
 */

export interface ProfileNodes {
  /** Indices of accepted High-Volume Nodes, ranked by prominence (desc). */
  hvnIndices: number[];
  /** Indices of Low-Volume Node troughs. */
  lvnIndices: number[];
  /** Expanded low-volume zones, as [startIdx, endIdx] inclusive index pairs. */
  lvnZones: Array<{ from: number; to: number }>;
}

export interface DetectOptions {
  /** Peak volume must be >= this share of the max volume. Default 0.20. */
  minPeakShare?: number;
  /** Required drop on both sides, as a share of the peak's own volume. Default 0.25. */
  minProminenceRatio?: number;
  /** Max HVNs kept (ranked by prominence). Default 8. */
  maxHvns?: number;
}

const EMPTY: ProfileNodes = { hvnIndices: [], lvnIndices: [], lvnZones: [] };

/** Topographic prominence of a peak at index i over the raw series. */
function prominence(volumes: number[], i: number): number {
  const v = volumes[i];
  let minL = v;
  for (let j = i - 1; j >= 0; j--) {
    if (volumes[j] > v) break;  // reached higher ground → saddle found
    if (volumes[j] < minL) minL = volumes[j];
  }
  let minR = v;
  for (let j = i + 1; j < volumes.length; j++) {
    if (volumes[j] > v) break;
    if (volumes[j] < minR) minR = volumes[j];
  }
  // The saddle is the BEST (highest) of the two side minima: the profile only
  // needs to drop that much on one side for the peak to be separable...
  // No — prominence requires the drop on BOTH sides (a peak leaning on the
  // series edge has no left separation). Use the LOWER of the two drops.
  const dropL = v - Math.max(0, minL);
  const dropR = v - Math.max(0, minR);
  return Math.min(dropL, dropR);
}

export function detectNodes(volumes: number[], opts: DetectOptions = {}): ProfileNodes {
  const { minPeakShare = 0.20, minProminenceRatio = 0.25, maxHvns = 8 } = opts;
  const n = volumes.length;
  if (n < 5) return { ...EMPTY };

  const maxVol = Math.max(...volumes);
  if (maxVol <= 0) return { ...EMPTY };

  const median = [...volumes].filter(v => v > 0).sort((a, b) => a - b);
  const medianVolume = median.length ? median[Math.floor(median.length / 2)] : 0;

  // ---- HVN: prominent peaks (raw series — smoothing would create shoulder
  //      duplicates around every real node) ----
  const candidates: Array<{ i: number; prom: number }> = [];
  for (let i = 2; i < n - 2; i++) {
    const v = volumes[i];
    if (v < maxVol * minPeakShare) continue;
    if (v >= volumes[i - 1] && v >= volumes[i + 1] && v >= volumes[i - 2] && v >= volumes[i + 2]) {
      const prom = prominence(volumes, i);
      if (prom >= v * minProminenceRatio) {
        candidates.push({ i, prom });
      }
    }
  }
  candidates.sort((a, b) => b.prom - a.prom);
  const hvnIndices: number[] = [];
  for (const c of candidates) {
    // Dedup radius: one HVN per neighborhood, however noisy the grid is.
    if (hvnIndices.some(h => Math.abs(h - c.i) <= 3)) continue;
    hvnIndices.push(c.i);
    if (hvnIndices.length === maxHvns) break;
  }
  hvnIndices.sort((a, b) => a - b);

  // ---- LVN: troughs (original thresholds, on the RAW series) ----
  const lvnIndices: number[] = [];
  const lvnZones: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < n - 1; i++) {
    const v = volumes[i];
    const maxSurrounding = Math.max(
      volumes[i - 2] ?? 0, volumes[i - 1] ?? 0,
      volumes[i + 1] ?? 0, volumes[i + 2] ?? 0,
    );
    const isTrough =
      v <= (volumes[i - 1] ?? Infinity) &&
      v <= (volumes[i + 1] ?? Infinity) &&
      maxSurrounding > 0 &&
      v <= maxSurrounding * 0.5 &&
      v < medianVolume * 0.8;
    if (!isTrough) continue;

    lvnIndices.push(i);
    let from = i;
    while (from > 0 && volumes[from - 1] <= v * 1.5 && volumes[from - 1] < medianVolume * 0.7) from--;
    let to = i;
    while (to < n - 1 && volumes[to + 1] <= v * 1.5 && volumes[to + 1] < medianVolume * 0.7) to++;
    lvnZones.push({ from, to });
  }

  return { hvnIndices, lvnIndices, lvnZones };
}
