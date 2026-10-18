import Decimal from 'decimal.js';
import type {
  CommandKind,
  CommandParams,
  CopierErrorCode,
  CopierStatus,
  FollowerSettings,
  SymbolInfo,
  TradeSide,
} from '@trade-copier/contracts';
import { normalizePrice, pipDistance, pipValuePerLot, priceToPips, applyPipDistance, stopLossSideFor, takeProfitSideFor, type RateSource } from './pips.js';
import { normalizeVolume, proportionalCloseVolume, type VolumeConstraints } from './lots.js';
import { computeRiskVolume } from './risk.js';
import { evaluateFilters } from './filters.js';
import { checkQuote, sideAllowedByTradeMode, validateStops } from './market.js';
import { withinTradingHours, type MarketState } from './market-hours.js';
import { copyRequestId, resolveMagic, shortTag, tradeDelayMs } from './ids.js';
import type { MasterEvent } from './trades.js';

/**
 * The copy planner.
 *
 * Pure function: `planCopy(event, context) -> CopyDecision`.
 *
 * No I/O, no clock, no randomness beyond an injected `random` — which is why
 * the entire copy rule set is unit-testable and why the copier log can show a
 * deterministic, replayable trail of *why* a trade was copied, skipped,
 * deferred or rejected.
 *
 * Gate order is deliberate: cheap/absolute gates first (copier state, follower
 * state, symbol resolution), then policy gates (filters, schedule), then
 * market gates (market hours, quote quality), and only then sizing — the most
 * expensive and least certain step.
 */
export interface SlaveAccountContext {
  readonly accountId: string;
  readonly currency: string;
  readonly balance: number;
  readonly equity: number;
  readonly freeMargin: number;
  readonly leverage: number | null;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly disabledSymbols: readonly string[];
}

export interface LinkContext {
  readonly slaveTicket: string;
  /** Currently open volume on the slave for this master trade. */
  readonly volume: number;
  /** Price the slave position was actually opened at (its own entry price). */
  readonly openPrice: number;
  readonly status: 'pending' | 'open' | 'closed' | 'failed' | 'skipped' | 'partial';
  readonly sl: number | null;
  readonly tp: number | null;
  readonly seq: number;
}

export interface PlanContext {
  readonly copierId: string;
  readonly copierStatus: CopierStatus;
  readonly followerId: string;
  /** Settings after per-symbol override merging. */
  readonly settings: FollowerSettings;
  readonly account: SlaveAccountContext;
  /** Resolved slave symbol, or null when the mapping is missing/ambiguous. */
  readonly slaveSymbol: SymbolInfo | null;
  readonly symbolResolution: {
    readonly slaveSymbol: string | null;
    readonly strategy: string;
    readonly ambiguous: boolean;
    readonly reason?: string | undefined;
  };
  /** Symbol metadata of the master side, needed for contract alignment. */
  readonly masterSymbolInfo: Pick<SymbolInfo, 'digits' | 'point' | 'pipSize' | 'contractSize'>;
  /**
   * Master balance used by the balance-multiplier risk types. The engine passes
   * the balance captured when the copier was created (or the live balance when
   * no snapshot exists) so sizing is stable within a session.
   */
  readonly masterBalanceForRisk: number;
  readonly link: LinkContext | null;
  readonly quotes: { readonly bid: number; readonly ask: number; readonly at: string } | null;
  readonly marketState: MarketState | null;
  /** True when Equity Protection has fired for the slave account. */
  readonly equityProtectionActive: boolean;
  readonly now: Date;
  readonly rates?: RateSource | undefined;
  /** Broker minimum stop distance for the slave symbol, in pips. */
  readonly minStopDistancePips?: number | null;
  /** Sequence number to use for the new command (defaults to link.seq + 1). */
  readonly intentSeq?: number | undefined;
  readonly random?: (() => number) | undefined;
}

export type DecisionAction =
  | 'open'
  | 'close'
  | 'close_partial'
  | 'modify'
  | 'place_pending'
  | 'cancel_pending'
  | 'skip'
  | 'defer';

export interface DecisionStep {
  readonly step: string;
  readonly outcome: 'pass' | 'skip' | 'defer' | 'adjust' | 'reject';
  readonly detail?: string;
}

export interface PlanDecision {
  readonly action: DecisionAction;
  readonly code?: CopierErrorCode;
  readonly detail?: string;
  readonly requestId?: string;
  readonly seq?: number;
  readonly kind?: CommandKind;
  readonly params?: CommandParams;
  readonly volume?: number;
  readonly warnings: readonly string[];
  readonly trace: readonly DecisionStep[];
  /** When deferring, the earliest instant worth retrying. */
  readonly deferredUntil?: string | null;
  readonly delayMs?: number;
  readonly derivedMagic?: number;
}

export function planCopy(event: MasterEvent, context: PlanContext): PlanDecision {
  const builder = new DecisionBuilder();
  const { settings, account } = context;

  // -------------------------------------------------------------------------
  // 1. Copier state
  // -------------------------------------------------------------------------
  const isOpening = event.kind === 'open' || event.kind === 'pending_placed' || event.kind === 'pending_modified';
  if (context.copierStatus === 'disabled') {
    return builder.skip('COPIER_DISABLED', 'Copier status is disabled — all trade actions are ignored');
  }
  if (context.copierStatus === 'paused' && isOpening) {
    return builder.skip('COPIER_DISABLED', 'Copier is paused');
  }
  if (context.copierStatus === 'disabled_monitor_existing' && isOpening) {
    return builder.skip('COPIER_DISABLED', 'Copier is set to Disabled - Monitor Existing, so new trades are ignored');
  }
  builder.pass('copier status', context.copierStatus);

  // -------------------------------------------------------------------------
  // 2. Follower + account state
  // -------------------------------------------------------------------------
  if (!settings.enabled) return builder.skip('FOLLOWER_DISABLED', 'Slave is disabled');
  if (!account.enabled) return builder.skip('ACCOUNT_DISABLED', 'Trading account is disabled');
  if (!account.connected) return builder.skip('ACCOUNT_DISCONNECTED', 'Trading account is not connected');
  builder.pass('slave account', account.accountId);

  if (context.equityProtectionActive && isOpening) {
    return builder.skip('EQUITY_PROTECTION', 'Equity Protection is active for this account');
  }

  // -------------------------------------------------------------------------
  // 3. Symbol resolution
  // -------------------------------------------------------------------------
  if (isOpening || event.kind === 'modify' || event.kind === 'pending_cancelled') {
    if (!context.slaveSymbol) {
      const code: CopierErrorCode = context.symbolResolution.ambiguous ? 'SYMBOL_MISMATCH' : 'SYMBOL_NOT_MAPPED';
      return builder.skip(
        code,
        context.symbolResolution.reason ??
          `No slave symbol for ${event.trade.symbol} (strategy: ${context.symbolResolution.strategy})`,
      );
    }
    if (!context.slaveSymbol.enabled) {
      return builder.skip('SYMBOL_DISABLED', `${context.slaveSymbol.name} is disabled on this trading account`);
    }
    if (context.account.disabledSymbols.some((s) => s.toLowerCase() === context.slaveSymbol!.name.toLowerCase())) {
      return builder.skip('SYMBOL_DISABLED', `${context.slaveSymbol.name} is disabled on this trading account`);
    }
    builder.pass('symbol mapping', `${event.trade.symbol} -> ${context.slaveSymbol.name} (${context.symbolResolution.strategy})`);
  }

  const slaveSymbol = context.slaveSymbol;
  const side: TradeSide = settings.reverseTrade ? (event.trade.side === 'buy' ? 'sell' : 'buy') : event.trade.side;
  if (slaveSymbol && isOpening && !sideAllowedByTradeMode(slaveSymbol.tradeMode, side)) {
    return builder.skip('TRADE_DISABLED', `${slaveSymbol.name} does not allow ${side} trades (mode: ${slaveSymbol.tradeMode})`);
  }

  // -------------------------------------------------------------------------
  // 4. Policy gates — filters and schedule (new entries only)
  // -------------------------------------------------------------------------
  if (isOpening) {
    const filterOutcome = evaluateFilters(
      {
        masterSymbol: event.trade.symbol,
        slaveSymbol: slaveSymbol?.name ?? null,
        side: event.trade.side,
        volume: event.trade.volume,
        magic: event.trade.magic,
        comment: event.trade.comment,
      },
      settings.filters,
    );
    if (!filterOutcome.allowed) {
      return builder.skip(filterOutcome.code ?? 'FILTERED_SYMBOL', filterOutcome.detail ?? 'Excluded by trade filters');
    }
    builder.pass('trade filters');

    if (settings.tradingHoursEnabled && settings.tradingHours.length > 0) {
      const inWindow = withinTradingHours({
        windows: settings.tradingHours,
        timezone: settings.timezone,
        at: context.now,
      });
      if (!inWindow) {
        return builder.skip(
          'OUTSIDE_TRADING_HOURS',
          `Outside the configured trading hours (${settings.timezone}); existing trades are still managed`,
        );
      }
      builder.pass('trading hours', settings.timezone);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Market gates
  // -------------------------------------------------------------------------
  if (isOpening && context.marketState && !context.marketState.open) {
    // Documented behaviour: copying is retried for the retry window instead of
    // failing immediately (docs `trade-copier/error-codes`, MARKET_CLOSED).
    return builder.defer(
      'MARKET_CLOSED',
      `Market is closed (${context.marketState.reason}); retrying until the venue reopens`,
      context.marketState.nextOpenAt,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Dispatch by event kind
  // -------------------------------------------------------------------------
  switch (event.kind) {
    case 'open':
    case 'pending_filled':
      return planOpen(event, context, builder, side);
    case 'modify':
      return planModify(event, context, builder, side);
    case 'close':
      return planClose(event, context, builder);
    case 'partial_close':
      return planPartialClose(event, context, builder);
    case 'pending_placed':
    case 'pending_modified':
      return planPending(event, context, builder, side);
    case 'pending_cancelled':
      return planPendingCancel(event, context, builder);
    default:
      return builder.skip('NOT_IMPLEMENTED', `Unsupported master event ${String(event.kind)}`);
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

function planOpen(
  event: MasterEvent,
  context: PlanContext,
  builder: DecisionBuilder,
  side: TradeSide,
): PlanDecision {
  const { settings, slaveSymbol, account } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');
  const trade = event.trade;

  if (context.link && (context.link.status === 'open' || context.link.status === 'pending' || context.link.status === 'partial')) {
    return builder.skip('DUPLICATE_REQUEST', `Master trade ${trade.ticket} is already copied to this slave`);
  }

  // --- sizing --------------------------------------------------------------
  const slDistancePips =
    trade.stopLoss !== null ? pipDistance(trade.openPrice, trade.stopLoss, context.masterSymbolInfo.pipSize) : null;

  const risk = computeRiskVolume({
    riskType: settings.riskType,
    riskValue: settings.riskValue,
    masterVolume: trade.volume,
    masterBalance: context.masterBalanceForRisk,
    slaveBalance: account.balance,
    fixedMasterBalance: settings.fixedMasterBalance,
    stopLossDistancePips:
      settings.riskType === 'FIXED_PERCENT_RISK'
        ? (slDistancePips ?? settings.fixedStopLossPips)
        : slDistancePips,
    masterContractSize: context.masterSymbolInfo.contractSize,
    slaveContractSize: slaveSymbol.contractSize,
    masterPipSize: context.masterSymbolInfo.pipSize,
    slavePipSize: slaveSymbol.pipSize,
    slaveQuoteCurrency: slaveSymbol.quoteCurrency,
    slaveAccountCurrency: account.currency,
    contractAlignment: settings.contractAlignment,
    lotRefiner: settings.lotRefiner,
    rates: context.rates,
  });

  if (!risk.ok) {
    return builder.skip(risk.error.code, risk.error.detail);
  }
  for (const step of risk.value.steps) builder.adjust(`volume: ${step.label}`, step.value);
  for (const warning of risk.value.warnings) builder.warn(warning);

  const constraints: VolumeConstraints = {
    minLot: slaveSymbol.minLot,
    maxLot: slaveSymbol.maxLot,
    lotStep: slaveSymbol.lotStep,
    maxLotPerOrder: slaveSymbol.maxLotPerOrder,
  };
  const normalized = normalizeVolume({
    volume: risk.value.volume,
    constraints,
    forceMin: settings.forceMinLot,
    forceMax: settings.forceMaxLot,
  });
  if (!normalized.ok) return builder.skip(normalized.code, normalized.detail);
  for (const adjustment of normalized.adjustments) builder.adjust('volume adjustment', adjustment);

  let volume = normalized.volume;
  if (slaveSymbol.maxLotPerOrder !== null && volume > slaveSymbol.maxLotPerOrder) {
    builder.warn(
      `Volume ${volume} exceeds the broker per-order cap ${slaveSymbol.maxLotPerOrder}; the copy is capped. Split large orders across several trades.`,
    );
    volume = slaveSymbol.maxLotPerOrder;
  }
  builder.adjust('final volume', String(volume));

  // --- quote + slippage ----------------------------------------------------
  const quoteCheck = checkQuote(
    {
      quote: context.quotes,
      side,
      pipSize: slaveSymbol.pipSize,
      point: slaveSymbol.point,
      now: context.now,
      maxQuoteAgeMs: settings.maxQuoteAgeMs,
      maxSpreadPips: settings.maxSpreadPips,
    },
    settings.maxSlippagePips,
  );
  if (!quoteCheck.ok) return builder.skip(quoteCheck.code, quoteCheck.detail);
  builder.pass('quote', `spread ${quoteCheck.spreadPips.toFixed(2)} pips, age ${quoteCheck.quoteAgeMs}ms`);

  const referencePrice = quoteCheck.price;

  // --- SL / TP -------------------------------------------------------------
  const stops = computeStops({ event, context, side, slaveSymbol, referencePrice });
  for (const warning of stops.warnings) builder.warn(warning);
  for (const step of stops.trace) builder.adjust(step.step, step.detail ?? '');
  if (stops.invalid) return builder.skip('INVALID_SLTP', stops.invalid);

  const stopValidation = validateStops({
    side,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit,
    referencePrice,
    minStopDistancePips: context.minStopDistancePips ?? null,
    pipSize: slaveSymbol.pipSize,
  });
  if (!stopValidation.ok) return builder.skip(stopValidation.code, stopValidation.detail);

  // --- identity ------------------------------------------------------------
  const magic = resolveMagic({
    magicMode: settings.magicMode,
    customMagic: settings.customMagic,
    masterMagic: trade.magic,
    followerId: context.followerId,
  });
  if (magic.derived) builder.warn(`No magic on the master trade; using derived magic ${magic.magic} for reconciliation`);

  const seq = context.intentSeq ?? (context.link?.seq ?? 0) + 1;
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: trade.ticket,
    seq,
    kind: 'open',
  });

  const comment = resolveComment(settings, trade.comment, requestId);
  const delayMs = tradeDelayMs(settings.tradeDelayMsMin, settings.tradeDelayMsMax, context.random);

  const params: CommandParams = {
    symbol: slaveSymbol.name,
    side,
    volume,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit,
    maxSlippagePips: settings.maxSlippagePips,
    magic: magic.magic,
    comment,
  };

  builder.pass('decision', `open ${side} ${volume} ${slaveSymbol.name} @ market (deviation ${settings.maxSlippagePips} pips)`);
  return builder.build({
    action: 'open',
    kind: 'open',
    params,
    requestId,
    seq,
    volume,
    delayMs,
    derivedMagic: magic.magic,
  });
}

// ---------------------------------------------------------------------------
// modify
// ---------------------------------------------------------------------------

function planModify(event: MasterEvent, context: PlanContext, builder: DecisionBuilder, side: TradeSide): PlanDecision {
  const { settings, slaveSymbol } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');
  if (!context.link) return builder.skip('NOT_COPIED', `Master trade ${event.trade.ticket} was never copied to this slave`);
  if (context.link.status === 'failed' || context.link.status === 'closed') {
    return builder.skip('NOT_COPIED', `Slave position is ${context.link.status}; nothing to modify`);
  }

  // Modify decisions are measured from the slave's own entry price, exactly like
  // the original open: the master's SL/TP distance is expressed *from its entry*,
  // so mirroring it from the slave entry keeps the two positions equivalent and
  // makes duplicate detection immune to price drift between events.
  const referencePrice = context.link.openPrice;

  const stops = computeStops({
    event,
    context,
    side,
    slaveSymbol,
    referencePrice,
  });
  for (const warning of stops.warnings) builder.warn(warning);
  if (stops.invalid) return builder.skip('INVALID_SLTP', stops.invalid);

  const unchangedSl = approximatelyEqual(stops.stopLoss, context.link.sl);
  const unchangedTp = approximatelyEqual(stops.takeProfit, context.link.tp);
  if (unchangedSl && unchangedTp) {
    return builder.skip('DUPLICATE_REQUEST', 'Stop loss and take profit are unchanged since the last modify');
  }

  if (stops.stopLoss !== null && referencePrice !== null && referencePrice !== undefined && referencePrice > 0) {
    const validation = validateStops({
      side,
      stopLoss: stops.stopLoss,
      takeProfit: stops.takeProfit,
      referencePrice,
      minStopDistancePips: context.minStopDistancePips ?? null,
      pipSize: slaveSymbol.pipSize,
    });
    if (!validation.ok) return builder.skip(validation.code, validation.detail);
  }

  const seq = context.intentSeq ?? context.link.seq + 1;
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: event.trade.ticket,
    seq,
    kind: 'modify',
  });

  const params: CommandParams = {
    symbol: slaveSymbol.name,
    ticket: context.link.slaveTicket,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit,
    magic: resolveMagic({
      magicMode: settings.magicMode,
      customMagic: settings.customMagic,
      masterMagic: event.trade.magic,
      followerId: context.followerId,
    }).magic,
  };

  builder.pass('decision', `modify ${context.link.slaveTicket} (SL ${formatLevel(stops.stopLoss)}, TP ${formatLevel(stops.takeProfit)})`);
  return builder.build({ action: 'modify', kind: 'modify', params, requestId, seq });
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

function planClose(event: MasterEvent, context: PlanContext, builder: DecisionBuilder): PlanDecision {
  const { settings, slaveSymbol } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');

  if (settings.strictClose) {
    return builder.skip(
      'STRICT_CLOSE_IGNORED',
      'Strict Close is enabled: the slave position is left to its own stop loss / take profit',
    );
  }
  if (!context.link) return builder.skip('NOT_COPIED', `Master trade ${event.trade.ticket} was never copied to this slave`);
  if (context.link.status === 'closed') {
    return builder.skip('DUPLICATE_REQUEST', 'Slave position is already closed');
  }
  if (context.link.status === 'failed' || context.link.status === 'skipped') {
    return builder.skip('TICKET_NOT_FOUND', `No slave position to close (copy ${context.link.status})`);
  }

  const seq = context.intentSeq ?? context.link.seq + 1;
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: event.trade.ticket,
    seq,
    kind: 'close',
  });

  const params: CommandParams = {
    symbol: slaveSymbol.name,
    ticket: context.link.slaveTicket,
    volume: context.link.volume,
    maxSlippagePips: settings.maxSlippagePips,
  };

  builder.pass('decision', `close ${context.link.slaveTicket} (${context.link.volume} lots)`);
  return builder.build({ action: 'close', kind: 'close', params, requestId, seq, volume: context.link.volume });
}

// ---------------------------------------------------------------------------
// partial close
// ---------------------------------------------------------------------------

function planPartialClose(event: MasterEvent, context: PlanContext, builder: DecisionBuilder): PlanDecision {
  const { settings, slaveSymbol } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');
  if (!context.link || context.link.status !== 'open' && context.link.status !== 'partial') {
    return builder.skip('NOT_COPIED', 'No open slave position to partially close');
  }
  if (settings.strictClose) {
    return builder.skip('STRICT_CLOSE_IGNORED', 'Strict Close is enabled: partial closes are not mirrored');
  }

  const closedDelta = event.closedDeltaVolume ?? 0;
  if (!(closedDelta > 0)) {
    return builder.skip('VALIDATION', 'Partial close event carried no closed volume');
  }
  const masterTotalBefore = new Decimal(event.trade.volume).plus(closedDelta).toNumber();

  const proportional = proportionalCloseVolume(closedDelta, masterTotalBefore, context.link.volume, {
    minLot: slaveSymbol.minLot,
    maxLot: slaveSymbol.maxLot,
    lotStep: slaveSymbol.lotStep,
  });
  if (proportional.note) builder.adjust('partial close', proportional.note);

  const seq = context.intentSeq ?? context.link.seq + 1;
  const kind: CommandKind = proportional.closeAll ? 'close' : 'close_partial';
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: event.trade.ticket,
    seq,
    kind,
  });

  const params: CommandParams = {
    symbol: slaveSymbol.name,
    ticket: context.link.slaveTicket,
    volume: proportional.volume,
    maxSlippagePips: settings.maxSlippagePips,
  };

  builder.pass(
    'decision',
    `${proportional.closeAll ? 'close' : 'partial close'} ${proportional.volume} of ${context.link.volume} on ${context.link.slaveTicket}`,
  );
  return builder.build({
    action: proportional.closeAll ? 'close' : 'close_partial',
    kind,
    params,
    requestId,
    seq,
    volume: proportional.volume,
  });
}

// ---------------------------------------------------------------------------
// pending orders
// ---------------------------------------------------------------------------

function planPending(event: MasterEvent, context: PlanContext, builder: DecisionBuilder, side: TradeSide): PlanDecision {
  const { settings, slaveSymbol, account } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');

  if (!settings.copyPendingOrders) {
    // Documented: with the toggle off, the pending order is executed as a market
    // order on the slave once the master order fills. The fill arrives as a
    // `position.opened` event, which this planner handles as a normal open.
    return builder.skip(
      'PENDING_DEFERRED',
      `Pending ${event.trade.pendingType ?? 'order'} on ${event.trade.symbol} will be copied as a market order when it fills`,
    );
  }

  if (context.link && (context.link.status === 'open' || context.link.status === 'pending')) {
    return builder.skip('DUPLICATE_REQUEST', 'Pending order already copied');
  }
  if (event.trade.expiry !== null && new Date(event.trade.expiry).getTime() <= context.now.getTime()) {
    return builder.skip('ORDER_EXPIRED', `Pending order expiry ${event.trade.expiry} has passed`);
  }
  if (event.trade.pendingType === null || event.trade.openPrice === null) {
    return builder.skip('VALIDATION', 'Pending order is missing its type or price');
  }

  const risk = computeRiskVolume({
    riskType: settings.riskType,
    riskValue: settings.riskValue,
    masterVolume: event.trade.volume,
    masterBalance: context.masterBalanceForRisk,
    slaveBalance: account.balance,
    fixedMasterBalance: settings.fixedMasterBalance,
    stopLossDistancePips:
      event.trade.stopLoss !== null
        ? pipDistance(event.trade.openPrice, event.trade.stopLoss, context.masterSymbolInfo.pipSize)
        : settings.fixedStopLossPips,
    masterContractSize: context.masterSymbolInfo.contractSize,
    slaveContractSize: slaveSymbol.contractSize,
    masterPipSize: context.masterSymbolInfo.pipSize,
    slavePipSize: slaveSymbol.pipSize,
    slaveQuoteCurrency: slaveSymbol.quoteCurrency,
    slaveAccountCurrency: account.currency,
    contractAlignment: settings.contractAlignment,
    lotRefiner: settings.lotRefiner,
    rates: context.rates,
  });
  if (!risk.ok) return builder.skip(risk.error.code, risk.error.detail);
  for (const step of risk.value.steps) builder.adjust(`volume: ${step.label}`, step.value);

  const normalized = normalizeVolume({
    volume: risk.value.volume,
    constraints: {
      minLot: slaveSymbol.minLot,
      maxLot: slaveSymbol.maxLot,
      lotStep: slaveSymbol.lotStep,
      maxLotPerOrder: slaveSymbol.maxLotPerOrder,
    },
    forceMin: settings.forceMinLot,
    forceMax: settings.forceMaxLot,
  });
  if (!normalized.ok) return builder.skip(normalized.code, normalized.detail);

  const seq = context.intentSeq ?? (context.link?.seq ?? 0) + 1;
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: event.trade.ticket,
    seq,
    kind: 'place_pending',
  });

  const magic = resolveMagic({
    magicMode: settings.magicMode,
    customMagic: settings.customMagic,
    masterMagic: event.trade.magic,
    followerId: context.followerId,
  });

  const params: CommandParams = {
    symbol: slaveSymbol.name,
    side,
    volume: normalized.volume,
    price: normalizePrice(event.trade.openPrice, slaveSymbol.digits),
    stopLoss: event.trade.stopLoss,
    takeProfit: settings.copyTakeProfit ? event.trade.takeProfit : null,
    pendingType: event.trade.pendingType,
    expiry: settings.copyExpiryTime ? event.trade.expiry : null,
    magic: magic.magic,
    comment: resolveComment(settings, event.trade.comment, requestId),
    maxSlippagePips: settings.maxSlippagePips,
  };

  builder.pass('decision', `place ${event.trade.pendingType} ${normalized.volume} ${slaveSymbol.name} @ ${params.price}`);
  return builder.build({
    action: 'place_pending',
    kind: 'place_pending',
    params,
    requestId,
    seq,
    volume: normalized.volume,
    derivedMagic: magic.magic,
  });
}

function planPendingCancel(event: MasterEvent, context: PlanContext, builder: DecisionBuilder): PlanDecision {
  const { slaveSymbol } = context;
  if (!slaveSymbol) return builder.skip('SYMBOL_NOT_MAPPED', 'Slave symbol missing');
  if (!context.link || context.link.status !== 'pending') {
    return builder.skip('NOT_COPIED', 'No slave pending order for this master order');
  }
  const seq = context.intentSeq ?? context.link.seq + 1;
  const requestId = copyRequestId({
    copierId: context.copierId,
    followerId: context.followerId,
    masterTicket: event.trade.ticket,
    seq,
    kind: 'cancel_pending',
  });
  const params: CommandParams = { symbol: slaveSymbol.name, ticket: context.link.slaveTicket };
  builder.pass('decision', `cancel pending ${context.link.slaveTicket}`);
  return builder.build({ action: 'cancel_pending', kind: 'cancel_pending', params, requestId, seq });
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface StopsInput {
  readonly event: MasterEvent;
  readonly context: PlanContext;
  readonly side: TradeSide;
  readonly slaveSymbol: SymbolInfo;
  /** Price the slave will actually get (or last known price when modifying). */
  readonly referencePrice: number;
}

interface StopsResult {
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly warnings: readonly string[];
  readonly trace: ReadonlyArray<{ step: string; detail?: string }>;
  readonly invalid?: string;
}

/**
 * SL/TP translation across brokers.
 *
 * The master's SL is expressed as a *distance from the master entry*; the slave
 * gets the same distance applied to the price it will actually trade at. The
 * refiners widen (positive) or narrow (negative) that distance in pips, exactly
 * as documented.
 */
function computeStops(input: StopsInput): StopsResult {
  const { event, context, side, slaveSymbol, referencePrice } = input;
  const settings = context.settings;
  const warnings: string[] = [];
  const trace: Array<{ step: string; detail?: string }> = [];
  const trade = event.trade;

  if (settings.reverseTrade && (settings.copyStopLoss || settings.copyTakeProfit)) {
    warnings.push(
      'Reverse Trade cannot be combined with Copy Stop Loss / Copy Take Profit — the values would be inverted. They are dropped; the slave exits when the master exits.',
    );
  }

  const copyStops = !settings.reverseTrade;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  if (copyStops && settings.copyStopLoss) {
    const signedDistance =
      trade.stopLoss !== null ? priceToPips(trade.openPrice, trade.stopLoss, context.masterSymbolInfo.pipSize) : null;
    if (signedDistance !== null && (side === 'buy' ? signedDistance >= 0 : signedDistance <= 0)) {
      return {
        stopLoss: null,
        takeProfit: null,
        warnings,
        trace,
        invalid: `Master stop loss ${trade.stopLoss} is not ${side === 'buy' ? 'below' : 'above'} its entry ${trade.openPrice}`,
      };
    }
    const masterDistance = signedDistance === null ? null : Math.abs(signedDistance);
    const distance = masterDistance !== null ? masterDistance + settings.stopLossRefinePips : null;
    if (distance !== null) {
      stopLoss = applyPipDistance(referencePrice, distance, slaveSymbol.pipSize, stopLossSideFor(side), slaveSymbol.digits);
      trace.push({
        step: 'stop loss',
        detail: `${formatLevel(trade.stopLoss)} on the master -> ${distance.toFixed(1)} pips from ${formatLevel(referencePrice)}`,
      });
    }
  }

  if (copyStops && settings.copyTakeProfit) {
    const signedDistance =
      trade.takeProfit !== null ? priceToPips(trade.openPrice, trade.takeProfit, context.masterSymbolInfo.pipSize) : null;
    if (signedDistance !== null && (side === 'buy' ? signedDistance <= 0 : signedDistance >= 0)) {
      return {
        stopLoss: null,
        takeProfit: null,
        warnings,
        trace,
        invalid: `Master take profit ${trade.takeProfit} is not ${side === 'buy' ? 'above' : 'below'} its entry ${trade.openPrice}`,
      };
    }
    const masterDistance = signedDistance === null ? null : Math.abs(signedDistance);
    const distance = masterDistance !== null ? masterDistance + settings.takeProfitRefinePips : null;
    if (distance !== null) {
      takeProfit = applyPipDistance(referencePrice, distance, slaveSymbol.pipSize, takeProfitSideFor(side), slaveSymbol.digits);
      trace.push({
        step: 'take profit',
        detail: `${formatLevel(trade.takeProfit)} on the master -> ${distance.toFixed(1)} pips from ${formatLevel(referencePrice)}`,
      });
    }
  }

  // Fixed fallbacks (documented: applied regardless of whether the master has one).
  if (copyStops && stopLoss === null && settings.fixedStopLossPips !== null && settings.fixedStopLossPips > 0) {
    stopLoss = applyPipDistance(referencePrice, settings.fixedStopLossPips, slaveSymbol.pipSize, stopLossSideFor(side), slaveSymbol.digits);
    trace.push({ step: 'stop loss (fixed)', detail: `${settings.fixedStopLossPips} pips` });
  }
  if (copyStops && takeProfit === null && settings.fixedTakeProfitPips !== null && settings.fixedTakeProfitPips > 0) {
    takeProfit = applyPipDistance(referencePrice, settings.fixedTakeProfitPips, slaveSymbol.pipSize, takeProfitSideFor(side), slaveSymbol.digits);
    trace.push({ step: 'take profit (fixed)', detail: `${settings.fixedTakeProfitPips} pips` });
  }

  return { stopLoss, takeProfit, warnings, trace };
}

function resolveComment(settings: FollowerSettings, masterComment: string, requestId: string): string {
  switch (settings.commentMode) {
    case 'none':
      return '';
    case 'custom':
      return truncate(settings.customComment || shortTag(requestId), 31);
    case 'master':
    default:
      return truncate(masterComment ? `${masterComment}` : shortTag(requestId), 31);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function approximatelyEqual(a: number | null, b: number | null, tolerance = 1e-9): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tolerance;
}

function formatLevel(value: number | null): string {
  return value === null ? 'none' : new Decimal(value).toString();
}

class DecisionBuilder {
  private readonly trace: DecisionStep[] = [];
  private readonly warnings: string[] = [];

  pass(step: string, detail?: string): this {
    this.trace.push(detail === undefined ? { step, outcome: 'pass' } : { step, outcome: 'pass', detail });
    return this;
  }

  adjust(step: string, detail: string): this {
    this.trace.push({ step, outcome: 'adjust', detail });
    return this;
  }

  warn(message: string): this {
    this.warnings.push(message);
    return this;
  }

  skip(code: CopierErrorCode, detail: string): PlanDecision {
    this.trace.push({ step: 'decision', outcome: 'skip', detail: `${code}: ${detail}` });
    return {
      action: 'skip',
      code,
      detail,
      warnings: this.warnings,
      trace: this.trace,
    };
  }

  defer(code: CopierErrorCode, detail: string, deferredUntil: string | null): PlanDecision {
    this.trace.push({ step: 'decision', outcome: 'defer', detail: `${code}: ${detail}` });
    return {
      action: 'defer',
      code,
      detail,
      deferredUntil,
      warnings: this.warnings,
      trace: this.trace,
    };
  }

  build(partial: Omit<PlanDecision, 'warnings' | 'trace'>): PlanDecision {
    this.trace.push({ step: 'decision', outcome: 'pass', detail: partial.action });
    return { ...partial, warnings: this.warnings, trace: this.trace };
  }
}

/** Exposed for tests and the UI explainer. */
export function pipValueForSlaveSymbol(symbol: SymbolInfo): number {
  return pipValuePerLot(symbol.contractSize, symbol.pipSize);
}

export type { MasterEvent };
