/**
 * Tests for lib/auction — AMT state + ladder construction.
 *
 * Run: npx vitest run lib/auction.test.ts
 */
import { describe, it, expect } from 'vitest';
import { profileStats, classifyOpen, valuePosition, buildLadder } from './auction';

describe('profileStats', () => {
  const prof = {
    '100': 10, '101': 20, '102': 80, '103': 90, '104': 85, '105': 40, '106': 15,
  };

  it('finds the POC as the max-volume node', () => {
    expect(profileStats(prof)!.poc).toBe(103);
  });

  it('expands the value area to ~70% around the POC', () => {
    const s = profileStats(prof)!;
    expect(s.val).toBeLessThanOrEqual(s.poc);
    expect(s.vah).toBeGreaterThanOrEqual(s.poc);
    const vaVol = [102, 103, 104].reduce((acc, p) => acc + prof[String(p)], 0);
    expect(vaVol / s.totalVol).toBeGreaterThanOrEqual(0.7);
  });

  it('returns null on an empty profile', () => {
    expect(profileStats({})).toBeNull();
  });
});

describe('classifyOpen / valuePosition', () => {
  const prev = profileStats({ '100': 10, '101': 10, '102': 80, '103': 80, '104': 10 })!;

  it('open above VAH', () => {
    expect(classifyOpen(105, prev)).toBe('above_vah');
  });
  it('open below VAL', () => {
    expect(classifyOpen(98, prev)).toBe('below_val');
  });
  it('open inside VA', () => {
    expect(classifyOpen(102, prev)).toBe('inside_va');
  });
  it('valuePosition is the same rule applied to a live price', () => {
    expect(valuePosition(99, prev)).toBe('below_val');
    expect(valuePosition(102, prev)).toBe('inside_va');
  });
});

describe('buildLadder', () => {
  const SPOT = 7800;
  const input = [
    { label: 'PDH', price: 7718, family: 'price' as const },          // lontano
    { label: 'ONH', price: 7771, family: 'price' as const },
    { label: 'VAH-1d', price: 7829, family: 'amt' as const },          // coincide col muro 7830
    { label: 'NAKED POC', price: 7705, family: 'amt' as const },       // magnete sotto
    { label: 'Call Wall', price: 7831, family: 'options' as const, gammaSign: 'pin' as const },
    { label: 'Put Wall', price: 7761, family: 'options' as const, gammaSign: 'trigger' as const },
    { label: 'VWAP', price: 7777, family: 'price' as const },
  ];

  it('clusters levels that round to the same 5pt zone', () => {
    const { above } = buildLadder(input, SPOT);
    // VAH-1d (7829) e Call Wall (7831) → stessa zona 7830
    const zone = above.find(z => z.price === 7830);
    expect(zone).toBeDefined();
    expect(zone!.merged).toBe(2);
    expect(zone!.label).toBeDefined();
  });

  it('returns zones ordered by price (nearest to spot first)', () => {
    const { above, below } = buildLadder(input, SPOT);
    const abovePrices = above.map(z => z.price);
    expect(abovePrices).toEqual([...abovePrices].sort((a, b) => a - b));
    const belowPrices = below.map(z => z.price);
    expect(belowPrices).toEqual([...belowPrices].sort((a, b) => b - a));
  });

  it('limits each side to maxPerSide, keeping the most important', () => {
    const many = [
      ...input,
      ...Array.from({ length: 10 }, (_, i) => ({
        label: `L${i}`, price: 7900 + i * 10, family: 'price' as const,
      })),
    ];
    const { above } = buildLadder(many, SPOT, 5, 6);
    expect(above.length).toBeLessThanOrEqual(6);
  });

  it('never mixes a level exactly at spot into a side', () => {
    const { above, below } = buildLadder([
      ...input,
      { label: 'AT', price: SPOT, family: 'price' as const },
    ], SPOT);
    expect(above.every(z => z.price > SPOT)).toBe(true);
    expect(below.every(z => z.price < SPOT)).toBe(true);
  });

  it('prioritizes confluence and magnets over lonely levels', () => {
    const { below } = buildLadder([
      { label: 'lonely-far', price: 7600, family: 'price' as const },
      { label: 'NAKED POC', price: 7761, family: 'amt' as const, isNaked: true },
      { label: 'Put Wall', price: 7762, family: 'options' as const, gammaSign: 'trigger' as const },
    ], SPOT);
    // La zona 7760 (naked + muro fusi) deve essere tra le scelte
    expect(below.some(z => z.price === 7760)).toBe(true);
  });
});
