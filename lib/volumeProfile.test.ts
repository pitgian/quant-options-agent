/**
 * Tests for lib/volumeProfile — HVN prominence detection + LVN zones.
 *
 * Run: npx vitest run lib/volumeProfile.test.ts
 */
import { describe, it, expect } from 'vitest';
import { detectNodes } from './volumeProfile';

/** Helper: build a volume array from a compact spec. */
function build(spec: Record<number, number>, baseline = 5, size = 60): number[] {
  const v = new Array(size).fill(baseline);
  for (const [idx, vol] of Object.entries(spec)) v[Number(idx)] = vol;
  return v;
}

describe('detectNodes', () => {
  it('keeps only the DOMINANT peaks, not every wiggle', () => {
    // Two big nodes (20, 40) + wiggles of 12-14 between them (old logic would
    // flag each as HVN: local max + > 1.15x median of ~5-8).
    const v = build({ 10: 14, 12: 13, 14: 12, 20: 300, 30: 13, 32: 12, 40: 420, 50: 14 });
    const { hvnIndices } = detectNodes(v);
    expect(hvnIndices).toContain(20);
    expect(hvnIndices).toContain(40);
    expect(hvnIndices).not.toContain(10);
    expect(hvnIndices).not.toContain(12);
    expect(hvnIndices).not.toContain(30);
    expect(hvnIndices.length).toBe(2);
  });

  it('caps the number of HVNs, ranked by prominence', () => {
    const v = new Array(60).fill(5);
    for (let k = 0; k < 12; k++) v[5 + k * 4] = 300 - k * 5; // 12 real peaks
    const { hvnIndices } = detectNodes(v, { maxHvns: 8 });
    expect(hvnIndices.length).toBeLessThanOrEqual(8);
  });

  it('a peak leaning on the series edge (no left separation) is rejected', () => {
    // Monotonic ramp up to the last cell: the top has no drop on the right.
    const v = new Array(40).fill(5).map((x, i) => 5 + i * 2);
    const { hvnIndices } = detectNodes(v);
    expect(hvnIndices).toHaveLength(0);
  });

  it('detects LVN troughs and expands the zone across the depressed area', () => {
    // Baseline 0: i profili reali scartano le righe a volume nullo.
    const v = build({
      20: 400, 21: 380,            // nodo
      23: 2, 24: 1, 25: 1, 26: 2,  // solco depresso (LVN)
      28: 390, 29: 400,            // nodo
    }, 0);
    const { lvnIndices, lvnZones } = detectNodes(v);
    expect(lvnIndices).toContain(24); // fondo del solco
    const zone = lvnZones.find(z => z.from <= 24 && z.to >= 24)!;
    expect(zone).toBeDefined();
    expect(zone.to).toBeGreaterThanOrEqual(25);
  });

  it('returns empty for a flat profile (no prominent nodes)', () => {
    const v = new Array(40).fill(50);
    const { hvnIndices, lvnIndices } = detectNodes(v);
    expect(hvnIndices).toHaveLength(0);
    expect(lvnIndices).toHaveLength(0);
  });

  it('handles all-zero and tiny profiles gracefully', () => {
    expect(detectNodes(new Array(30).fill(0)).hvnIndices).toHaveLength(0);
    expect(detectNodes([1, 2, 3]).hvnIndices).toHaveLength(0);
  });
});
