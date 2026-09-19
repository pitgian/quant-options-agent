/**
 * Tests for keyLevelService — gamma-mechanism classification (pin/trigger).
 *
 * Background: the Sep-2026 empirical validation (scratch/validate_levels.py)
 * showed raw-OI walls act as ~random supports, while the max-positive-GEX
 * strike rejects price ~80% of the time. Levels therefore carry a gammaSign
 * ('pin' | 'trigger') derived from netGEX, and pin levels get a modest
 * strength bonus so they win cluster competition.
 *
 * Run: npx vitest run services/keyLevelService.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildDayTradingData } from './keyLevelService';
import type { Wall, GexRegime } from '../types';

const SPOT = 100.0;

function wall(strike: number, type: 'put_wall' | 'call_wall', netGEX: number, score = 50): Wall {
  return {
    strike,
    type,
    score,
    totalOI: 1000,
    totalVolume: 500,
    callOI: type === 'call_wall' ? 1000 : 100,
    callVolume: type === 'call_wall' ? 500 : 50,
    putOI: type === 'put_wall' ? 1000 : 100,
    putVolume: type === 'put_wall' ? 500 : 50,
    netGEX,
    distance: Math.abs(strike - SPOT) / SPOT * 100,
    nearestExpiry: '2026-10-16',
  };
}

const REGIME: GexRegime = { regime: 'positive', label: 'Low Volatility', netGEX: 1e9, flipPoint: null };

describe('buildDayTradingData gamma mechanism', () => {
  it('tags call-dominated strikes above spot as pin and boosts their strength', () => {
    const r = buildDayTradingData('SPY', SPOT, '2026-09-18T20:00:00Z',
      [wall(98, 'put_wall', -5e8)],
      [wall(101, 'call_wall', +8e8), wall(103, 'call_wall', -3e8)],
      REGIME, [],
    );
    const pin = r.resistance.find(l => l.strike === 101)!;
    const trig = r.resistance.find(l => l.strike === 103)!;
    expect(pin.gammaSign).toBe('pin');
    expect(pin.strength).toBe(58); // 50 (raw) + 8 (pin bonus)
    expect(trig.gammaSign).toBe('trigger');
    expect(trig.strength).toBe(50); // untouched
  });

  it('tags put-dominated strikes below spot as trigger (no boost)', () => {
    const r = buildDayTradingData('SPY', SPOT, '2026-09-18T20:00:00Z',
      [wall(97, 'put_wall', -6e8), wall(95, 'put_wall', +2e8)],
      [wall(102, 'call_wall', +4e8)],
      REGIME, [],
    );
    const trig = r.support.find(l => l.strike === 97)!;
    const pin = r.support.find(l => l.strike === 95)!;
    expect(trig.gammaSign).toBe('trigger');
    expect(trig.strength).toBe(50);
    expect(pin.gammaSign).toBe('pin');
    expect(pin.strength).toBe(58);
  });

  it('puts a pin level ahead of a stronger raw-OI wall when they cluster', () => {
    // Two levels 0.3% apart (would cluster): the pin must win the spacing
    // competition even with lower raw score, because of the +8 bonus.
    const r = buildDayTradingData('SPY', SPOT, '2026-09-18T20:00:00Z',
      [wall(99.6, 'put_wall', +5e8, 55), wall(99.9, 'put_wall', -5e8, 62)],
      [wall(102, 'call_wall', +4e8)],
      REGIME, [],
    );
    const strikes = r.support.map(l => l.strike);
    expect(strikes).toContain(99.6);
    expect(strikes).not.toContain(99.9); // weaker post-bonus, too close → dropped
  });

  it('gamma flip level keeps strength 95 and is unaffected', () => {
    const flip: GexRegime = { regime: 'negative', label: 'High Volatility', netGEX: -1e9, flipPoint: 99 };
    const r = buildDayTradingData('SPY', SPOT, '2026-09-18T20:00:00Z',
      [wall(97, 'put_wall', -6e8)],
      [wall(102, 'call_wall', +4e8)],
      flip, [],
    );
    const f = r.support.find(l => l.label.includes('Gamma Flip'))!;
    expect(f.strength).toBe(95);
  });
});
