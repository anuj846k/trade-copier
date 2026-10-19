import { describe, expect, it } from 'vitest';
import {
  accountSnapshotSchema,
  DEFAULT_FOLLOWER_SETTINGS,
  equityProtectionSchema,
  followerSettingsSchema,
  positionSchema,
  riskTypeSchema,
  symbolInfoSchema,
  symbolOverrideSchema,
  applySymbolOverride,
} from '../src/index.js';

/**
 * Contract invariants.
 *
 * These schemas sit on every boundary in the system (agent ↔ API ↔ database ↔
 * dashboard), so a default that changes silently is a behavioural change in
 * production. Each assertion below exists because something downstream depends
 * on it.
 */

describe('positionSchema', () => {
  const minimal = {
    ticket: '12345',
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.1,
    openPrice: 1.085,
    openedAt: '2026-03-04T10:00:00.000Z',
  };

  it('fills in the fields an agent may omit', () => {
    const position = positionSchema.parse(minimal);
    expect(position).toMatchObject({
      closedVolume: 0,
      currentPrice: null,
      stopLoss: null,
      takeProfit: null,
      kind: 'market',
      magic: 0,
      comment: '',
      profit: null,
      swap: null,
      commission: null,
    });
  });

  it('keeps 64-bit tickets as strings', () => {
    // MT5 tickets exceed Number.MAX_SAFE_INTEGER; a numeric schema would
    // silently corrupt them.
    const ticket = '90071992547409931';
    expect(positionSchema.parse({ ...minimal, ticket }).ticket).toBe(ticket);
  });

  it('rejects a non-positive volume', () => {
    expect(positionSchema.safeParse({ ...minimal, volume: 0 }).success).toBe(false);
  });

  it('rejects a float magic number', () => {
    expect(positionSchema.safeParse({ ...minimal, magic: 1.5 }).success).toBe(false);
  });
});

describe('symbolInfoSchema', () => {
  const minimal = {
    name: 'EURUSD.raw',
    canonical: 'EURUSD',
    digits: 5,
    point: 0.00001,
    pipSize: 0.0001,
    contractSize: 100_000,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    quoteCurrency: 'USD',
  };

  it('keeps the broker symbol as the identity and defaults the rest', () => {
    const symbol = symbolInfoSchema.parse(minimal);
    expect(symbol.name).toBe('EURUSD.raw');
    expect(symbol.assetClass).toBe('unknown');
    expect(symbol.tradeMode).toBe('full');
    expect(symbol.enabled).toBe(true);
  });

  it('rejects a zero lot step', () => {
    expect(symbolInfoSchema.safeParse({ ...minimal, lotStep: 0 }).success).toBe(false);
  });
});

describe('accountSnapshotSchema', () => {
  it('defaults margin fields to zero rather than leaving them undefined', () => {
    const snapshot = accountSnapshotSchema.parse({
      accountId: 'acc_1',
      balance: 10_000,
      equity: 10_120.5,
      currency: 'USD',
      at: '2026-03-04T10:00:00.000Z',
    });
    expect(snapshot.margin).toBe(0);
    expect(snapshot.freeMargin).toBe(0);
    expect(snapshot.marginLevel).toBeNull();
    expect(snapshot.leverage).toBeNull();
  });
});

describe('risk types', () => {
  it('exposes exactly the five documented models', () => {
    expect(riskTypeSchema.options).toEqual([
      'LOT_MULTIPLIER',
      'FIXED_LOT',
      'BALANCE_MULTIPLIER',
      'FIXED_BALANCE_MULTIPLIER',
      'FIXED_PERCENT_RISK',
    ]);
  });
});

describe('followerSettingsSchema', () => {
  it('defaults to a 1:1 lot multiplier with copying enabled', () => {
    expect(DEFAULT_FOLLOWER_SETTINGS.riskType).toBe('LOT_MULTIPLIER');
    // The reference product documents 100% as 1:1; the default must match.
    expect(DEFAULT_FOLLOWER_SETTINGS.riskValue).toBe(100);
    expect(DEFAULT_FOLLOWER_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_FOLLOWER_SETTINGS.reverseTrade).toBe(false);
  });

  it('keeps the safety switches off by default', () => {
    // Reopening positions on the slave is the one reconnect action that can
    // create exposure the user did not ask for, so it must be opt-in.
    expect(DEFAULT_FOLLOWER_SETTINGS.reconnectPolicy.reopenMissing).toBe(false);
    expect(DEFAULT_FOLLOWER_SETTINGS.copyStopLoss).toBe(true);
    expect(DEFAULT_FOLLOWER_SETTINGS.strictClose).toBe(false);
  });

  it('parses an empty object into a complete, usable settings record', () => {
    const settings = followerSettingsSchema.parse({});
    expect(Object.keys(settings).length).toBeGreaterThan(10);
    expect(settings.filters.side).toBe('all');
    expect(settings.filters.magic.mode).toBe('all');
  });

  it('rejects a negative risk value', () => {
    expect(followerSettingsSchema.safeParse({ riskValue: -1 }).success).toBe(false);
  });
});

describe('equity protection', () => {
  it('is disabled with every threshold unset by default', () => {
    const protection = equityProtectionSchema.parse({});
    expect(protection.enabled).toBe(false);
    expect(protection.maxDrawdownPercent).toBeNull();
    expect(protection.maxDrawdownValue).toBeNull();
    expect(protection.absoluteMinEquity).toBeNull();
    expect(protection.maxProfitPercent).toBeNull();
    expect(protection.absoluteMaxEquity).toBeNull();
    expect(protection.resetTime).toBe('00:00');
    expect(protection.notify).toBe(true);
  });

  it('accepts a stop-loss style rule with only one threshold set', () => {
    const protection = equityProtectionSchema.parse({ enabled: true, maxDrawdownPercent: 5 });
    expect(protection.maxDrawdownPercent).toBe(5);
    expect(protection.disableCopier).toBe(false);
  });

  it('rejects a non-positive threshold (a rule that can never fire is a bug)', () => {
    expect(equityProtectionSchema.safeParse({ maxDrawdownPercent: 0 }).success).toBe(false);
  });
});

describe('symbol overrides', () => {
  const override = symbolOverrideSchema.parse({ masterSymbol: 'XAUUSD', settings: { riskValue: 25 } });

  it('applies only the overridden keys', () => {
    const base = followerSettingsSchema.parse({ riskType: 'LOT_MULTIPLIER', riskValue: 100 });
    const merged = applySymbolOverride(base, override);
    expect(merged.riskValue).toBe(25);
    expect(merged.riskType).toBe('LOT_MULTIPLIER');
    expect(merged.maxSlippagePips).toBe(base.maxSlippagePips);
  });

  it('merges a per-symbol filter override instead of replacing the whole set', () => {
    const base = followerSettingsSchema.parse({ riskValue: 100 });
    const parsed = symbolOverrideSchema.parse({ masterSymbol: 'EURUSD', settings: { filters: { side: 'buy' } } });
    const merged = applySymbolOverride(base, parsed);
    expect(merged.filters.side).toBe('buy');
    // Sibling filters the override did not mention must survive.
    expect(merged.filters.magic.mode).toBe(base.filters.magic.mode);
    expect(merged.filters.symbol.mode).toBe(base.filters.symbol.mode);
  });

  it('leaves follower-wide scheduling alone when the override only changes sizing', () => {
    const base = followerSettingsSchema.parse({
      tradingHoursEnabled: true,
      tradingHours: [{ day: 1, start: '08:00', end: '17:00' }],
      reconnectPolicy: { enabled: true, closeOrphans: true, reopenMissing: false },
    });
    const merged = applySymbolOverride(base, override);
    expect(merged.tradingHoursEnabled).toBe(true);
    expect(merged.tradingHours).toEqual(base.tradingHours);
    expect(merged.reconnectPolicy.closeOrphans).toBe(true);
  });
});
