import { describe, expect, it } from 'vitest';
import { evaluateFilters, isMarketOpen, dailyResetInstant, withinTradingHours } from '../src/index.js';
import { DEFAULT_TRADE_FILTERS } from './helpers.js';

/**
 * Market-hours / trading-hours / filter oracles.
 *
 *  - FX week runs from Sunday 22:00 UTC (Sydney open) to Friday 22:00 UTC
 *    (New York close); the daily rollover break is 21:00–22:00 UTC by default
 *  - Trading Hours gate new entries only (the planner decides that; here we
 *    test the time-window maths in the follower's own timezone)
 *  - filters: magic, comment, side, lot range, symbol include/exclude
 */

describe('market hours', () => {
  it('is open mid-session on a Wednesday', () => {
    const state = isMarketOpen({ symbol: 'EURUSD', at: new Date('2026-03-04T10:00:00.000Z'), assetClass: 'forex' });
    expect(state.open).toBe(true);
    expect(state.reason).toBe('open');
  });

  it('is closed on Saturday and reports when it reopens', () => {
    const state = isMarketOpen({ symbol: 'EURUSD', at: new Date('2026-03-07T12:00:00.000Z'), assetClass: 'forex' });
    expect(state.open).toBe(false);
    expect(state.reason).toBe('weekend');
    expect(state.nextOpenAt).not.toBeNull();
    const nextOpen = new Date(state.nextOpenAt!);
    expect(nextOpen.getUTCDay()).toBe(0); // Sunday
    // Default FX week opens Sunday 21:00 UTC (Sydney AEST); operators can move
    // it via MarketSessionConfig.
    expect(nextOpen.getUTCHours()).toBe(21);
  });

  it('is closed during the daily rollover break', () => {
    const state = isMarketOpen({ symbol: 'EURUSD', at: new Date('2026-03-04T21:30:00.000Z'), assetClass: 'forex' });
    expect(state.open).toBe(false);
    expect(state.reason).toBe('daily_break');
  });

  it('is closed on a configured holiday', () => {
    const state = isMarketOpen({
      symbol: 'EURUSD',
      at: new Date('2026-12-25T10:00:00.000Z'),
      assetClass: 'forex',
      config: { holidays: ['12-25'] },
    });
    expect(state.open).toBe(false);
    expect(state.reason).toBe('holiday');
  });

  it('treats crypto as always open', () => {
    const state = isMarketOpen({ symbol: 'BTCUSD', at: new Date('2026-03-07T12:00:00.000Z'), assetClass: 'crypto' });
    expect(state.open).toBe(true);
    expect(state.reason).toBe('always_open');
  });
});

describe('trading hours', () => {
  const windows = [
    { day: 1 as const, start: '08:00', end: '12:00' },
    { day: 1 as const, start: '13:00', end: '17:00' },
  ];

  it('accepts an instant inside a window (follower timezone)', () => {
    // Monday 09:00 London = 09:00 UTC in March (GMT)
    const inside = withinTradingHours({ windows, timezone: 'Europe/London', at: new Date('2026-03-02T09:00:00.000Z') });
    expect(inside).toBe(true);
  });

  it('rejects an instant outside every window', () => {
    const outside = withinTradingHours({ windows, timezone: 'Europe/London', at: new Date('2026-03-02T12:30:00.000Z') });
    expect(outside).toBe(false);
  });

  it('applies the follower timezone, not UTC', () => {
    // Monday 09:00 in New York is 14:00 UTC → matches the 13:00–17:00 window
    const nyMorning = withinTradingHours({ windows, timezone: 'America/New_York', at: new Date('2026-03-02T14:00:00.000Z') });
    expect(nyMorning).toBe(true);
    // …while 09:00 UTC is 04:00 in New York → outside
    const londonMorning = withinTradingHours({ windows, timezone: 'America/New_York', at: new Date('2026-03-02T09:00:00.000Z') });
    expect(londonMorning).toBe(false);
  });

  it('treats a window that wraps midnight as overnight', () => {
    const overnight = [{ day: 1 as const, start: '22:00', end: '02:00' }];
    expect(withinTradingHours({ windows: overnight, timezone: 'UTC', at: new Date('2026-03-02T23:00:00.000Z') })).toBe(true);
    expect(withinTradingHours({ windows: overnight, timezone: 'UTC', at: new Date('2026-03-03T01:00:00.000Z') })).toBe(true);
    expect(withinTradingHours({ windows: overnight, timezone: 'UTC', at: new Date('2026-03-03T03:00:00.000Z') })).toBe(false);
  });

  it('computes the daily reset instant in the configured timezone', () => {
    const reset = dailyResetInstant('00:00', 'America/New_York', new Date('2026-03-04T10:00:00.000Z'));
    expect(reset.toISOString()).toBe('2026-03-04T05:00:00.000Z'); // 00:00 EST
  });
});

describe('trade filters', () => {
  const subject = { masterSymbol: 'EURUSD', slaveSymbol: 'EURUSD.a', side: 'buy' as const, volume: 0.5, magic: 42, comment: 'MyEA v2' };

  it('allows everything by default', () => {
    expect(evaluateFilters(subject, DEFAULT_TRADE_FILTERS).allowed).toBe(true);
  });

  it('supports magic allow-lists and deny-lists', () => {
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, magic: { mode: 'copy', values: [42] } }).allowed).toBe(true);
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, magic: { mode: 'copy', values: [7] } })).toMatchObject({
      allowed: false,
      code: 'FILTERED_MAGIC',
    });
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, magic: { mode: 'ignore', values: [42] } })).toMatchObject({
      allowed: false,
      code: 'FILTERED_MAGIC',
    });
  });

  it('matches comments case-insensitively as substrings', () => {
    const allowed = evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, comment: { mode: 'copy', values: ['myea'] } });
    expect(allowed.allowed).toBe(true);
    const blocked = evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, comment: { mode: 'copy', values: ['scalper'] } });
    expect(blocked).toMatchObject({ allowed: false, code: 'FILTERED_COMMENT' });
  });

  it('filters by side and by lot range', () => {
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, side: 'sell' })).toMatchObject({ allowed: false, code: 'FILTERED_SIDE' });
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, side: 'buy' }).allowed).toBe(true);
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, lot: { min: null, max: 0.1 } }),
    ).toMatchObject({ allowed: false, code: 'FILTERED_LOT' });
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, lot: { min: 1, max: null } }),
    ).toMatchObject({ allowed: false, code: 'FILTERED_LOT' });
    expect(evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, lot: { min: 0.1, max: 1 } }).allowed).toBe(true);
  });

  it('includes or excludes symbols, accepting either the master or the slave name', () => {
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, symbol: { mode: 'include', values: ['EURUSD'] } }).allowed,
    ).toBe(true);
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, symbol: { mode: 'include', values: ['GBPUSD'] } }),
    ).toMatchObject({ allowed: false, code: 'FILTERED_SYMBOL' });
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, symbol: { mode: 'exclude', values: ['EURUSD.a'] } }),
    ).toMatchObject({ allowed: false, code: 'FILTERED_SYMBOL' });
    expect(
      evaluateFilters(subject, { ...DEFAULT_TRADE_FILTERS, symbol: { mode: 'exclude', values: ['GBPUSD'] } }).allowed,
    ).toBe(true);
  });
});
