import { randomUUID } from 'node:crypto';
import type {
  AccountSnapshot,
  BridgeInboundMessage,
  BridgeOutboundMessage,
  Platform,
  Position,
  Quote,
  ServerCommand,
  SymbolInfo,
} from '@trade-copier/contracts';
import { err, ok, type Result } from '@trade-copier/domain';
import {
  brokerError,
  MT_CLASS_CAPABILITIES,
  type BrokerCapabilities,
  type BrokerConnector,
  type BrokerError,
  type BrokerEventHandler,
  type CloseRequest,
  type CloseResult,
  type MarketOrderRequest,
  type OrderFill,
  type ModifyRequest,
  type PendingOrderRequest,
} from './types.js';

/**
 * Server-side connector that drives a broker through a bridge agent.
 *
 * Division of responsibility:
 *  - **Commands** are RPC: we send a `server.command` frame and await the
 *    matching `command.result` (correlated by request id, with a deadline).
 *  - **State** is push-based: the agent streams account state, symbols,
 *    positions and quotes; this connector reads them from a cache. That keeps
 *    the hot path (many followers reading the same master state) free of
 *    round trips.
 */
export interface RemoteAgentTransport {
  send(message: BridgeOutboundMessage): boolean;
  onMessage(handler: (message: BridgeInboundMessage) => void): () => void;
  isConnected(): boolean;
}

export interface RemoteStateCache {
  snapshot(): AccountSnapshot | null;
  symbols(): readonly SymbolInfo[];
  positions(): readonly Position[];
  quote(symbol: string): Quote | null;
}

export interface RemoteConnectorOptions {
  accountId: string;
  platform: Platform;
  label?: string;
  transport: RemoteAgentTransport;
  cache: RemoteStateCache;
  /** Deadline for a command round trip. */
  commandTimeoutMs?: number;
}

interface Waiter {
  resolve: (result: CommandResultLike) => void;
  timeout: NodeJS.Timeout;
  sentAt: number;
}

interface CommandResultLike {
  ok: boolean;
  ticket?: string | null;
  filledVolume?: number | null;
  filledPrice?: number | null;
  closedVolume?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  status: 'filled' | 'accepted' | 'partial' | 'rejected' | 'error';
}

export class RemoteConnector implements BrokerConnector {
  readonly platform: Platform;
  readonly label: string;

  private readonly waiters = new Map<string, Waiter>();
  private readonly handlers = new Set<BrokerEventHandler>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.platform = options.platform;
    this.label = options.label ?? `remote ${options.accountId}@${options.platform}`;
  }

  capabilities(): BrokerCapabilities {
    return MT_CLASS_CAPABILITIES;
  }

  /** Subscribes to the agent stream (call once, when the agent connects). */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.transport.onMessage((message) => this.onMessage(message));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timeout);
    this.waiters.clear();
  }

  // --- state (served from the cache; no round trip) ------------------------

  async connect(): Promise<Result<AccountSnapshot, BrokerError>> {
    this.attach();
    const snapshot = this.options.cache.snapshot();
    if (!snapshot) return err(brokerError('BRIDGE_TIMEOUT', 'No account state received from the bridge agent yet', { retryable: true }));
    return ok(snapshot);
  }

  async disconnect(): Promise<void> {
    this.detach();
  }

  async ping(): Promise<Result<{ latencyMs: number }, BrokerError>> {
    if (!this.options.transport.isConnected()) {
      return err(brokerError('ACCOUNT_DISCONNECTED', 'Bridge agent is not connected', { retryable: true }));
    }
    return ok({ latencyMs: 0 });
  }

  async listSymbols(): Promise<Result<SymbolInfo[], BrokerError>> {
    return ok([...this.options.cache.symbols()]);
  }

  async listPositions(): Promise<Result<Position[], BrokerError>> {
    return ok([...this.options.cache.positions()]);
  }

  async getSnapshot(): Promise<Result<AccountSnapshot, BrokerError>> {
    const snapshot = this.options.cache.snapshot();
    if (!snapshot) return err(brokerError('BRIDGE_TIMEOUT', 'No account snapshot available', { retryable: true }));
    return ok(snapshot);
  }

  async getQuote(symbol: string): Promise<Result<Quote, BrokerError>> {
    const quote = this.options.cache.quote(symbol);
    if (!quote) return err(brokerError('QUOTE_UNAVAILABLE', `No live quote for ${symbol}`, { retryable: true }));
    return ok(quote);
  }

  // --- commands ------------------------------------------------------------

  async placeMarketOrder(request: MarketOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const result = await this.command('open', {
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      maxSlippagePips: request.maxSlippagePips ?? undefined,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
    }, request.requestId);
    return this.toFill(result, request.volume);
  }

  async placePendingOrder(request: PendingOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const result = await this.command('place_pending', {
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      price: request.price,
      pendingType: request.pendingType,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      expiry: request.expiry ?? null,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
    }, request.requestId);
    return this.toFill(result, request.volume);
  }

  async modifyPosition(request: ModifyRequest): Promise<Result<void, BrokerError>> {
    const result = await this.command('modify', {
      ticket: request.ticket,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
    });
    return result.ok ? ok(undefined) : err(this.toError(result));
  }

  async closePosition(request: CloseRequest): Promise<Result<CloseResult, BrokerError>> {
    const partial = typeof request.volume === 'number' && request.volume > 0;
    const result = await this.command(
      partial ? 'close_partial' : 'close',
      {
        ticket: request.ticket,
        ...(partial ? { volume: request.volume } : {}),
        maxSlippagePips: request.maxSlippagePips ?? undefined,
        comment: request.comment ?? '',
      },
    );
    if (!result.ok) return err(this.toError(result));

    const closedVolume = result.closedVolume ?? request.volume ?? 0;
    return ok({
      ticket: request.ticket,
      closedVolume,
      closePrice: result.filledPrice ?? 0,
      profit: 0,
      fullyClosed: !partial,
      at: new Date().toISOString(),
    });
  }

  async cancelPendingOrder(ticket: string): Promise<Result<void, BrokerError>> {
    const result = await this.command('cancel_pending', { ticket });
    return result.ok ? ok(undefined) : err(this.toError(result));
  }

  async closeAll(input: { reason: string; magic?: number | null; tickets?: readonly string[] | null }): Promise<Result<{ closed: number }, BrokerError>> {
    const result = await this.command('close_all', {
      comment: input.reason,
      filterMagic: input.magic ?? null,
      originRequestIds: input.tickets ? [...input.tickets] : undefined,
    });
    if (!result.ok) return err(this.toError(result));
    return ok({ closed: result.closedVolume ?? 0 });
  }

  subscribe(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // --- internals -----------------------------------------------------------

  private command(
    kind: ServerCommand['kind'],
    params: ServerCommand['params'],
    requestId: string = randomUUID(),
  ): Promise<CommandResultLike> {
    const timeoutMs = this.options.commandTimeoutMs ?? 15_000;
    if (!this.options.transport.isConnected()) {
      return Promise.resolve({ ok: false, status: 'error', errorCode: 'ACCOUNT_DISCONNECTED', errorMessage: 'Bridge agent is offline' });
    }

    const frame: ServerCommand = {
      type: 'server.command',
      requestId,
      accountId: this.options.accountId,
      kind,
      params,
      timeoutMs,
      trace: { copierId: null, followerId: null, masterTradeId: null, masterTicket: null },
    };

    const promise = new Promise<CommandResultLike>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({
          ok: false,
          status: 'error',
          errorCode: 'BRIDGE_TIMEOUT',
          errorMessage: `The bridge agent did not answer ${kind} within ${timeoutMs} ms`,
        });
      }, timeoutMs);
      this.waiters.set(requestId, { resolve, timeout, sentAt: Date.now() });
    });

    const sent = this.options.transport.send(frame);
    if (!sent) {
      const waiter = this.waiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(requestId);
      }
      return Promise.resolve({ ok: false, status: 'error', errorCode: 'ACCOUNT_DISCONNECTED', errorMessage: 'Bridge agent went offline before the command was sent' });
    }
    return promise;
  }

  private onMessage(message: BridgeInboundMessage): void {
    switch (message.type) {
      case 'command.result': {
        const waiter = this.waiters.get(message.requestId);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        this.waiters.delete(message.requestId);
        waiter.resolve({
          ok: message.status === 'filled' || message.status === 'accepted' || message.status === 'partial',
          ticket: message.ticket,
          filledVolume: message.filledVolume,
          filledPrice: message.filledPrice,
          closedVolume: message.closedVolume,
          errorCode: message.errorCode,
          errorMessage: message.errorMessage,
          latencyMs: message.latencyMs,
          status: message.status,
        });
        break;
      }
      case 'position.opened':
      case 'position.modified':
      case 'position.closed': {
        for (const handler of this.handlers) handler({ kind: 'positions', positions: this.options.cache.positions() });
        break;
      }
      case 'closed_trade': {
        for (const handler of this.handlers) {
          handler({
            kind: 'trade_closed',
            trade: { ...message.trade, closedVolume: message.trade.volume, kind: 'market', pendingType: null, expiry: null, originRequestId: null, currentPrice: message.trade.closePrice },
            closePrice: message.trade.closePrice,
            profit: message.trade.profit,
          });
        }
        break;
      }
      case 'agent.log': {
        for (const handler of this.handlers) {
          handler({ kind: 'log', level: message.level === 'debug' ? 'info' : message.level, message: message.message });
        }
        break;
      }
      default:
        break;
    }
  }

  private toFill(result: CommandResultLike, requestedVolume: number): Result<OrderFill, BrokerError> {
    if (!result.ok) return err(this.toError(result));
    if (!result.ticket) return err(brokerError('BROKER_REJECTED', 'The agent accepted the command but returned no ticket'));
    return ok({
      ticket: result.ticket,
      filledVolume: result.filledVolume ?? requestedVolume,
      filledPrice: result.filledPrice ?? 0,
      slippagePips: null,
      at: new Date().toISOString(),
    });
  }

  private toError(result: CommandResultLike): BrokerError {
    const code = (result.errorCode ?? 'BROKER_REJECTED') as BrokerError['code'];
    return brokerError(code, result.errorMessage ?? 'Command failed', {
      retryable: result.status === 'error' && code !== 'BROKER_REJECTED',
    });
  }
}
