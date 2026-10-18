import type { FastifyBaseLogger } from 'fastify';
import {
  errorMeta,
  type AccountSnapshot,
  type ClosedTrade,
  type CopierErrorCode,
  type PendingOrderType,
  type Position,
  type SymbolInfo,
} from '@trade-copier/contracts';
import {
  classifyAssetClass,
  closeEvent,
  derivePipSize,
  diffPosition,
  evaluateEquityProtection,
  isMarketOpen,
  planCopy,
  resolveSymbol,
  type MarketSessionConfig,
  type MasterEvent,
  type MasterTradeSnapshot,
  type PlanContext,
  type PlanDecision,
} from '@trade-copier/domain';
import {
  type AccountRecord,
  type CopierRecord,
  type FollowerWithOverrides,
  type MasterTradeRecord,
  type Repositories,
  type TradeLinkRecord,
} from '@trade-copier/db';
import type { Env } from '../config/env.js';
import type { AgentHub, ClosedTradeLike } from './agents.js';
import type { UiHub } from '../realtime/hub.js';

/**
 * Copy pipeline: master state → copy decisions → durable commands.
 *
 * The engine is deliberately two-phase:
 *
 *   1. **Decision** (this file) — translates a master event into at most one
 *      command per follower, with a full audit trail. It never talks to a
 *      broker, so it is deterministic and replayable.
 *   2. **Dispatch** (dispatcher.ts) — executes commands against the broker,
 *      applies the outcome to the trade link and owns retries.
 *
 * Splitting them is what makes the "every step is a log row with a
 * machine-readable code" promise achievable: phase 1 records intent, phase 2
 * records outcome.
 */
export interface PipelineDeps {
  readonly env: Env;
  readonly repos: Repositories;
  readonly hub: AgentHub;
  readonly ui: UiHub;
  readonly log: FastifyBaseLogger;
  readonly marketSession: MarketSessionConfig;
  readonly now?: (() => Date) | undefined;
}

export class CopyPipeline {
  private readonly now: () => Date;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // agent-fed entry points
  // -------------------------------------------------------------------------

  /**
   * Handles a set of position states for one account.
   *
   * `authoritative` is true for full snapshots (agent connect, reconciliation):
   * positions we still believe are open but which are absent from the snapshot
   * are treated as closed. Incremental events arrive as `[position]` with
   * `authoritative = false` (a `position.closed` event carries volume 0).
   */
  async onPositions(accountId: string, positions: readonly Position[], authoritative: boolean): Promise<void> {
    const copiers = await this.deps.repos.copiers.listActiveByMasterAccounts([accountId]);
    if (copiers.length === 0) return;
    const at = this.now();
    let changed = false;

    for (const copier of copiers) {
      if (authoritative) {
        const seen = new Set(positions.map((position) => position.ticket));
        const openTrades = await this.deps.repos.engine.listOpenMasterTrades(copier.id);
        for (const record of openTrades) {
          if (seen.has(record.ticket)) continue;
          const previous = recordToSnapshot(record);
          await this.deps.repos.engine.markMasterTradeClosed({
            copierId: copier.id,
            ticket: record.ticket,
            closePrice: record.currentPrice,
            closedAt: at,
          });
          await this.deps.repos.engine.log({
            userId: copier.userId,
            copierId: copier.id,
            level: 'info',
            code: 'RECONNECT_MISMATCH',
            message: `Master position ${record.ticket} is no longer present after resync; treating it as closed`,
            context: { masterTicket: record.ticket, masterSymbol: record.symbol },
          });
          await this.handleEvent(copier, closeEvent(previous, at, record.currentPrice), accountId);
          changed = true;
        }
      }

      for (const position of positions) {
        const { previous, current } = await this.deps.repos.engine.upsertMasterTrade({ copierId: copier.id, accountId, position });
        const diff = diffPosition(previous ? recordToSnapshot(previous) : null, recordToSnapshot(current), at);
        if (diff.unchanged) continue;
        changed = true;
        for (const event of diff.events) {
          await this.handleEvent(copier, event, accountId);
        }
        if (current.state === 'closed' && previous?.state !== 'closed') {
          await this.deps.repos.engine.markMasterTradeClosed({
            copierId: copier.id,
            ticket: current.ticket,
            closePrice: position.currentPrice ?? null,
            closedAt: at,
          });
        }
      }
    }

    if (changed) await this.publishMasterTrades(copiers);
  }

  /**
   * A broker-reported closed trade.
   *
   * On a **slave** account it is the only reliable source of realised P/L, so it
   * is attributed to the trade link via the slave ticket. On a **master**
   * account it feeds the "my trades vs copied trades" analytics.
   */
  async onClosedTrade(accountId: string, trade: ClosedTradeLike): Promise<void> {
    const link = await this.deps.repos.engine.findLinkBySlaveTicket(accountId, trade.ticket);
    if (link) {
      const profit = trade.profit + trade.swap + trade.commission;
      await this.deps.repos.engine.updateLinkState(link.id, {
        state: 'closed',
        closedAt: new Date(trade.closedAt),
        realizedProfit: profit,
      });
      await this.deps.repos.engine.recordClosedTrade(accountId, toClosedTrade(trade, link.followerId), link.followerId, null);
      return;
    }

    const copiers = await this.deps.repos.copiers.listActiveByMasterAccounts([accountId]);
    for (const copier of copiers) {
      const record = await this.deps.repos.engine.findMasterTrade(copier.id, trade.ticket);
      if (!record) continue;
      await this.deps.repos.engine.recordClosedTrade(accountId, toClosedTrade(trade, null));
    }
  }

  async onAccountState(accountId: string, snapshot: AccountSnapshot): Promise<void> {
    const account = await this.deps.repos.accounts.findById(accountId);
    if (!account) return;
    await this.deps.repos.accounts.applySnapshot(accountId, snapshot);
    await this.deps.repos.accounts.touchHeartbeat(accountId);
    this.deps.ui.publish(account.userId, 'accounts', {
      type: 'account.status',
      accountId,
      status: 'connected',
      balance: snapshot.balance,
      equity: snapshot.equity,
      freeMargin: snapshot.freeMargin,
      lastErrorCode: null,
      at: snapshot.at,
    });
  }

  /**
   * The agent re-sent its symbol list. Stored verbatim and used to re-check
   * mappings: a mapping that points at a symbol the broker no longer offers is
   * exactly the "mismatch detected" case the dashboard must show.
   */
  async onSymbols(accountId: string, symbols: readonly SymbolInfo[]): Promise<void> {
    await this.deps.repos.accounts.replaceSymbols(
      accountId,
      symbols.map((symbol) => ({
        name: symbol.name,
        canonical: symbol.canonical,
        assetClass: symbol.assetClass,
        digits: symbol.digits,
        point: symbol.point,
        pipSize: symbol.pipSize,
        contractSize: symbol.contractSize,
        minLot: symbol.minLot,
        maxLot: symbol.maxLot,
        lotStep: symbol.lotStep,
        maxLotPerOrder: symbol.maxLotPerOrder,
        quoteCurrency: symbol.quoteCurrency,
        tradeMode: symbol.tradeMode,
        swapLong: symbol.swapLong,
        swapShort: symbol.swapShort,
      })),
    );

    const available = new Set(symbols.map((symbol) => symbol.name));
    const pairs = await this.deps.repos.copiers.listByFollowerAccount(accountId);
    for (const { copier, followerId } of pairs) {
      const mappings = await this.deps.repos.copiers.listMappings(followerId);
      for (const mapping of mappings) {
        if (available.has(mapping.slaveSymbol)) continue;
        await this.deps.repos.engine.log({
          copierId: copier.id,
          followerId,
          accountId,
          level: 'warn',
          code: 'SYMBOL_NOT_MAPPED',
          message: `Mapped symbol ${mapping.slaveSymbol} is no longer offered by the broker`,
          context: { masterSymbol: mapping.masterSymbol, slaveSymbol: mapping.slaveSymbol },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // decisions
  // -------------------------------------------------------------------------

  private async handleEvent(copier: CopierRecord, event: MasterEvent, masterAccountId: string): Promise<void> {
    const followers = await this.deps.repos.copiers.listFollowersResolved(copier.id);
    if (followers.length === 0) return;

    const masterAccount = await this.deps.repos.accounts.findById(masterAccountId);
    const masterTrade = await this.deps.repos.engine.findMasterTrade(copier.id, event.trade.ticket);

    for (const follower of followers) {
      const account = await this.deps.repos.accounts.findById(follower.accountId);
      if (!account || account.deletedAt) continue;
      const link = masterTrade ? await this.deps.repos.engine.findLink(masterTrade.id, follower.id) : null;

      let context: PlanContext;
      try {
        context = await this.buildContext({
          copier,
          follower,
          account,
          masterAccount,
          masterAccountId,
          event,
          masterTrade,
          link,
        });
      } catch (error) {
        this.deps.log.error({ err: error, followerId: follower.id }, 'failed to build plan context');
        continue;
      }

      await this.applyDecision({ decision: planCopy(event, context), copier, follower, account, masterTrade, link, event });
    }
  }

  private async buildContext(input: {
    copier: CopierRecord;
    follower: FollowerWithOverrides;
    account: AccountRecord;
    masterAccount: AccountRecord | null;
    masterAccountId: string;
    event: MasterEvent;
    masterTrade: MasterTradeRecord | null;
    link: TradeLinkRecord | null;
  }): Promise<PlanContext> {
    const { copier, follower, account, masterAccount, masterAccountId, event, link } = input;
    const now = this.now();
    const settings = follower.settingsFor(event.trade.symbol);

    // --- symbol resolution -------------------------------------------------
    const slaveSymbolNames = await this.deps.repos.accounts.listSymbolNames(account.id);
    const resolution = resolveSymbol({
      masterSymbol: event.trade.symbol,
      slaveSymbols: slaveSymbolNames,
      explicit: follower.mappings,
      suffixPreference: follower.suffixPreference,
    });
    const slaveSymbol = resolution.slaveSymbol
      ? await this.deps.repos.accounts.findSymbol(account.id, resolution.slaveSymbol)
      : null;
    const disabledSymbols = await this.deps.repos.accounts.listDisabledSymbolNames(account.id);

    // --- master instrument metadata ---------------------------------------
    const masterSymbolInfo =
      (await this.deps.repos.accounts.findSymbol(masterAccountId, event.trade.symbol)) ?? fallbackSymbolInfo(event.trade.symbol);

    // --- market data -------------------------------------------------------
    const cache = this.deps.hub.cacheFor(account.id);
    const liveQuote = slaveSymbol ? cache?.quote(slaveSymbol.name) ?? null : null;
    const assetClass = masterSymbolInfo.assetClass ?? classifyAssetClass(event.trade.symbol);
    const marketState = isMarketOpen({
      symbol: event.trade.symbol,
      at: now,
      config: this.deps.marketSession,
      assetClass,
    });

    // --- equity protection -------------------------------------------------
    const protection = await this.deps.repos.platform.getEquityProtection(account.id);
    let equityProtectionActive = false;
    if (protection?.enabled && account.equity !== null && account.balance !== null) {
      equityProtectionActive = evaluateEquityProtection({
        config: protection,
        balance: account.balance,
        equity: account.equity,
        referenceBalance: account.referenceBalance ?? account.balance,
      }).triggered;
    }

    // --- slave-side link context ------------------------------------------
    const slavePosition = link?.slaveTicket
      ? cache?.positions().find((position) => position.ticket === link.slaveTicket) ?? null
      : null;

    return {
      copierId: copier.id,
      copierStatus: copier.status,
      followerId: follower.id,
      settings,
      account: {
        accountId: account.id,
        currency: account.currency,
        balance: account.balance ?? 0,
        equity: account.equity ?? account.balance ?? 0,
        freeMargin: account.freeMargin ?? account.balance ?? 0,
        leverage: account.leverage,
        enabled: account.enabled,
        // An agent session is the strong signal; the DB status covers accounts
        // driven by the in-process mock connector (simulator, tests).
        connected: this.deps.hub.isAccountOnline(account.id) || account.status === 'connected',
        disabledSymbols,
      },
      slaveSymbol,
      symbolResolution: {
        slaveSymbol: resolution.slaveSymbol,
        strategy: resolution.strategy,
        ambiguous: resolution.ambiguous,
        ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
      },
      masterSymbolInfo,
      // Live master balance — the pinned value travels through
      // `settings.fixedMasterBalance` for FIXED_BALANCE_MULTIPLIER.
      masterBalanceForRisk: masterAccount?.balance ?? copier.masterBalanceAtCreation ?? 0,
      link: link
        ? {
            slaveTicket: link.slaveTicket ?? '',
            volume: link.filledVolume ?? link.requestedVolume ?? link.masterVolume,
            openPrice: link.filledPrice ?? slavePosition?.openPrice ?? 0,
            status: toLinkStatus(link.state),
            sl: slavePosition?.stopLoss ?? null,
            tp: slavePosition?.takeProfit ?? null,
            seq: link.seq,
          }
        : null,
      quotes: liveQuote ? { bid: liveQuote.bid, ask: liveQuote.ask, at: liveQuote.at } : null,
      marketState,
      equityProtectionActive,
      now,
      minStopDistancePips: readStopDistance(account.metadata),
      random: Math.random,
    };
  }

  private async applyDecision(input: {
    decision: PlanDecision;
    copier: CopierRecord;
    follower: FollowerWithOverrides;
    account: AccountRecord;
    masterTrade: MasterTradeRecord | null;
    link: TradeLinkRecord | null;
    event: MasterEvent;
  }): Promise<void> {
    const { decision, copier, follower, account, masterTrade, link, event } = input;
    const logBase = {
      userId: copier.userId,
      copierId: copier.id,
      followerId: follower.id,
      accountId: account.id,
      masterTradeId: masterTrade?.id ?? null,
      requestId: decision.requestId ?? null,
    } as const;
    const context = {
      masterSymbol: event.trade.symbol,
      masterTicket: event.trade.ticket,
      event: event.kind,
      decision: decision.action,
      trace: decision.trace,
    } as const;

    if (decision.action === 'skip') {
      const code = (decision.code ?? 'INTERNAL') as CopierErrorCode;
      const meta = errorMeta(code);
      await this.deps.repos.engine.log({
        ...logBase,
        level: meta.level,
        code,
        message: decision.detail ?? meta.message,
        context,
      });
      if (ACTIONABLE_CODES.has(code)) await this.deps.repos.copiers.markFollowerEvent(follower.id);
      return;
    }

    const { kind, params, requestId } = decision;
    if (!kind || !params || !requestId) {
      this.deps.log.warn({ followerId: follower.id, decision }, 'decision produced no executable command');
      return;
    }

    // Deferrals (market closed, price gap) become commands that simply are not
    // due yet; the window is capped so a trade cannot be opened hours later.
    let delayMs = decision.delayMs ?? 0;
    if (decision.action === 'defer' && decision.deferredUntil) {
      const target = new Date(decision.deferredUntil).getTime();
      delayMs = Math.max(0, Math.min(target - this.now().getTime(), this.deps.env.COPY_RETRY_WINDOW_MS));
    }

    const { created } = await this.deps.repos.engine.enqueueCommand({
      requestId,
      accountId: account.id,
      kind,
      params,
      copierId: copier.id,
      followerId: follower.id,
      masterTradeId: masterTrade?.id ?? null,
      linkId: link?.id ?? null,
      seq: decision.seq ?? 0,
      delayMs,
      retryDeadlineAt: new Date(this.now().getTime() + this.deps.env.COPY_RETRY_WINDOW_MS),
      trace: {
        ...context,
        warnings: decision.warnings,
        slaveSymbol: params.symbol ?? null,
        volume: params.volume ?? null,
        side: params.side ?? null,
        // Kept for the dispatcher: the first successful entry creates the trade
        // link and needs the master's volume for proportional maths later.
        masterVolume: event.trade.volume,
      },
    });

    if (!created) return; // identical intent already queued (idempotent replay)

    await this.deps.repos.engine.log({
      ...logBase,
      level: decision.warnings.length > 0 ? 'warn' : 'info',
      code: successCode(decision),
      message: describeDecision(decision, account.label),
      context: {
        ...context,
        slaveSymbol: params.symbol ?? null,
        volume: params.volume ?? null,
        side: params.side ?? null,
        stopLoss: params.stopLoss ?? null,
        takeProfit: params.takeProfit ?? null,
        delayMs,
        warnings: decision.warnings,
      },
    });

    await this.deps.repos.copiers.markFollowerEvent(follower.id);
  }

  /** Publishes the current open-trade picture for the dashboard's trade list. */
  private async publishMasterTrades(copiers: readonly CopierRecord[]): Promise<void> {
    for (const copier of copiers) {
      const trades = await this.deps.repos.engine.listOpenMasterTrades(copier.id);
      for (const trade of trades) {
        const tradeLinks = await this.deps.repos.engine.listLinksByMasterTrade(trade.id);
        this.deps.ui.publish(copier.userId, 'trades', {
          type: 'trade.updated',
          masterTradeId: trade.id,
          ticket: trade.ticket,
          symbol: trade.symbol,
          side: trade.side,
          volume: trade.volume,
          state: trade.state === 'closed' ? 'closed' : 'open',
          links: tradeLinks.map((link) => ({
            followerId: link.followerId,
            accountId: link.slaveAccountId,
            status: link.state,
            errorCode: link.errorCode,
            filledVolume: link.filledVolume,
          })),
          at: this.now().toISOString(),
        });
      }
    }
  }

}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Codes that leave the follower in a state the user must fix. */
const ACTIONABLE_CODES: ReadonlySet<string> = new Set([
  'SYMBOL_NOT_MAPPED',
  'SYMBOL_MISMATCH',
  'SYMBOL_DISABLED',
  'INVALID_VOLUME',
  'INVALID_PRICE',
  'INVALID_SLTP',
  'TRADE_DISABLED',
  'INSUFFICIENT_MARGIN',
  'ACCOUNT_DISCONNECTED',
  'AGENT_OFFLINE',
  'EQUITY_PROTECTION',
]);

export function recordToSnapshot(record: MasterTradeRecord): MasterTradeSnapshot {
  return {
    ticket: record.ticket,
    symbol: record.symbol,
    side: record.side,
    volume: record.volume,
    closedVolume: record.closedVolume,
    openPrice: record.openPrice,
    currentPrice: record.currentPrice,
    stopLoss: record.stopLoss,
    takeProfit: record.takeProfit,
    magic: record.magic,
    comment: record.comment,
    kind: record.kind,
    pendingType: (record.pendingType as PendingOrderType | null) ?? null,
    expiry: record.expiry ? record.expiry.toISOString() : null,
    openedAt: record.openedAt.toISOString(),
    updatedAt: null,
    profit: null,
    swap: null,
    commission: null,
  };
}

/** Fallback metadata when the master broker has not synced symbols yet. */
export function fallbackSymbolInfo(name: string): SymbolInfo {
  const digits = /JPY/.test(name.toUpperCase()) ? 3 : 5;
  const pipSize = derivePipSize(digits);
  return {
    name,
    canonical: name.toUpperCase(),
    assetClass: classifyAssetClass(name.toUpperCase()),
    digits,
    point: pipSize / 10,
    pipSize,
    contractSize: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    tradeMode: 'full',
    enabled: true,
    quoteCurrency: 'USD',
    maxLotPerOrder: null,
    swapLong: null,
    swapShort: null,
  };
}

export function toClosedTrade(trade: ClosedTradeLike, followerId: string | null): ClosedTrade {
  return {
    ticket: trade.ticket,
    symbol: trade.symbol,
    side: trade.side,
    volume: trade.volume,
    openPrice: trade.openPrice,
    closePrice: trade.closePrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    magic: trade.magic,
    comment: trade.comment,
    profit: trade.profit,
    swap: trade.swap,
    commission: trade.commission,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    followerId,
  };
}

export function toLinkStatus(state: TradeLinkRecord['state']): 'pending' | 'open' | 'closed' | 'failed' | 'skipped' | 'partial' {
  switch (state) {
    case 'pending':
      return 'pending';
    case 'open':
      return 'open';
    case 'partial':
      return 'partial';
    case 'closed':
    case 'cancelled':
      return 'closed';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** Success codes keep the log filterable by outcome, not just by failure. */
export function successCode(decision: PlanDecision): string {
  switch (decision.action) {
    case 'open':
    case 'place_pending':
      return 'COPIED';
    case 'modify':
      return 'COPIED_MODIFY';
    case 'close':
      return 'COPIED_CLOSE';
    case 'close_partial':
      return 'COPIED_CLOSE_PARTIAL';
    case 'cancel_pending':
      return 'COPIED_CANCEL';
    case 'defer':
      return 'DEFERRED';
    default:
      return 'COPIED';
  }
}

function readStopDistance(metadata: Record<string, unknown> | null | undefined): number | null {
  const value = metadata?.minStopDistancePips;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function describeDecision(decision: PlanDecision, label: string): string {
  const params = decision.params;
  const parts: string[] = [];
  switch (decision.action) {
    case 'open':
      parts.push(`Opened ${params?.side} ${params?.volume} ${params?.symbol} on ${label}`);
      break;
    case 'place_pending':
      parts.push(`Placed ${params?.pendingType} ${params?.volume} ${params?.symbol} on ${label}`);
      break;
    case 'modify':
      parts.push(`Updated stops on ${params?.symbol} (${label})`);
      break;
    case 'close':
      parts.push(`Closed ${params?.symbol} on ${label}`);
      break;
    case 'close_partial':
      parts.push(`Partially closed ${params?.volume} of ${params?.symbol} on ${label}`);
      break;
    case 'cancel_pending':
      parts.push(`Cancelled the pending order on ${label}`);
      break;
    case 'defer':
      parts.push(`Deferred until the market reopens (${label})`);
      break;
    default:
      parts.push(`No action for ${label}`);
  }
  if (decision.warnings.length > 0) parts.push(`— ${decision.warnings.join('; ')}`);
  return parts.join(' ');
}
