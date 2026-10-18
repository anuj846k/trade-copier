import { describe, expect, it } from 'vitest';
import { equityProtectionSchema, type EquityProtection } from '@trade-copier/contracts';
import { evaluateEquityProtection, referenceBalanceAt, validateEquityProtection } from '../src/index.js';

/**
 * Equity Protection oracles (FEATURES.md F46–F50).
 *
 *  - percentage limits are measured against the balance captured at the last
 *    daily reset, so deposits raise the permitted equity
 *  - actions are resolved exactly as configured
 *  - the documented mutually-exclusive action pairs are validated
 */
const config = (overrides: Partial<EquityProtection> = {}): EquityProtection =>
  equityProtectionSchema.parse({ enabled: true, notify: true, ...overrides });

describe('equity protection evaluation', () => {
  it('does nothing when disabled', () => {
    const result = evaluateEquityProtection({
      config: config({ enabled: false, maxDrawdownPercent: 1 }),
      balance: 10_000,
      equity: 1_000,
    });
    expect(result.triggered).toBe(false);
  });

  it('fires on a percentage drawdown measured from the reference balance', () => {
    const result = evaluateEquityProtection({
      config: config({ maxDrawdownPercent: 10, disableCopier: true }),
      balance: 10_000,
      equity: 8_900,
    });
    expect(result.triggered).toBe(true);
    if (!result.triggered) return;
    expect(result.kind).toBe('stop_loss');
    expect(result.rule).toBe('max_drawdown_percent');
    expect(result.threshold).toBeCloseTo(9_000, 6);
    expect(result.actions).toContain('disable_copier');
  });

  it('raises the permitted equity when the balance has grown since the reset', () => {
    const stricter = evaluateEquityProtection({
      config: config({ maxDrawdownPercent: 10 }),
      balance: 10_000,
      equity: 9_050,
      referenceBalance: 10_000,
    });
    expect(stricter.triggered).toBe(false);

    const afterDeposit = evaluateEquityProtection({
      config: config({ maxDrawdownPercent: 10 }),
      balance: 20_000,
      equity: 18_500,
      referenceBalance: 20_000,
    });
    expect(afterDeposit.triggered).toBe(false);

    // …and the same absolute equity would have fired against the old reference
    const oldReference = evaluateEquityProtection({
      config: config({ maxDrawdownPercent: 10 }),
      balance: 20_000,
      equity: 18_500,
      referenceBalance: 21_000,
    });
    expect(oldReference.triggered).toBe(true);
  });

  it('supports fixed-value drawdown and absolute minimum equity', () => {
    const fixedValue = evaluateEquityProtection({
      config: config({ maxDrawdownValue: 500 }),
      balance: 10_000,
      equity: 9_400,
    });
    expect(fixedValue.triggered && fixedValue.rule).toBe('max_drawdown_value');

    const absolute = evaluateEquityProtection({
      config: config({ absoluteMinEquity: 5_000 }),
      balance: 10_000,
      equity: 4_900,
    });
    expect(absolute.triggered && absolute.rule).toBe('absolute_min_equity');
  });

  it('fires on profit targets as well as drawdown', () => {
    const percent = evaluateEquityProtection({
      config: config({ maxProfitPercent: 20, closeAllTrades: true }),
      balance: 10_000,
      equity: 12_100,
    });
    expect(percent.triggered).toBe(true);
    if (!percent.triggered) return;
    expect(percent.kind).toBe('take_profit');
    expect(percent.actions).toContain('close_all_trades');

    const absolute = evaluateEquityProtection({
      config: config({ absoluteMaxEquity: 15_000 }),
      balance: 10_000,
      equity: 15_100,
    });
    expect(absolute.triggered && absolute.rule).toBe('absolute_max_equity');
  });

  it('evaluates the stop-loss side before the take-profit side', () => {
    const result = evaluateEquityProtection({
      config: config({ maxDrawdownPercent: 10, maxProfitPercent: 10 }),
      balance: 10_000,
      equity: 8_000,
    });
    expect(result.triggered && result.kind).toBe('stop_loss');
  });
});

describe('equity protection configuration rules', () => {
  it('rejects two closing actions at once', () => {
    const issues = validateEquityProtection(config({ closeCopiedTrades: true, closeAllTrades: true }));
    expect(issues.some((issue) => issue.path === 'closeAllTrades')).toBe(true);
  });

  it('requires at least one action and one limit', () => {
    const noAction = validateEquityProtection(
      config({ notify: false, disableCopier: false, maxDrawdownPercent: 10 }),
    );
    expect(noAction.some((issue) => issue.message.match(/no action/i))).toBe(true);

    const noLimit = validateEquityProtection(config({ maxDrawdownPercent: null }));
    expect(noLimit.some((issue) => issue.message.match(/no limit/i))).toBe(true);
  });
});

describe('daily reference balance', () => {
  it('keeps the reference captured at the last reset', () => {
    const resetAt = new Date('2026-03-04T00:00:00.000Z');
    const now = new Date('2026-03-04T10:00:00.000Z');
    const kept = referenceBalanceAt(resetAt, 12_000, { referenceBalance: 10_000, resetAt }, now);
    expect(kept.referenceBalance).toBe(10_000);

    const rolled = referenceBalanceAt(resetAt, 12_000, { referenceBalance: 10_000, resetAt: new Date('2026-03-03T00:00:00.000Z') }, now);
    expect(rolled.referenceBalance).toBe(12_000);
  });
});
