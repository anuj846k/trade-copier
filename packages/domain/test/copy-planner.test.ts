import { describe, expect, it } from 'vitest';
import { planCopy } from '../src/index.js';
import {
  closeEvent,
  context,
  FIXED_NOW,
  masterSnapshot,
  modifyEvent,
  openEvent,
  partialCloseEvent,
  quote,
  settings,
  symbolInfo,
} from './helpers.js';

/**
 * Copy-planner oracle suite (FEATURES.md §2).
 *
 * Each `it` maps to a documented behaviour of the reference product. The
 * planner is a pure function, so these tests double as the specification of
 * what a "copy decision" means in this codebase.
 */

describe('gate order', () => {
  it('ignores new trades while the copier is disabled', () => {
    const decision = planCopy(openEvent(), context({ copierStatus: 'disabled' }));
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('COPIER_DISABLED');
  });

  it('still mirrors closes in "Disabled – Monitor Existing" mode', () => {
    const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };
    const skippedOpen = planCopy(openEvent(), context({ copierStatus: 'disabled_monitor_existing' }));
    expect(skippedOpen.code).toBe('COPIER_DISABLED');

    const close = planCopy(closeEvent(), context({ copierStatus: 'disabled_monitor_existing', link }));
    expect(close.action).toBe('close');
    expect(close.params?.ticket).toBe('9001');
  });

  it('ignores trades while the slave is disabled or disconnected', () => {
    const disabled = planCopy(openEvent(), context({ settings: settings({ enabled: false }) }));
    expect(disabled.code).toBe('FOLLOWER_DISABLED');

    const offline = planCopy(
      openEvent(),
      context({
        account: {
          accountId: 'acc_slave',
          currency: 'USD',
          balance: 10_000,
          equity: 10_000,
          freeMargin: 10_000,
          leverage: 100,
          enabled: true,
          connected: false,
          disabledSymbols: [],
        },
      }),
    );
    expect(offline.code).toBe('ACCOUNT_DISCONNECTED');
  });

  it('blocks new entries while Equity Protection is active, but not exits', () => {
    const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };
    expect(planCopy(openEvent(), context({ equityProtectionActive: true })).code).toBe('EQUITY_PROTECTION');
    expect(planCopy(closeEvent(), context({ equityProtectionActive: true, link })).action).toBe('close');
  });

  it('reports a missing mapping with the documented error code', () => {
    const decision = planCopy(openEvent(), context({ slaveSymbol: null }));
    expect(decision.code).toBe('SYMBOL_NOT_MAPPED');
    expect(decision.detail).toBeTruthy();
  });

  it('reports an ambiguous mapping as a mismatch that needs a choice', () => {
    const decision = planCopy(
      openEvent(),
      context({
        slaveSymbol: null,
        symbolResolution: {
          slaveSymbol: null,
          strategy: 'unmapped',
          ambiguous: true,
          reason: 'Broker offers 2 variants of EURUSD: EURUSD.a, EURUSDm. Select the suffix you trade.',
        },
      }),
    );
    expect(decision.code).toBe('SYMBOL_MISMATCH');
  });

  it('ignores trades in symbols disabled on the slave account', () => {
    const byAccountToggle = planCopy(
      openEvent(),
      context({
        account: {
          accountId: 'acc_slave',
          currency: 'USD',
          balance: 10_000,
          equity: 10_000,
          freeMargin: 10_000,
          leverage: 100,
          enabled: true,
          connected: true,
          disabledSymbols: ['EURUSD.a'],
        },
      }),
    );
    expect(byAccountToggle.code).toBe('SYMBOL_DISABLED');

    const bySymbolFlag = planCopy(openEvent(), context({ slaveSymbol: symbolInfo({ enabled: false }) }));
    expect(bySymbolFlag.code).toBe('SYMBOL_DISABLED');
  });

  it('respects the broker trade mode (long-only / disabled)', () => {
    const longOnly = planCopy(openEvent(), context({ slaveSymbol: symbolInfo({ tradeMode: 'long_only' }) }));
    expect(longOnly.action).toBe('open');
    expect(longOnly.params?.side).toBe('buy');

    const blockedSell = planCopy(
      openEvent({ side: 'sell' }),
      context({ slaveSymbol: symbolInfo({ tradeMode: 'long_only' }) }),
    );
    expect(blockedSell.code).toBe('TRADE_DISABLED');
  });
});

describe('sizing', () => {
  it('copies 1:1 at 100%', () => {
    const decision = planCopy(openEvent(), context());
    expect(decision.action).toBe('open');
    expect(decision.params?.volume).toBeCloseTo(0.1, 8);
  });

  it('halves at 50% and applies min-lot clamping only when forced', () => {
    const halved = planCopy(openEvent(), context({ settings: settings({ riskValue: 50 }) }));
    expect(halved.params?.volume).toBeCloseTo(0.05, 8);

    const tiny = planCopy(
      openEvent({ volume: 0.01 }),
      context({ settings: settings({ riskValue: 50 }) }),
    );
    // 0.005 rounds to 0.01 at a 0.01 step, which is the symbol minimum
    expect(tiny.params?.volume).toBeCloseTo(0.01, 8);
  });

  it('caps volume at the broker per-order limit and warns', () => {
    const decision = planCopy(
      openEvent({ volume: 5 }),
      context({ slaveSymbol: symbolInfo({ maxLotPerOrder: 2 }) }),
    );
    expect(decision.params?.volume).toBeCloseTo(2, 8);
    expect(decision.warnings.join(' ')).toMatch(/per-order cap/);
  });

  it('fails loudly when the computed volume is not tradable', () => {
    const decision = planCopy(openEvent({ volume: 1 }), context({ slaveSymbol: symbolInfo({ maxLot: 0.5 }) }));
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('INVALID_VOLUME');
  });

  it('sizes Fixed % Risk from the master stop distance', () => {
    // 2% of 10 000 USD = 200 USD; SL 50 pips → 50 × 10 = 500 USD/lot → 0.4 lots
    const decision = planCopy(
      openEvent({ stopLoss: 1.095 }),
      context({ settings: settings({ riskType: 'FIXED_PERCENT_RISK', riskValue: 2 }) }),
    );
    expect(decision.action).toBe('open');
    expect(decision.params?.volume).toBeCloseTo(0.4, 8);
  });

  it('refuses Fixed % Risk without a stop loss', () => {
    const decision = planCopy(
      openEvent({ stopLoss: null }),
      context({ settings: settings({ riskType: 'FIXED_PERCENT_RISK', riskValue: 2, fixedStopLossPips: null }) }),
    );
    expect(decision.code).toBe('VALIDATION');
  });
});

describe('stop loss and take profit translation', () => {
  it('converts the master SL into the same pip distance on the slave price', () => {
    // master bought 1.1000, SL 1.0950 (50 pips). Slave ask is 1.20000.
    const decision = planCopy(
      openEvent({ openPrice: 1.1, stopLoss: 1.095 }),
      context({ quotes: quote({ bid: 1.2, ask: 1.20008 }) }),
    );
    expect(decision.action).toBe('open');
    // 50 pips below the price the slave will actually trade at (ask 1.20008)
    expect(decision.params?.stopLoss).toBeCloseTo(1.19508, 6);
  });

  it('widens the distance with a positive SL refiner and narrows with a negative one', () => {
    const widened = planCopy(
      openEvent({ openPrice: 1.1, stopLoss: 1.095 }),
      context({ settings: settings({ stopLossRefinePips: 10 }) }),
    );
    expect(widened.params?.stopLoss).toBeCloseTo(1.09408, 6); // 60 pips below 1.10008

    const narrowed = planCopy(
      openEvent({ openPrice: 1.1, stopLoss: 1.095 }),
      context({ settings: settings({ stopLossRefinePips: -20 }) }),
    );
    expect(narrowed.params?.stopLoss).toBeCloseTo(1.09708, 6); // 30 pips below 1.10008
  });

  it('applies fixed SL/TP pips when the master has none', () => {
    const decision = planCopy(
      openEvent({ stopLoss: null, takeProfit: null }),
      context({ settings: settings({ fixedStopLossPips: 20, fixedTakeProfitPips: 40 }) }),
    );
    expect(decision.params?.stopLoss).toBeCloseTo(1.09808, 6);
    expect(decision.params?.takeProfit).toBeCloseTo(1.10408, 6);
  });

  it('drops SL/TP when copying is switched off', () => {
    const decision = planCopy(
      openEvent({ stopLoss: 1.095, takeProfit: 1.11 }),
      context({ settings: settings({ copyStopLoss: false, copyTakeProfit: false }) }),
    );
    expect(decision.params?.stopLoss).toBeNull();
    expect(decision.params?.takeProfit).toBeNull();
  });

  it('rejects stops that are on the wrong side of the market', () => {
    const decision = planCopy(
      openEvent({ openPrice: 1.1, stopLoss: 1.2 }), // SL above the price for a buy
      context({ settings: settings({ copyTakeProfit: false }) }),
    );
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('INVALID_SLTP');
  });

  it('rejects stops closer than the broker minimum distance', () => {
    const decision = planCopy(
      openEvent({ openPrice: 1.1, stopLoss: 1.0999 }), // 1 pip
      context({ minStopDistancePips: 10, settings: settings({ copyTakeProfit: false }) }),
    );
    expect(decision.code).toBe('INVALID_SLTP');
  });
});

describe('reverse trade', () => {
  it('flips the side and refuses to combine with SL/TP copying', () => {
    const decision = planCopy(
      openEvent({ side: 'buy', stopLoss: 1.095, takeProfit: 1.11 }),
      context({ settings: settings({ reverseTrade: true }) }),
    );
    expect(decision.action).toBe('open');
    expect(decision.params?.side).toBe('sell');
    expect(decision.params?.stopLoss).toBeNull();
    expect(decision.params?.takeProfit).toBeNull();
    expect(decision.warnings.join(' ')).toMatch(/Reverse Trade cannot be combined/i);
  });
});

describe('strict close', () => {
  const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: 1.095, tp: null, seq: 1 };

  it('ignores master closes but keeps managing SL/TP', () => {
    const close = planCopy(closeEvent(), context({ settings: settings({ strictClose: true }), link }));
    expect(close.action).toBe('skip');
    expect(close.code).toBe('STRICT_CLOSE_IGNORED');

    const modify = planCopy(
      modifyEvent({ stopLoss: 1.09 }),
      context({ settings: settings({ strictClose: true }), link }),
    );
    expect(modify.action).toBe('modify');
    // 1.09 is 100 pips under the master entry (1.1); the slave entry is also
    // 1.1, so the mirrored level is identical.
    expect(modify.params?.stopLoss).toBeCloseTo(1.09, 6);
  });
});

describe('closes and partial closes', () => {
  const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };

  it('closes the slave position with the master ticket mapping', () => {
    const decision = planCopy(closeEvent(), context({ link }));
    expect(decision.action).toBe('close');
    expect(decision.kind).toBe('close');
    expect(decision.params?.ticket).toBe('9001');
    expect(decision.params?.volume).toBeCloseTo(0.1, 8);
    expect(decision.requestId).toBeTruthy();
  });

  it('never closes a trade that was never copied', () => {
    const decision = planCopy(closeEvent(), context({ link: null }));
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('NOT_COPIED');
  });

  it('mirrors a partial close proportionally', () => {
    // master closed 0.05 of 0.10 → slave should close 50% of 0.10 = 0.05
    const decision = planCopy(
      partialCloseEvent(0.05, { volume: 0.05 }),
      context({ link }),
    );
    expect(decision.action).toBe('close_partial');
    expect(decision.params?.volume).toBeCloseTo(0.05, 8);
  });

  it('escalates to a full close when the fraction would leave dust', () => {
    const dustLink = { slaveTicket: '9003', volume: 0.01, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };
    const decision = planCopy(partialCloseEvent(0.005, { volume: 0.095 }), context({ link: dustLink }));
    // 50% of a 0.01 slave is below the 0.01 step: the slave is closed instead.
    expect(decision.action).toBe('close');
    expect(decision.params?.volume).toBeCloseTo(0.01, 8);
  });
});

describe('modify handling', () => {
  const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: 1.095, tp: null, seq: 3 };

  it('sends a modify when the master moves its SL', () => {
    const decision = planCopy(modifyEvent({ stopLoss: 1.098 }), context({ link }));
    expect(decision.action).toBe('modify');
    expect(decision.params?.ticket).toBe('9001');
    expect(decision.params?.stopLoss).toBeCloseTo(1.098, 6);
    expect(decision.seq).toBe(4);
  });

  it('suppresses duplicate modifies', () => {
    const decision = planCopy(modifyEvent({ stopLoss: 1.095 }), context({ link }));
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('DUPLICATE_REQUEST');
  });

  it('ignores modifies for trades that were never copied', () => {
    const decision = planCopy(modifyEvent({ stopLoss: 1.09 }), context({ link: null }));
    expect(decision.code).toBe('NOT_COPIED');
  });
});

describe('pending orders', () => {
  const pending = {
    kind: 'pending' as const,
    pendingType: 'buy_limit' as const,
    openPrice: 1.09,
    stopLoss: 1.085,
    volume: 0.1,
  };

  it('defers pending orders while Copy Pending Orders is off', () => {
    const decision = planCopy({ kind: 'pending_placed', trade: masterSnapshot(pending), at: FIXED_NOW }, context());
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('PENDING_DEFERRED');
  });

  it('replicates the pending order when enabled', () => {
    const decision = planCopy(
      { kind: 'pending_placed', trade: masterSnapshot(pending), at: FIXED_NOW },
      context({ settings: settings({ copyPendingOrders: true }) }),
    );
    expect(decision.action).toBe('place_pending');
    expect(decision.kind).toBe('place_pending');
    expect(decision.params?.pendingType).toBe('buy_limit');
    expect(decision.params?.price).toBeCloseTo(1.09, 6);
  });

  it('cancels the slave pending order when the master cancels', () => {
    const link = { slaveTicket: '9002', volume: 0.1, openPrice: 1.09, status: 'pending' as const, sl: null, tp: null, seq: 1 };
    const decision = planCopy(
      { kind: 'pending_cancelled', trade: masterSnapshot(pending), at: FIXED_NOW },
      context({ settings: settings({ copyPendingOrders: true }), link }),
    );
    expect(decision.action).toBe('cancel_pending');
    expect(decision.params?.ticket).toBe('9002');
  });
});

describe('market and schedule gates', () => {
  const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };

  it('defers the entry while the market is closed, freeing it when it reopens', () => {
    const decision = planCopy(
      openEvent(),
      context({
        marketState: { open: false, reason: 'weekend', nextOpenAt: '2026-03-08T22:00:00.000Z', nextCloseAt: null },
      }),
    );
    expect(decision.action).toBe('defer');
    expect(decision.code).toBe('MARKET_CLOSED');
    expect(decision.deferredUntil).toBe('2026-03-08T22:00:00.000Z');
  });

  it('still closes positions while the market is closed', () => {
    const decision = planCopy(
      closeEvent(),
      context({ link, marketState: { open: false, reason: 'weekend', nextOpenAt: '2026-03-08T22:00:00.000Z', nextCloseAt: null } }),
    );
    expect(decision.action).toBe('close');
  });

  it('gates new entries on trading hours but never blocks management', () => {
    const outsideMonday = new Date('2026-03-02T02:00:00.000Z'); // 02:00 UTC, outside 08:00–17:00
    const decision = planCopy(
      openEvent(),
      context({
        now: outsideMonday,
        settings: settings({
          tradingHoursEnabled: true,
          timezone: 'UTC',
          tradingHours: [{ day: 1, start: '08:00', end: '17:00' }],
        }),
        quotes: quote({ at: outsideMonday.toISOString() }),
      }),
    );
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('OUTSIDE_TRADING_HOURS');

    const close = planCopy(
      closeEvent(),
      context({
        link,
        now: outsideMonday,
        settings: settings({
          tradingHoursEnabled: true,
          timezone: 'UTC',
          tradingHours: [{ day: 1, start: '08:00', end: '17:00' }],
        }),
      }),
    );
    expect(close.action).toBe('close');
  });

  it('rejects entries on stale quotes', () => {
    const decision = planCopy(
      openEvent(),
      context({ quotes: quote({ at: new Date(FIXED_NOW.getTime() - 30_000).toISOString() }) }),
    );
    expect(decision.code).toBe('STALE_QUOTE');
  });

  it('rejects entries on a spread wider than the follower allows', () => {
    const decision = planCopy(
      openEvent(),
      context({ settings: settings({ maxSpreadPips: 1 }), quotes: quote({ bid: 1.1, ask: 1.1005 }) }),
    );
    expect(decision.code).toBe('SPREAD_TOO_WIDE');
  });
});

describe('filters and identity', () => {
  it('honours the symbol filter', () => {
    const decision = planCopy(
      openEvent(),
      context({ settings: settings({ filters: { symbol: { mode: 'exclude', values: ['EURUSD'] } } }) }),
    );
    expect(decision.code).toBe('FILTERED_SYMBOL');
  });

  it('honours the magic filter', () => {
    const decision = planCopy(openEvent(), context({ settings: settings({ filters: { magic: { mode: 'copy', values: [99] } } }) }));
    expect(decision.code).toBe('FILTERED_MAGIC');
  });

  it('passes the master magic through by default and derives one when missing', () => {
    const passthrough = planCopy(openEvent({ magic: 4242 }), context());
    expect(passthrough.params?.magic).toBe(4242);

    const derived = planCopy(openEvent({ magic: 0 }), context());
    expect(derived.params?.magic).toBeGreaterThan(0);
    expect(derived.warnings.join(' ')).toMatch(/derived magic/);
  });

  it('produces deterministic request ids for the same intent', () => {
    const first = planCopy(openEvent(), context());
    const second = planCopy(openEvent(), context());
    expect(first.requestId).toBe(second.requestId);
  });

  it('never re-opens a trade that is already copied', () => {
    const link = { slaveTicket: '9001', volume: 0.1, openPrice: 1.1, status: 'open' as const, sl: null, tp: null, seq: 1 };
    const decision = planCopy(openEvent(), context({ link }));
    expect(decision.action).toBe('skip');
    expect(decision.code).toBe('DUPLICATE_REQUEST');
  });

  it('retries a previously failed copy', () => {
    const link = { slaveTicket: '', volume: 0, openPrice: 0, status: 'failed' as const, sl: null, tp: null, seq: 1 };
    const decision = planCopy(openEvent(), context({ link }));
    expect(decision.action).toBe('open');
    expect(decision.seq).toBe(2);
  });

  it('explains itself in the decision trace', () => {
    const decision = planCopy(openEvent({ stopLoss: 1.095 }), context({ settings: settings({ stopLossRefinePips: 5 }) }));
    expect(decision.trace.length).toBeGreaterThan(2);
    expect(decision.trace.some((step) => step.outcome === 'adjust')).toBe(true);
    expect(JSON.stringify(decision.trace)).toMatch(/stop loss/);
  });

  it('applies the configured entry delay', () => {
    const delayed = planCopy(
      openEvent(),
      context({ settings: settings({ tradeDelayMsMin: 500, tradeDelayMsMax: 500 }), random: () => 0.5 }),
    );
    expect(delayed.delayMs).toBe(500);
  });
});
