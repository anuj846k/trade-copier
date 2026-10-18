import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Result } from '@trade-copier/domain';
import type { BrokerError } from '@trade-copier/broker';
import type { CommandParams, CopierErrorCode } from '@trade-copier/contracts';
import type { CommandRecord, Repositories, TradeLinkRecord } from '@trade-copier/db';
import type { Env } from '../config/env.js';
import type { AgentHub } from './agents.js';
import type { ConnectorRegistry } from './connectors.js';
import type { UiHub } from '../realtime/hub.js';

/**
 * Command dispatcher.
 *
 * Claims due commands from the durable queue and executes them against the
 * broker. It owns three concerns the pure planner deliberately does not:
 *
 *   1. **Liveness** — a command whose account went offline is requeued, not
 *      failed, as long as the retry window is open.
 *   2. **State application** — a successful fill/close/modify is written back
 *      to the trade link, which is what every later decision reads.
 *   3. **Backoff** — transient broker errors retry with exponential backoff
 *      inside the window; permanent ones dead-letter with a user-facing code
 *      and (optionally) a notification.
 */
export interface DispatcherDeps {
  readonly env: Env;
  readonly repos: Repositories;
  readonly hub: AgentHub;
  readonly ui: UiHub;
  readonly registry: ConnectorRegistry;
  readonly log: FastifyBaseLogger;
  readonly now?: (() => Date) | undefined;
}

export class CommandDispatcher {
  readonly workerId: string;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: DispatcherDeps) {
    this.workerId = `wrk_${process.pid}_${randomUUID().slice(0, 8)}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
  }

  /** Runs one claim/execute cycle; returns how many commands were processed. */
  async tick(limit?: number): Promise<number> {
    const batchSize = limit ?? this.deps.env.WORKER_BATCH_SIZE;
    const commands = await this.deps.repos.engine.claimCommands(this.workerId, batchSize);
    if (commands.length === 0) return 0;

    // Serially per account (order matters for one account's positions) but in
    // parallel across accounts, bounded by WORKER_ACCOUNT_CONCURRENCY.
    const byAccount = new Map<string, CommandRecord[]>();
    for (const command of commands) {
      const list = byAccount.get(command.accountId);
      if (list) list.push(command);
      else byAccount.set(command.accountId, [command]);
    }

    const accounts = [...byAccount.entries()];
    const concurrency = Math.max(1, this.deps.env.WORKER_ACCOUNT_CONCURRENCY);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
      while (cursor < accounts.length) {
        const entry = accounts[cursor];
        cursor += 1;
        if (!entry) break;
        const [accountId, list] = entry;
        for (const command of list) {
          await this.execute(command).catch((error) => {
            this.deps.log.error({ err: error, commandId: command.id, accountId }, 'command execution threw');
          });
        }
      }
    });
    await Promise.all(workers);
    return commands.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error) {
        this.deps.log.error({ err: error }, 'dispatcher tick failed');
      }
      if (this.stopped) break;
      if (processed === 0) await delay(this.deps.env.WORKER_POLL_INTERVAL_MS);
    }
  }

  // -------------------------------------------------------------------------
  // execution
  // -------------------------------------------------------------------------

  private async execute(command: CommandRecord): Promise<void> {
    const startedAt = Date.now();
    const link = command.linkId ? await this.deps.repos.engine.findLinkById(command.linkId) : null;
    const gate = this.preflight(command, link);
    if (gate) {
      await this.deps.repos.engine.completeCommand(command.id, {
        status: gate.status,
        errorCode: gate.code ?? null,
        errorMessage: gate.message ?? null,
        latencyMs: Date.now() - startedAt,
      });
      if (gate.message && gate.log) {
        await this.logCommand(command, gate.level, gate.code ?? 'LINK_CLOSED', gate.message, { skipped: true });
      }
      return;
    }

    const connector = await this.deps.registry.for(command.accountId);
    if (!connector) {
      await this.handleTransportFailure(command, link, {
        code: 'AGENT_OFFLINE',
        message: 'No live bridge agent for this account; command was not sent',
        retryable: true,
      }, startedAt);
      return;
    }

    const result = await this.send(connector, command);
    if (!result.ok) {
      await this.handleFailure(command, link, result.error, startedAt);
      return;
    }

    await this.handleSuccess(command, link, result.value, startedAt);
  }

  /**
   * Cheap state gates that run *after* the decision was queued, because the
   * world moves: the position may already be closed, the trade may already be
   * open, the user may have disabled the follower in the meantime.
   */
  private preflight(
    command: CommandRecord,
    link: TradeLinkRecord | null,
  ): { status: 'acked' | 'cancelled'; code?: string; message?: string; level: 'debug' | 'info' | 'warn'; log: boolean } | null {
    if (command.kind === 'open' || command.kind === 'place_pending') {
      if (link && (link.state === 'open' || link.state === 'partial' || link.state === 'pending')) {
        return {
          status: 'acked',
          code: 'DUPLICATE_REQUEST',
          message: 'Position already exists for this master trade; nothing to do',
          level: 'debug',
          log: false,
        };
      }
      return null;
    }

    // Everything else operates on an existing slave ticket.
    if (!link || !link.slaveTicket) {
      return {
        status: 'cancelled',
        code: command.kind === 'cancel_pending' ? 'ORDER_NOT_FOUND' : 'NOT_COPIED',
        message: 'Slave position is gone (never filled or already closed)',
        level: 'info',
        log: true,
      };
    }
    if (link.state === 'closed' || link.state === 'cancelled') {
      return {
        status: 'cancelled',
        code: 'LINK_CLOSED',
        message: 'Slave position is already closed',
        level: 'debug',
        log: false,
      };
    }
    return null;
  }

  private async send(
    connector: Awaited<ReturnType<ConnectorRegistry['for']>>,
    command: CommandRecord,
  ): Promise<Result<unknown, BrokerError>> {
    if (!connector) return { ok: false as const, error: offlineError() };
    const params = command.params;
    switch (command.kind) {
      case 'open':
        return connector.placeMarketOrder({
          requestId: command.requestId,
          symbol: requiredSymbol(params),
          side: params.side ?? 'buy',
          volume: params.volume ?? 0,
          stopLoss: params.stopLoss ?? null,
          takeProfit: params.takeProfit ?? null,
          maxSlippagePips: params.maxSlippagePips ?? null,
          magic: params.magic ?? null,
          comment: params.comment ?? null,
        });
      case 'place_pending':
        return connector.placePendingOrder({
          requestId: command.requestId,
          symbol: requiredSymbol(params),
          side: params.side ?? 'buy',
          volume: params.volume ?? 0,
          pendingType: (params.pendingType as never) ?? 'limit',
          price: params.price ?? 0,
          stopLoss: params.stopLoss ?? null,
          takeProfit: params.takeProfit ?? null,
          expiry: params.expiry ?? null,
          magic: params.magic ?? null,
          comment: params.comment ?? null,
        });
      case 'modify':
        return connector.modifyPosition({
          ticket: requiredTicket(params, command),
          stopLoss: params.stopLoss ?? null,
          takeProfit: params.takeProfit ?? null,
        });
      case 'close':
      case 'close_partial':
        return connector.closePosition({
          ticket: requiredTicket(params, command),
          volume: command.kind === 'close_partial' ? params.volume ?? null : null,
          maxSlippagePips: params.maxSlippagePips ?? null,
          comment: params.comment ?? null,
        });
      case 'cancel_pending':
        return connector.cancelPendingOrder(requiredTicket(params, command));
      case 'close_all':
        return connector.closeAll({ reason: 'close_all', magic: params.magic ?? null, tickets: null });
      default: {
        const never: never = command.kind;
        void never;
        return { ok: false as const, error: { code: 'NOT_IMPLEMENTED' as CopierErrorCode, message: `Unsupported command kind ${String(command.kind)}` } };
      }
    }
  }

  // -------------------------------------------------------------------------
  // outcomes
  // -------------------------------------------------------------------------

  private async handleSuccess(
    command: CommandRecord,
    link: TradeLinkRecord | null,
    value: unknown,
    startedAt: number,
  ): Promise<void> {
    const latencyMs = Date.now() - startedAt;
    const params = command.params;

    switch (command.kind) {
      case 'open':
      case 'place_pending': {
        const fill = value as { ticket: string; filledVolume: number; filledPrice: number; slippagePips?: number | null };
        let activeLink = link;
        if (!activeLink) {
          // The link row is created on first successful entry, keyed by
          // (masterTradeId, followerId) so a replayed command updates it.
          activeLink = await this.deps.repos.engine.upsertLink({
            masterTradeId: command.masterTradeId ?? '',
            followerId: command.followerId ?? '',
            copierId: command.copierId ?? '',
            slaveAccountId: command.accountId,
            masterSymbol: masterSymbolOf(command),
            slaveSymbol: params.symbol ?? null,
            side: params.side ?? 'buy',
            masterVolume: masterVolumeOf(command),
            requestedVolume: params.volume ?? null,
            state: command.kind === 'place_pending' ? 'pending' : 'open',
            seq: command.seq,
          });
        }
        await this.deps.repos.engine.updateLinkState(activeLink.id, {
          state: command.kind === 'place_pending' ? 'pending' : 'open',
          slaveTicket: fill.ticket,
          filledVolume: fill.filledVolume,
          filledPrice: fill.filledPrice,
          magic: params.magic ?? null,
          errorCode: null,
          errorMessage: null,
          ...(command.kind === 'open' ? { openedAt: new Date() } : {}),
        });
        await this.completeAck(command, latencyMs);
        await this.logCommand(
          command,
          'info',
          command.kind === 'open' ? 'COPIED' : 'COPIED',
          command.kind === 'open'
            ? `Filled ${fill.filledVolume} of ${params.symbol} at ${fill.filledPrice} for follower`
            : `Pending order ${fill.ticket} placed for ${params.symbol}`,
          {
            ticket: fill.ticket,
            filledVolume: fill.filledVolume,
            filledPrice: fill.filledPrice,
            slippagePips: fill.slippagePips ?? null,
            latencyMs,
          },
        );
        await this.publishTrade(command, activeLink.id);
        return;
      }
      case 'modify': {
        if (link) {
          await this.deps.repos.engine.updateLinkState(link.id, { errorCode: null, errorMessage: null });
        }
        await this.completeAck(command, latencyMs);
        await this.logCommand(command, 'info', 'COPIED_MODIFY', `Updated ${params.stopLoss ?? '—'}/${params.takeProfit ?? '—'} on ${params.symbol ?? params.ticket}`, {
          stopLoss: params.stopLoss ?? null,
          takeProfit: params.takeProfit ?? null,
          latencyMs,
        });
        return;
      }
      case 'close':
      case 'close_partial': {
        const closed = value as { closedVolume: number; closePrice: number; profit: number; fullyClosed: boolean; ticket: string };
        if (link) {
          await this.deps.repos.engine.updateLinkState(link.id, {
            state: closed.fullyClosed ? 'closed' : 'partial',
            closedVolume: link.closedVolume + closed.closedVolume,
            ...(closed.fullyClosed ? { closedAt: new Date() } : {}),
          });
        }
        await this.completeAck(command, latencyMs);
        await this.logCommand(
          command,
          'info',
          command.kind === 'close_partial' ? 'COPIED_CLOSE_PARTIAL' : 'COPIED_CLOSE',
          `Closed ${closed.closedVolume} of ${params.symbol ?? closed.ticket} at ${closed.closePrice}`,
          { closedVolume: closed.closedVolume, fullyClosed: closed.fullyClosed, profit: closed.profit, latencyMs },
        );
        if (link) await this.publishTrade(command, link.id);
        return;
      }
      case 'cancel_pending': {
        if (link) {
          await this.deps.repos.engine.updateLinkState(link.id, { state: 'cancelled' });
        }
        await this.completeAck(command, latencyMs);
        await this.logCommand(command, 'info', 'COPIED_CANCEL', `Cancelled pending order for ${params.symbol ?? ''}`.trim(), { latencyMs });
        return;
      }
      default:
        await this.completeAck(command, latencyMs);
    }
  }

  private async handleFailure(
    command: CommandRecord,
    link: TradeLinkRecord | null,
    error: BrokerError,
    startedAt: number,
  ): Promise<void> {
    await this.handleTransportFailure(command, link, error, startedAt);
  }

  /**
   * Shared by broker rejections and "no transport" failures: retry inside the
   * window while attempts remain, otherwise dead-letter and surface the code.
   */
  private async handleTransportFailure(
    command: CommandRecord,
    link: TradeLinkRecord | null,
    error: BrokerError,
    startedAt: number,
  ): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const attempts = command.attempts + 1;
    const deadline = command.retryDeadlineAt;
    const withinWindow = deadline === null || now.getTime() < deadline.getTime();
    const retryable = error.retryable ?? RETRYABLE_CODES.has(error.code);
    const canRetry = retryable && attempts < command.maxAttempts && withinWindow;

    if (canRetry) {
      const backoff = Math.min(
        this.deps.env.COPY_RETRY_MAX_MS,
        this.deps.env.COPY_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
      );
      await this.deps.repos.engine.requeueCommand(command.id, {
        nextAttemptAt: new Date(now.getTime() + backoff),
        errorCode: error.code,
        errorMessage: error.message,
      });
      if (link) await this.deps.repos.engine.incrementLinkAttempts(link.id, { code: error.code, message: error.message });
      await this.logCommand(command, 'warn', error.code, error.message, {
        attempt: attempts,
        maxAttempts: command.maxAttempts,
        retryInMs: backoff,
        brokerCode: error.brokerCode ?? null,
      });
      return;
    }

    await this.deps.repos.engine.completeCommand(command.id, {
      status: attempts >= command.maxAttempts ? 'dead' : 'failed',
      errorCode: error.code,
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    });
    if (link) {
      await this.deps.repos.engine.updateLinkState(link.id, {
        errorCode: error.code,
        errorMessage: error.message,
        ...(command.kind === 'open' || command.kind === 'place_pending' ? { state: 'failed' } : {}),
      });
    }
    await this.logCommand(command, 'error', error.code, error.message, {
      attempts,
      brokerCode: error.brokerCode ?? null,
      gaveUp: true,
      retryWindowClosed: !withinWindow,
    });
    await this.publishTrade(command, link?.id ?? null);
    await this.notifyFailure(command, error);
  }

  private async completeAck(command: CommandRecord, latencyMs: number): Promise<void> {
    await this.deps.repos.engine.completeCommand(command.id, { status: 'acked', latencyMs });
  }

  private async logCommand(
    command: CommandRecord,
    level: 'debug' | 'info' | 'warn' | 'error',
    code: string,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const userId = await this.userIdFor(command);
    await this.deps.repos.engine.log({
      userId,
      copierId: command.copierId,
      followerId: command.followerId,
      accountId: command.accountId,
      masterTradeId: command.masterTradeId,
      requestId: command.requestId,
      level,
      code,
      message,
      context,
    });
    if (userId) {
      this.deps.ui.publish(userId, 'logs', {
        type: 'log.appended',
        entry: {
          code,
          level,
          message,
          accountId: command.accountId,
          copierId: command.copierId,
          followerId: command.followerId,
          requestId: command.requestId,
          at: (this.deps.now?.() ?? new Date()).toISOString(),
        },
        at: (this.deps.now?.() ?? new Date()).toISOString(),
      });
    }
  }

  /** Keeps the dashboard trade list current after a state transition. */
  private async publishTrade(command: CommandRecord, linkId: string | null): Promise<void> {
    if (!command.masterTradeId && !linkId) return;
    const userId = await this.userIdFor(command);
    if (!userId) return;
    const masterTrade = command.masterTradeId
      ? await this.deps.repos.engine.findMasterTrade(command.copierId ?? '', masterTicketOf(command))
      : null;
    if (!masterTrade) return;
    const links = await this.deps.repos.engine.listLinksByMasterTrade(masterTrade.id);
    this.deps.ui.publish(userId, 'trades', {
      type: 'trade.updated',
      masterTradeId: masterTrade.id,
      ticket: masterTrade.ticket,
      symbol: masterTrade.symbol,
      side: masterTrade.side,
      volume: masterTrade.volume,
      state: masterTrade.state === 'closed' ? 'closed' : 'open',
      links: links.map((link) => ({
        followerId: link.followerId,
        accountId: link.slaveAccountId,
        status: link.state,
        errorCode: link.errorCode,
        filledVolume: link.filledVolume,
      })),
      at: (this.deps.now?.() ?? new Date()).toISOString(),
    });
  }

  private async notifyFailure(command: CommandRecord, error: BrokerError): Promise<void> {
    const userId = await this.userIdFor(command);
    if (!userId) return;
    const subscribers = await this.deps.repos.platform.resolveSubscribers('trade_copy_failed', {
      userId,
      accountId: command.accountId,
    });
    for (const { channel } of subscribers) {
      await this.deps.repos.platform.enqueueNotification({
        userId,
        channelId: channel.id,
        event: 'trade_copy_failed',
        payload: {
          code: error.code,
          message: error.message,
          symbol: command.params.symbol ?? null,
          ticket: command.params.ticket ?? null,
          accountId: command.accountId,
          requestId: command.requestId,
        },
        dedupeKey: `trade_copy_failed:${command.requestId}:${channel.id}`,
      });
    }
  }

  private readonly userIdCache = new Map<string, string | null>();

  private async userIdFor(command: CommandRecord): Promise<string | null> {
    if (!command.copierId) return null;
    const cached = this.userIdCache.get(command.copierId);
    if (cached !== undefined) return cached;
    const copier = await this.deps.repos.copiers.findById(command.copierId);
    const userId = copier?.userId ?? null;
    this.userIdCache.set(command.copierId, userId);
    if (this.userIdCache.size > 1_000) this.userIdCache.clear();
    return userId;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Codes where the same command is worth another attempt without user action. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'BRIDGE_TIMEOUT',
  'TIMEOUT',
  'AGENT_OFFLINE',
  'ACCOUNT_DISCONNECTED',
  'BROKER_REJECTED',
  'QUOTE_UNAVAILABLE',
  'MARKET_CLOSED',
  'RATE_LIMITED',
  'INTERNAL',
]);

function offlineError(): BrokerError {
  return { code: 'AGENT_OFFLINE', message: 'Account has no live transport', retryable: true };
}

function requiredSymbol(params: CommandParams): string {
  if (!params.symbol) throw new Error('Command params are missing a symbol');
  return params.symbol;
}

function requiredTicket(params: CommandParams, command: CommandRecord): string {
  if (params.ticket) return params.ticket;
  // The decision always stamps the slave ticket for position-level commands; a
  // missing one means the command was queued before a fill, which preflight
  // rejects. Throwing here would kill the worker, so fail loudly in the log.
  throw new Error(`Command ${command.id} (${command.kind}) has no ticket`);
}

function masterSymbolOf(command: CommandRecord): string {
  const trace = command.trace as { masterSymbol?: string };
  return trace.masterSymbol ?? command.params.symbol ?? '';
}

function masterTicketOf(command: CommandRecord): string {
  const trace = command.trace as { masterTicket?: string };
  return trace.masterTicket ?? '';
}

/** The master's volume at decision time, stamped into the command trace. */
function masterVolumeOf(command: CommandRecord): number {
  const trace = command.trace as { masterVolume?: number };
  return typeof trace.masterVolume === 'number' ? trace.masterVolume : command.params.volume ?? 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
