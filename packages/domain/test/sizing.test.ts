import { describe, expect, it } from 'vitest';
import {
  applyPipDistance,
  checkQuote,
  computeAnalytics,
  computeRiskVolume,
  contractAlignmentFactor,
  derivePipSize,
  maxDrawdown,
  normalizeVolume,
  pipDistance,
  pipValueForVolume,
  pipValuePerLot,
  priceToPips,
  proportionalCloseVolume,
  roundToStep,
  splitVolume,
  stopLossSideFor,
  takeProfitSideFor,
  type EquityPoint,
} from '../src/index.js';
import type { ClosedTrade } from '@trade-copier/contracts';

/**
 * Sizing oracles (FEATURES.md §2).
 *
 *  - 100% = 1:1 volume, 50% halves, 150% = 1.5×
 *  - Balance Multiplier scales with slave/master balance; Fixed Balance
 *    Multiplier pins the master balance
 *  - Fixed % Risk needs a master SL and sizes from pip value
 *  - Refiners are additive and may be negative
 *  - Min-lot clamp only affects trades below the min (and only when forced)
 */

const baseContext = {
  masterVolume: 1,
  masterBalance: 10_000,
  slaveBalance: 10_000,
  masterContractSize: 100_000,
  slaveContractSize: 100_000,
  masterPipSize: 0.0001,
  slavePipSize: 0.0001,
  slaveQuoteCurrency: 'USD',
  slaveAccountCurrency: 'USD',
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const risk = (overrides: Record<string, unknown>) => computeRiskVolume({ ...baseContext, ...overrides } as any);

describe('risk models', () => {
  it('copies 1:1 at 100% (LOT_MULTIPLIER)', () => {
    const result = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.volume).toBeCloseTo(1, 10);
  });

  it('halves at 50% and scales at 150%', () => {
    const half = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 50 });
    const oneAndHalf = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 150 });
    expect(half.ok && half.value.volume).toBeCloseTo(0.5, 10);
    expect(oneAndHalf.ok && oneAndHalf.value.volume).toBeCloseTo(1.5, 10);
  });

  it('scales by the slave/master balance ratio (BALANCE_MULTIPLIER)', () => {
    // slave has half the balance → half the volume at 100%
    const result = risk({ riskType: 'BALANCE_MULTIPLIER', riskValue: 100, masterBalance: 20_000, slaveBalance: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.volume).toBeCloseTo(0.5, 10);
    expect(result.value.steps.some((step) => step.label.includes('balance ratio'))).toBe(true);
  });

  it('uses the pinned master balance (FIXED_BALANCE_MULTIPLIER)', () => {
    const pinned = risk({
      riskType: 'FIXED_BALANCE_MULTIPLIER',
      riskValue: 100,
      masterBalance: 999_999, // live balance is ignored on purpose
      fixedMasterBalance: 10_000,
      slaveBalance: 20_000,
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value.volume).toBeCloseTo(2, 10);
  });

  it('requires a fixed master balance for FIXED_BALANCE_MULTIPLIER', () => {
    const result = risk({ riskType: 'FIXED_BALANCE_MULTIPLIER', riskValue: 100, fixedMasterBalance: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
  });

  it('sizes Fixed % Risk from balance, stop distance and pip value', () => {
    // 1% of 10 000 = 100 USD risk, 50 pip SL, pip value 10 USD/lot → 0.2 lots
    const result = risk({
      riskType: 'FIXED_PERCENT_RISK',
      riskValue: 1,
      masterVolume: 5, // must not influence the result
      stopLossDistancePips: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.volume).toBeCloseTo(0.2, 10);
  });

  it('fails Fixed % Risk without a stop loss (documented requirement)', () => {
    const result = risk({ riskType: 'FIXED_PERCENT_RISK', riskValue: 1, stopLossDistancePips: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.detail).toMatch(/requires a stop loss/i);
  });

  it('applies the lot refiner additively, including negatives', () => {
    const up = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 100, lotRefiner: 0.5 });
    const down = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 100, lotRefiner: -0.5 });
    expect(up.ok && up.value.volume).toBeCloseTo(1.5, 10);
    expect(down.ok && down.value.volume).toBeCloseTo(0.5, 10);
  });

  it('warns when the refiner drives the volume to zero', () => {
    const result = risk({ riskType: 'LOT_MULTIPLIER', riskValue: 100, lotRefiner: -1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.volume).toBeLessThanOrEqual(0);
    expect(result.value.warnings.join(' ')).toMatch(/will not be copied/i);
  });

  it('aligns contract sizes for balance multipliers but not for a plain multiplier', () => {
    // Gold master (100) → FX slave (100 000): 1000× smaller lots
    const aligned = risk({
      riskType: 'BALANCE_MULTIPLIER',
      riskValue: 100,
      masterVolume: 1,
      masterContractSize: 100,
      slaveContractSize: 100_000,
    });
    expect(aligned.ok && aligned.value.volume).toBeCloseTo(0.001, 10);

    const notAligned = risk({
      riskType: 'LOT_MULTIPLIER',
      riskValue: 100,
      masterVolume: 1,
      masterContractSize: 100,
      slaveContractSize: 100_000,
    });
    expect(notAligned.ok && notAligned.value.volume).toBeCloseTo(1, 10);
  });

  it('degrades visibly when a quote→account conversion rate is missing', () => {
    const result = risk({
      riskType: 'FIXED_PERCENT_RISK',
      riskValue: 1,
      stopLossDistancePips: 50,
      slaveQuoteCurrency: 'JPY',
      slaveAccountCurrency: 'USD',
      rates: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.degraded).toBe(true);
    expect(result.value.warnings.join(' ')).toMatch(/assumes 1:1/i);
  });
});

describe('volume normalisation', () => {
  const constraints = { minLot: 0.1, maxLot: 5, lotStep: 0.01 };

  it('rounds to the lot step without touching in-range volumes', () => {
    const result = normalizeVolume({ volume: 1.234, constraints });
    expect(result.ok).toBe(true);
    expect(result.ok && result.volume).toBeCloseTo(1.23, 10);
  });

  it('rejects volumes below the minimum unless Force Minimum Lot is set', () => {
    const rejected = normalizeVolume({ volume: 0.05, constraints });
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.code).toBe('INVALID_VOLUME');

    const forced = normalizeVolume({ volume: 0.05, constraints, forceMin: true });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.volume).toBeCloseTo(0.1, 10);
    expect(forced.adjustments.join(' ')).toMatch(/minimum/);
  });

  it('rejects volumes above the maximum unless Force Maximum Lot is set', () => {
    const rejected = normalizeVolume({ volume: 7, constraints });
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.code).toBe('INVALID_VOLUME');

    const forced = normalizeVolume({ volume: 7, constraints, forceMax: true });
    expect(forced.ok && forced.volume).toBeCloseTo(5, 10);
    if (!forced.ok) return;
    expect(forced.adjustments.join(' ')).toMatch(/maximum/);
  });

  it('rounds to a multiple of the step', () => {
    expect(roundToStep(1.239, 0.01)).toBeCloseTo(1.24, 10);
    expect(roundToStep(1.239, 0.01, 'down')).toBeCloseTo(1.23, 10);
    expect(roundToStep(1.231, 0.01, 'up')).toBeCloseTo(1.24, 10);
  });

  it('splits oversized volumes into step-aligned orders', () => {
    const parts = splitVolume(0.25, 0.1, { minLot: 0.01, maxLot: 100, lotStep: 0.01 });
    expect(parts).toHaveLength(3);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBeCloseTo(0.25, 8);
    for (const part of parts) expect(part % 0.01).toBeCloseTo(0, 8);
  });

  it('computes the contract alignment factor as master/slave', () => {
    expect(contractAlignmentFactor(100_000, 100_000)).toBeCloseTo(1, 10);
    expect(contractAlignmentFactor(100, 100_000)).toBeCloseTo(0.001, 10);
  });
});

describe('partial closes', () => {
  const constraints = { minLot: 0.01, maxLot: 100, lotStep: 0.01 };

  it('closes the same fraction the master closed', () => {
    const result = proportionalCloseVolume(0.2, 1.0, 0.5, constraints);
    expect(result.volume).toBeCloseTo(0.1, 10);
    expect(result.closeAll).toBe(false);
  });

  it('closes everything when the master closes everything', () => {
    const result = proportionalCloseVolume(1, 1, 0.5, constraints);
    expect(result.closeAll).toBe(true);
    expect(result.volume).toBeCloseTo(0.5, 10);
  });

  it('rounds small partials up to the broker minimum instead of leaving dust', () => {
    // 0.99 of a 0.02 slave is 0.0198 → 0.01 at a 0.01 step, which is tradable.
    const result = proportionalCloseVolume(0.99, 1, 0.02, constraints);
    expect(result.volume).toBeCloseTo(0.01, 10);
    expect(result.closeAll).toBe(false);
  });

  it('closes the full slave when the remainder would be dust', () => {
    // A 0.01 slave cannot be split further: any partial mirrors as a full close.
    const result = proportionalCloseVolume(0.5, 1, 0.01, constraints);
    expect(result.closeAll).toBe(true);
    expect(result.volume).toBeCloseTo(0.01, 10);
  });
});

describe('pip maths', () => {
  it('derives pip size from digits (10 points on odd-digit quotes)', () => {
    expect(derivePipSize(5)).toBeCloseTo(0.0001, 10);
    expect(derivePipSize(3)).toBeCloseTo(0.01, 10);
    expect(derivePipSize(2)).toBeCloseTo(0.01, 10);
  });

  it('computes pip value per lot', () => {
    expect(pipValuePerLot(100_000, 0.0001)).toBeCloseTo(10, 10);
    expect(pipValueForVolume(0.5, 100_000, 0.0001)).toBeCloseTo(5, 10);
    expect(pipValuePerLot(100, 0.01)).toBeCloseTo(1, 10); // gold
  });

  it('measures price differences in pips (signed) and magnitudes', () => {
    // signed: positive when the second price is above the first
    expect(priceToPips(1.1000, 1.1050, 0.0001)).toBeCloseTo(50, 10);
    expect(priceToPips(1.1050, 1.1000, 0.0001)).toBeCloseTo(-50, 10);
    // magnitude: risk sizing, tolerances and stop distances
    expect(pipDistance(1.1050, 1.1000, 0.0001)).toBeCloseTo(50, 10);
    expect(pipDistance(1.1000, 1.1050, 0.0001)).toBeCloseTo(50, 10);
  });

  it('applies pip distances in the right direction for each side', () => {
    expect(stopLossSideFor('buy')).toBe('below');
    expect(stopLossSideFor('sell')).toBe('above');
    expect(takeProfitSideFor('buy')).toBe('above');
    expect(takeProfitSideFor('sell')).toBe('below');
    expect(applyPipDistance(1.1, 50, 0.0001, 'below', 5)).toBeCloseTo(1.095, 6);
    expect(applyPipDistance(1.1, 50, 0.0001, 'above', 5)).toBeCloseTo(1.105, 6);
  });
});

describe('quote checks', () => {
  const now = new Date('2026-03-04T10:00:00.000Z');
  const quote = { symbol: 'EURUSD', bid: 1.1000, ask: 1.10008, at: now.toISOString() };

  it('returns the executable price for the side', () => {
    const buy = checkQuote(
      { quote, side: 'buy', pipSize: 0.0001, point: 0.00001, now, maxQuoteAgeMs: 5000, maxSpreadPips: null },
      2,
    );
    expect(buy.ok && buy.price).toBeCloseTo(1.10008, 8);

    const sell = checkQuote(
      { quote, side: 'sell', pipSize: 0.0001, point: 0.00001, now, maxQuoteAgeMs: 5000, maxSpreadPips: null },
      2,
    );
    expect(sell.ok && sell.price).toBeCloseTo(1.1, 8);
  });

  it('stales out old quotes', () => {
    const old = { ...quote, at: new Date(now.getTime() - 6_000).toISOString() };
    const result = checkQuote(
      { quote: old, side: 'buy', pipSize: 0.0001, point: 0.00001, now, maxQuoteAgeMs: 5000, maxSpreadPips: null },
      2,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('STALE_QUOTE');
  });

  it('rejects spreads above the follower limit', () => {
    const wide = { symbol: 'EURUSD', bid: 1.1, ask: 1.1005, at: now.toISOString() };
    const result = checkQuote(
      { quote: wide, side: 'buy', pipSize: 0.0001, point: 0.00001, now, maxQuoteAgeMs: 5000, maxSpreadPips: 2 },
      2,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SPREAD_TOO_WIDE');
  });

  it('converts the pip tolerance into broker deviation points', () => {
    const result = checkQuote(
      { quote, side: 'buy', pipSize: 0.0001, point: 0.00001, now, maxQuoteAgeMs: 5000, maxSpreadPips: null },
      2,
    );
    expect(result.ok && result.deviationPoints).toBeCloseTo(20, 6);
  });
});

describe('analytics', () => {
  const trade = (overrides: Partial<ClosedTrade>): ClosedTrade => ({
    ticket: '1',
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.1,
    openPrice: 1.1,
    closePrice: 1.101,
    stopLoss: null,
    takeProfit: null,
    magic: 0,
    comment: '',
    profit: 10,
    swap: 0,
    commission: 0,
    openedAt: '2026-03-04T09:00:00.000Z',
    closedAt: '2026-03-04T10:00:00.000Z',
    followerId: null,
    ...overrides,
  });

  it('computes the documented headline metrics', () => {
    const series: EquityPoint[] = [
      { at: '2026-03-04T08:00:00.000Z', balance: 10_000, equity: 10_000 },
      { at: '2026-03-04T09:00:00.000Z', balance: 10_100, equity: 10_100 },
      { at: '2026-03-04T10:00:00.000Z', balance: 10_050, equity: 10_050 },
    ];
    const result = computeAnalytics({
      currency: 'USD',
      balance: 10_050,
      equity: 10_050,
      closedTrades: [trade({ ticket: '1', profit: 100 }), trade({ ticket: '2', profit: -50, side: 'sell' })],
      openPositions: [],
      equitySeries: series,
      startingBalance: 10_000,
    });

    expect(result.tradesTaken).toBe(2);
    expect(result.winRate).toBeCloseTo(50, 6);
    expect(result.growthPercent).toBeCloseTo(0.5, 6);
    expect(result.profitFactor).toBeCloseTo(2, 6);
  });

  it('measures both absolute and percentage drawdown', () => {
    const series: EquityPoint[] = [
      { at: '2026-03-04T08:00:00.000Z', balance: 10_000, equity: 10_000 },
      { at: '2026-03-04T09:00:00.000Z', balance: 10_000, equity: 10_500 },
      { at: '2026-03-04T10:00:00.000Z', balance: 10_000, equity: 9_450 },
      { at: '2026-03-04T11:00:00.000Z', balance: 10_000, equity: 10_200 },
    ];
    const drawdown = maxDrawdown(series);
    expect(drawdown.absolute).toBeCloseTo(1_050, 6);
    expect(drawdown.percent).toBeCloseTo(10, 6);
  });
});
