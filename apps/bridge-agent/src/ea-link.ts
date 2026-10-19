import { BridgeConnector } from '@trade-copier/broker';
import type {
  AccountSnapshot,
  BridgeInboundMessage,
  Position,
  SymbolInfo,
} from '@trade-copier/contracts';
import type { AgentAccountConfig } from './config.js';

/**
 * One Expert Advisor link.
 *
 * The EA polls the local HTTP endpoint this class owns (`BridgeConnector`); in
 * return the agent watches the connector's state and translates it into the
 * cloud protocol:
 *
 *   - account snapshot changes → `account.state`
 *   - position-set changes     → `agent.positions.snapshot`
 *   - symbol-list changes      → `agent.symbols`
 *   - EA-reported closures     → `closed_trade`
 *
 * Only *state* is pushed for positions. The server derives opens / modifies /
 * partial closes / closes with the same `diffPosition` routine the copy planner
 * uses, so the two sides can never disagree about what "the master opened a
 * trade" means.
 */
export interface EaLinkLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface EaLinkDeps {
  readonly config: AgentAccountConfig;
  readonly log: EaLinkLogger;
  /** Pushes a protocol message towards the cloud (queued while offline). */
  readonly emit: (message: BridgeInboundMessage) => void;
}

export interface EaLinkStatus {
  readonly accountId: string;
  readonly label: string;
  readonly listening: { host: string; port: number } | null;
  readonly eaAgeMs: number | null;
  readonly positions: number;
  readonly symbols: number;
  readonly commandsInFlight: number;
}

export class EaLink {
  private readonly connector: BridgeConnector;
  private unsubscribe: (() => void) | null = null;
  private bound: { host: string; port: number } | null = null;
  private lastSnapshotSignature = '';
  private lastPositionsSignature = '';
  private lastSymbolsSignature = '';
  private snapshot: AccountSnapshot | null = null;
  private symbolCount = 0;
  private readonly recentClosedTickets = new Map<string, number>();

  constructor(private readonly deps: EaLinkDeps) {
    this.connector = new BridgeConnector({
      platform: this.deps.config.platform,
      label: this.deps.config.label,
      token: this.deps.config.eaToken,
      host: this.deps.config.eaHost,
      port: this.deps.config.eaPort,
      commandTimeoutMs: this.deps.config.commandTimeoutMs,
      maxCommandsPerPoll: this.deps.config.maxCommandsPerPoll,
    });
  }

  get accountId(): string {
    return this.deps.config.accountId;
  }

  get platform(): AgentAccountConfig['platform'] {
    return this.deps.config.platform;
  }

  /** Starts the local EA endpoint and begins forwarding state. */
  async start(): Promise<void> {
    this.bound = await this.connector.listen();
    this.unsubscribe = this.connector.subscribe((event) => {
      try {
        switch (event.kind) {
          case 'snapshot':
            this.onSnapshot(event.snapshot);
            break;
          case 'positions':
            this.onPositions(event.positions);
            break;
          case 'trade_closed':
            this.onTradeClosed(event);
            break;
          case 'log':
            break;
          default:
            break;
        }
      } catch (error) {
        this.deps.log.warn('failed to forward EA event', {
          accountId: this.accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.deps.log.info('waiting for the Expert Advisor to poll', {
      accountId: this.accountId,
      label: this.deps.config.label,
      endpoint: `http://${this.bound.host}:${this.bound.port}/ea`,
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.connector.closeServer();
  }

  status(): EaLinkStatus {
    return {
      accountId: this.accountId,
      label: this.deps.config.label,
      listening: this.bound,
      eaAgeMs: this.connector.eaAgeMs(),
      positions: this.connector.status().positions,
      symbols: this.symbolCount,
      commandsInFlight: this.connector.status().pendingCommands,
    };
  }

  /** The account descriptor sent in `agent.hello`. */
  descriptor(): {
    accountId: string;
    login: string;
    server: string;
    platform: AgentAccountConfig['platform'];
    currency: string;
    leverage: number | null;
    kind: 'demo' | 'live';
    capabilities: {
      pendingOrders: boolean;
      partialClose: boolean;
      modify: boolean;
      expiry: boolean;
      quotes: boolean;
      closeOnly: boolean;
    };
  } {
    const snapshot = this.snapshot;
    return {
      accountId: this.accountId,
      login: snapshot?.accountId ?? '',
      server: this.deps.config.label,
      platform: this.platform,
      currency: snapshot?.currency ?? 'USD',
      leverage: snapshot?.leverage ?? null,
      kind: 'live',
      capabilities: {
        pendingOrders: this.deps.config.capabilities.pendingOrders,
        partialClose: this.deps.config.capabilities.partialClose,
        modify: this.deps.config.capabilities.modify,
        expiry: false,
        quotes: this.deps.config.capabilities.quotes,
        closeOnly: true,
      },
    };
  }

  /** Answer to `server.request.snapshot`. */
  async sendSnapshot(include: ReadonlyArray<'account' | 'symbols' | 'positions'>, requestId: string | null): Promise<void> {
    if (include.includes('account')) {
      const snapshot = await this.connector.getSnapshot();
      if (snapshot.ok) {
        this.deps.emit({
          type: 'account.state',
          accountId: this.accountId,
          balance: snapshot.value.balance,
          equity: snapshot.value.equity,
          margin: snapshot.value.margin,
          freeMargin: snapshot.value.freeMargin,
          marginLevel: snapshot.value.marginLevel,
          currency: snapshot.value.currency,
          leverage: snapshot.value.leverage,
          at: snapshot.value.at,
        });
      }
    }
    if (include.includes('symbols')) {
      const symbols = await this.connector.listSymbols();
      if (symbols.ok) this.emitSymbols(symbols.value);
    }
    if (include.includes('positions')) {
      const positions = await this.connector.listPositions();
      if (positions.ok) this.emitPositions(positions.value, requestId);
    }
  }

  /**
   * Executes one cloud command through the EA and returns the result frame.
   *
   * The `requestId` from the cloud is passed straight to the EA, so a command
   * that is delivered twice (agent reconnect, EA re-poll) is recognised by the
   * terminal as the same request — the idempotency key lives end to end.
   */
  async execute(command: {
    requestId: string;
    kind: 'open' | 'close' | 'close_partial' | 'modify' | 'place_pending' | 'cancel_pending' | 'close_all';
    params: Record<string, unknown>;
  }): Promise<BridgeInboundMessage> {
    const startedAt = Date.now();
    const p = command.params;
    const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
    const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

    try {
      switch (command.kind) {
        case 'open': {
          const result = await this.connector.placeMarketOrder({
            requestId: command.requestId,
            symbol: str(p.symbol) ?? '',
            side: p.side === 'sell' ? 'sell' : 'buy',
            volume: num(p.volume) ?? 0,
            stopLoss: num(p.stopLoss),
            takeProfit: num(p.takeProfit),
            maxSlippagePips: num(p.maxSlippagePips),
            magic: num(p.magic),
            comment: str(p.comment),
          });
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return filled(command.requestId, result.value.ticket, result.value.filledVolume, result.value.filledPrice, result.value.slippagePips ?? null, startedAt);
        }
        case 'place_pending': {
          const result = await this.connector.placePendingOrder({
            requestId: command.requestId,
            symbol: str(p.symbol) ?? '',
            side: p.side === 'sell' ? 'sell' : 'buy',
            volume: num(p.volume) ?? 0,
            pendingType: (str(p.pendingType) ?? 'limit') as never,
            price: num(p.price) ?? 0,
            stopLoss: num(p.stopLoss),
            takeProfit: num(p.takeProfit),
            expiry: str(p.expiry),
            magic: num(p.magic),
            comment: str(p.comment),
          });
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return filled(command.requestId, result.value.ticket, result.value.filledVolume, result.value.filledPrice, result.value.slippagePips ?? null, startedAt);
        }
        case 'modify': {
          const result = await this.connector.modifyPosition({
            ticket: str(p.ticket) ?? '',
            stopLoss: num(p.stopLoss),
            takeProfit: num(p.takeProfit),
          });
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return accepted(command.requestId, str(p.ticket), startedAt);
        }
        case 'close':
        case 'close_partial': {
          const result = await this.connector.closePosition({
            ticket: str(p.ticket) ?? '',
            volume: command.kind === 'close_partial' ? num(p.volume) : null,
            maxSlippagePips: num(p.maxSlippagePips),
            comment: str(p.comment),
          });
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return {
            type: 'command.result',
            requestId: command.requestId,
            status: result.value.fullyClosed ? 'filled' : 'partial',
            ticket: result.value.ticket,
            filledVolume: null,
            filledPrice: result.value.closePrice,
            closedVolume: result.value.closedVolume,
            errorCode: null,
            errorMessage: null,
            latencyMs: Date.now() - startedAt,
            message: result.value.fullyClosed ? 'Position closed' : 'Position partially closed',
          };
        }
        case 'cancel_pending': {
          const result = await this.connector.cancelPendingOrder(str(p.ticket) ?? '');
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return accepted(command.requestId, str(p.ticket), startedAt);
        }
        case 'close_all': {
          // A ticket list is the precise form of "close what the copier
          // opened": the engine resolved its own links and sent the tickets, so
          // the agent just forwards them. `filterMagic` is the coarser form,
          // and with neither the whole account is closed on purpose
          // (Equity Protection's "close all trades").
          const tickets = Array.isArray(p.tickets) ? p.tickets.map((ticket) => String(ticket)) : null;
          const result = await this.connector.closeAll({
            reason: str(p.comment) ?? 'close_all',
            magic: num(p.filterMagic),
            tickets,
          });
          if (!result.ok) return rejected(command.requestId, result.error.code, result.error.message, startedAt);
          return {
            type: 'command.result',
            requestId: command.requestId,
            status: 'filled',
            ticket: null,
            filledVolume: null,
            filledPrice: null,
            closedVolume: result.value.closed,
            errorCode: null,
            errorMessage: null,
            latencyMs: Date.now() - startedAt,
            message: `Closed ${result.value.closed} position(s)`,
          };
        }
        default:
          return rejected(command.requestId, 'NOT_IMPLEMENTED', `Agent does not support ${String(command.kind)}`, startedAt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error('command execution threw', { accountId: this.accountId, requestId: command.requestId, message });
      return rejected(command.requestId, 'INTERNAL', message, startedAt);
    }
  }

  // --- state forwarding ----------------------------------------------------

  private onSnapshot(snapshot: AccountSnapshot): void {
    this.snapshot = snapshot;
    const signature = `${snapshot.balance}|${snapshot.equity}|${snapshot.freeMargin}|${snapshot.marginLevel ?? ''}`;
    if (signature === this.lastSnapshotSignature) return;
    this.lastSnapshotSignature = signature;
    this.deps.emit({
      type: 'account.state',
      accountId: this.accountId,
      balance: snapshot.balance,
      equity: snapshot.equity,
      margin: snapshot.margin,
      freeMargin: snapshot.freeMargin,
      marginLevel: snapshot.marginLevel,
      currency: snapshot.currency,
      leverage: snapshot.leverage,
      at: snapshot.at,
    });
  }

  private onPositions(positions: readonly Position[]): void {
    if (!hasChanged(positions, this.lastPositionsSignature)) return;
    this.emitPositions(positions, null);
  }

  private emitPositions(positions: readonly Position[], requestId: string | null): void {
    this.lastPositionsSignature = signatureOf(positions);
    this.deps.emit({
      type: 'agent.positions.snapshot',
      accountId: this.accountId,
      requestId,
      positions: positions.map(roundPosition),
    });
    const symbols = this.connector.status().symbols;
    this.symbolCount = symbols;
  }

  private emitSymbols(symbols: readonly SymbolInfo[]): void {
    const signature = symbols.map((symbol) => `${symbol.name}:${symbol.digits}:${symbol.contractSize}`).join('|');
    if (signature === this.lastSymbolsSignature) return;
    this.lastSymbolsSignature = signature;
    this.symbolCount = symbols.length;
    this.deps.emit({ type: 'agent.symbols', accountId: this.accountId, symbols: symbols.map((symbol) => ({ ...symbol })) });
    this.deps.log.info('published broker symbol list', { accountId: this.accountId, symbols: symbols.length });
  }

  /** The EA reported a closure; forward it for analytics. */
  private onTradeClosed(event: { trade: Position; closePrice: number; profit: number }): void {
    const ticket = event.trade.ticket;
    // Closed-trade events can be repeated by a polling EA; ignore duplicates
    // for a minute so analytics never double-counts a trade.
    const now = Date.now();
    const seenAt = this.recentClosedTickets.get(ticket);
    if (seenAt !== undefined && now - seenAt < 60_000) return;
    this.recentClosedTickets.set(ticket, now);
    if (this.recentClosedTickets.size > 1_000) {
      for (const [key, at] of this.recentClosedTickets) {
        if (now - at > 60_000) this.recentClosedTickets.delete(key);
      }
    }
    this.deps.emit({
      type: 'closed_trade',
      accountId: this.accountId,
      trade: {
        ticket,
        symbol: event.trade.symbol,
        side: event.trade.side,
        volume: event.trade.closedVolume || event.trade.volume,
        openPrice: event.trade.openPrice,
        closePrice: event.closePrice,
        stopLoss: event.trade.stopLoss ?? null,
        takeProfit: event.trade.takeProfit ?? null,
        magic: event.trade.magic ?? 0,
        comment: event.trade.comment ?? '',
        profit: event.profit,
        swap: event.trade.swap ?? 0,
        commission: event.trade.commission ?? 0,
        openedAt: event.trade.openedAt,
        closedAt: new Date().toISOString(),
      },
    });
  }

  /** Called by the heartbeat: keeps symbol/state pushes fresh even when idle. */
  async refresh(): Promise<void> {
    const symbols = await this.connector.listSymbols();
    if (symbols.ok && symbols.value.length > 0) this.emitSymbols(symbols.value);
    const positions = await this.connector.listPositions();
    if (positions.ok) this.onPositions(positions.value);
  }
}

function signatureOf(positions: readonly Position[]): string {
  return positions
    .map((position) => `${position.ticket}:${position.volume}:${position.stopLoss ?? ''}:${position.takeProfit ?? ''}:${position.kind}`)
    .sort()
    .join('|');
}

function hasChanged(positions: readonly Position[], previous: string): boolean {
  return signatureOf(positions) !== previous;
}

/** Broker numbers are decimal strings; keep 10 significant digits of precision. */
function roundPosition(position: Position): Position {
  const round = (value: number): number => Math.round(value * 1e10) / 1e10;
  return {
    ...position,
    volume: round(position.volume),
    openPrice: round(position.openPrice),
    currentPrice: position.currentPrice === null || position.currentPrice === undefined ? null : round(position.currentPrice),
    stopLoss: position.stopLoss === null || position.stopLoss === undefined ? null : round(position.stopLoss),
    takeProfit: position.takeProfit === null || position.takeProfit === undefined ? null : round(position.takeProfit),
  };
}

function filled(
  requestId: string,
  ticket: string,
  filledVolume: number,
  filledPrice: number,
  slippagePips: number | null,
  startedAt: number,
): BridgeInboundMessage {
  return {
    type: 'command.result',
    requestId,
    status: 'filled',
    ticket,
    filledVolume,
    filledPrice,
    closedVolume: null,
    errorCode: null,
    errorMessage: null,
    latencyMs: Date.now() - startedAt,
    message: slippagePips === null ? null : `slippage ${slippagePips.toFixed(2)} pips`,
  };
}

function accepted(requestId: string, ticket: string | null, startedAt: number): BridgeInboundMessage {
  return {
    type: 'command.result',
    requestId,
    status: 'accepted',
    ticket,
    filledVolume: null,
    filledPrice: null,
    closedVolume: null,
    errorCode: null,
    errorMessage: null,
    latencyMs: Date.now() - startedAt,
    message: null,
  };
}

function rejected(requestId: string, errorCode: string, errorMessage: string, startedAt: number): BridgeInboundMessage {
  return {
    type: 'command.result',
    requestId,
    status: 'rejected',
    ticket: null,
    filledVolume: null,
    filledPrice: null,
    closedVolume: null,
    errorCode,
    errorMessage,
    latencyMs: Date.now() - startedAt,
    message: null,
  };
}
