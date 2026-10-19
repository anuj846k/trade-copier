import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  AccountSnapshot,
  PendingOrderType,
  Platform,
  Position,
  Quote,
  SymbolInfo,
  TradeSide,
} from '@trade-copier/contracts';
import {
  positionSchema,
  accountSnapshotSchema,
  symbolInfoSchema,
  quoteSchema,
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
 * MT4/MT5 bridge.
 *
 * MetaTrader terminals cannot be driven from the outside without either a
 * compiled DLL or an Expert Advisor that polls us. We use the polling EA:
 * the EA performs one HTTP round trip per interval that simultaneously
 *   - pushes terminal state (account snapshot, symbols, positions, events), and
 *   - pulls the next batch of trade commands.
 *
 * That design needs no native code, works identically on MT4 and MT5 (the EA
 * differs only in the order-send API), and keeps a single ordering point.
 *
 * Latency is bounded by the poll interval (`pollIntervalMs`, default 250 ms) —
 * i.e. worst case copy latency ≈ poll interval + broker execution, NOT the
 * "20-30 ms" marketing figure some vendors quote.
 */

export interface EaPollMessage {
  /** Agent-issued session token, checked against the expected value. */
  token?: string;
  account?: string;
  version?: string;
  platform?: 'mt4' | 'mt5';
  snapshot?: unknown;
  symbols?: unknown[];
  positions?: unknown[];
  /** Results for commands handed out in previous polls. */
  results?: EaCommandResult[];
  /** Free-form terminal events (order rejected, trade closed by SL …). */
  events?: EaEvent[];
}

export interface EaCommandResult {
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; brokerCode?: string | number | null };
}

export interface EaEvent {
  kind: 'trade_opened' | 'trade_closed' | 'trade_modified' | 'log' | 'error';
  ticket?: string;
  symbol?: string;
  side?: TradeSide;
  volume?: number;
  /** Volume actually closed — a partial close reports less than the position held. */
  closedVolume?: number;
  price?: number;
  /** Entry price, when the EA can still see it; improves realised-P/L attribution. */
  openPrice?: number;
  profit?: number;
  swap?: number;
  commission?: number;
  magic?: number;
  comment?: string;
  message?: string;
  at?: string;
}

interface PendingCommand {
  requestId: string;
  kind: 'open' | 'place_pending' | 'modify' | 'close' | 'close_partial' | 'cancel_pending' | 'close_all' | 'ping' | 'list_symbols' | 'list_positions' | 'get_snapshot' | 'get_quote';
  params: Record<string, unknown>;
  resolve: (result: EaCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  /** How many polls have carried this command. */
  sendCount: number;
  lastSentAt: number | null;
}

export interface BridgeConnectorOptions {
  platform?: Platform;
  label?: string;
  /** Expected EA token; requests without it are rejected. */
  token: string;
  port?: number;
  host?: string;
  /** How long to wait for the EA before failing a command. */
  commandTimeoutMs?: number;
  /** Max commands handed out per poll (back-pressure). */
  maxCommandsPerPoll?: number;
  /** Map a broker retcode string onto our taxonomy (per-platform overrides). */
  mapRetcode?: (retcode: string | number, message: string) => BrokerError;
}

export class BridgeConnector implements BrokerConnector {
  readonly platform: Platform;
  readonly label: string;

  private server: Server | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly handlers = new Set<BrokerEventHandler>();
  private lastSnapshot: AccountSnapshot | null = null;
  private symbols: SymbolInfo[] = [];
  private positions: Position[] = [];
  private lastPollAt: number | null = null;
  private eaVersion: string | null = null;

  constructor(private readonly options: BridgeConnectorOptions) {
    this.platform = options.platform ?? 'mt5';
    this.label = options.label ?? `EA bridge on ${options.host ?? '127.0.0.1'}:${options.port ?? 8787}`;
  }

  capabilities(): BrokerCapabilities {
    return MT_CLASS_CAPABILITIES;
  }

  /** Starts the local HTTP endpoint the EA polls. */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 8787 };
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(this.options.port ?? 8787, this.options.host ?? '127.0.0.1', resolve));
    this.server = server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : (this.options.port ?? 8787);
    return { host: this.options.host ?? '127.0.0.1', port };
  }

  async closeServer(): Promise<void> {
    for (const command of this.pending.values()) {
      clearTimeout(command.timeout);
      command.reject(new Error('bridge server closed'));
    }
    this.pending.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /** ms since the EA last polled; null when the EA never connected. */
  eaAgeMs(): number | null {
    return this.lastPollAt === null ? null : Date.now() - this.lastPollAt;
  }

  // --- BrokerConnector -----------------------------------------------------

  async connect(): Promise<Result<AccountSnapshot, BrokerError>> {
    const listen = await this.listen();
    void listen;
    if (!this.lastSnapshot) {
      return err(
        brokerError('BRIDGE_TIMEOUT', 'Waiting for the Expert Advisor to poll the bridge endpoint', { retryable: true }),
      );
    }
    return ok(this.lastSnapshot);
  }

  async disconnect(): Promise<void> {
    await this.closeServer();
  }

  async ping(): Promise<Result<{ latencyMs: number }, BrokerError>> {
    const age = this.eaAgeMs();
    if (age === null || age > 10_000) {
      return err(brokerError('BRIDGE_TIMEOUT', `Expert Advisor has not polled for ${age ?? '∞'} ms`, { retryable: true }));
    }
    return ok({ latencyMs: age });
  }

  async listSymbols(): Promise<Result<SymbolInfo[], BrokerError>> {
    return ok(this.symbols);
  }

  async listPositions(): Promise<Result<Position[], BrokerError>> {
    return ok(this.positions);
  }

  async getSnapshot(): Promise<Result<AccountSnapshot, BrokerError>> {
    if (!this.lastSnapshot) return err(brokerError('BRIDGE_TIMEOUT', 'No account snapshot received yet', { retryable: true }));
    return ok(this.lastSnapshot);
  }

  async getQuote(symbol: string): Promise<Result<Quote, BrokerError>> {
    const command = await this.dispatch('get_quote', { symbol });
    if (!command.ok) return err(this.toError(command));
    const parsed = quoteSchema.safeParse(command.data);
    if (!parsed.success) return err(brokerError('VALIDATION', `EA returned an invalid quote for ${symbol}`));
    return ok(parsed.data);
  }

  async placeMarketOrder(request: MarketOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const result = await this.dispatch('open', {
      requestId: request.requestId,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      maxSlippagePips: request.maxSlippagePips ?? null,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
    });
    return this.toFill(result);
  }

  async placePendingOrder(request: PendingOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const result = await this.dispatch('place_pending', {
      requestId: request.requestId,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      pendingType: request.pendingType,
      price: request.price,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      expiry: request.expiry ?? null,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
    });
    return this.toFill(result);
  }

  async modifyPosition(request: ModifyRequest): Promise<Result<void, BrokerError>> {
    const result = await this.dispatch('modify', {
      ticket: request.ticket,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
    });
    return result.ok ? ok(undefined) : err(this.toError(result));
  }

  async closePosition(request: CloseRequest): Promise<Result<CloseResult, BrokerError>> {
    const result = await this.dispatch(request.volume ? 'close_partial' : 'close', {
      ticket: request.ticket,
      volume: request.volume ?? null,
      maxSlippagePips: request.maxSlippagePips ?? null,
      comment: request.comment ?? '',
    });
    if (!result.ok) return err(this.toError(result));
    const data = result.data ?? {};
    return ok({
      ticket: request.ticket,
      closedVolume: Number(data.closedVolume ?? request.volume ?? 0),
      closePrice: Number(data.closePrice ?? 0),
      profit: Number(data.profit ?? 0),
      fullyClosed: Boolean(data.fullyClosed ?? !request.volume),
      at: String(data.at ?? new Date().toISOString()),
    });
  }

  async cancelPendingOrder(ticket: string): Promise<Result<void, BrokerError>> {
    const result = await this.dispatch('cancel_pending', { ticket });
    return result.ok ? ok(undefined) : err(this.toError(result));
  }

  async closeAll(input: { reason: string; magic?: number | null; tickets?: readonly string[] | null }): Promise<Result<{ closed: number }, BrokerError>> {
    const result = await this.dispatch('close_all', {
      reason: input.reason,
      magic: input.magic ?? null,
      tickets: input.tickets ?? null,
    });
    if (!result.ok) return err(this.toError(result));
    return ok({ closed: Number(result.data?.closed ?? 0) });
  }

  subscribe(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // --- internals -----------------------------------------------------------

  private async dispatch(
    kind: PendingCommand['kind'],
    params: Record<string, unknown>,
  ): Promise<EaCommandResult> {
    const requestId = randomUUID();
    const timeoutMs = this.options.commandTimeoutMs ?? 15_000;
    const promise = new Promise<EaCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ requestId, ok: false, error: { code: 'BRIDGE_TIMEOUT', message: `EA did not answer ${kind} within ${timeoutMs} ms` } });
      }, timeoutMs);
      this.pending.set(requestId, { requestId, kind, params, resolve, reject, timeout, sendCount: 0, lastSentAt: null });
    });
    return promise;
  }

  private toFill(result: EaCommandResult): Result<OrderFill, BrokerError> {
    if (!result.ok) return err(this.toError(result));
    const data = result.data ?? {};
    const ticket = data.ticket === undefined || data.ticket === null ? '' : String(data.ticket);
    if (!ticket) return err(brokerError('BROKER_REJECTED', 'EA returned a fill without a ticket'));
    return ok({
      ticket,
      filledVolume: Number(data.filledVolume ?? data.volume ?? 0),
      filledPrice: Number(data.filledPrice ?? data.price ?? 0),
      slippagePips: data.slippagePips === undefined ? null : Number(data.slippagePips),
      at: String(data.at ?? new Date().toISOString()),
    });
  }

  private toError(result: EaCommandResult): BrokerError {
    const raw = result.error ?? {};
    const message = raw.message ?? 'The Expert Advisor reported a failure';
    if (this.options.mapRetcode && raw.brokerCode !== undefined && raw.brokerCode !== null) {
      return this.options.mapRetcode(raw.brokerCode, message);
    }
    const code = (raw.code ?? 'BROKER_REJECTED') as BrokerError['code'];
    return brokerError(code, message, { brokerCode: raw.brokerCode ?? null, retryable: code === 'BRIDGE_TIMEOUT' });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !request.url?.startsWith('/ea')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const body = await readBody(request);
    let message: EaPollMessage;
    try {
      message = JSON.parse(body || '{}') as EaPollMessage;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    if (this.options.token && message.token !== this.options.token) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid token' }));
      return;
    }

    this.lastPollAt = Date.now();
    if (message.version) this.eaVersion = message.version;
    this.ingestState(message);
    this.settleResults(message.results ?? []);

    const batch = this.takeCommands(this.options.maxCommandsPerPoll ?? 20);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        serverTime: new Date().toISOString(),
        commands: batch,
        // The EA uses this to throttle its poll loop adaptively.
        pollIntervalMs: 250,
      }),
    );
  }

  private ingestState(message: EaPollMessage): void {
    if (message.snapshot) {
      const parsed = accountSnapshotSchema.safeParse(message.snapshot);
      if (parsed.success) {
        this.lastSnapshot = parsed.data;
        for (const handler of this.handlers) handler({ kind: 'snapshot', snapshot: parsed.data });
      }
    }
    if (Array.isArray(message.symbols)) {
      const parsed = message.symbols
        .map((symbol) => symbolInfoSchema.safeParse(symbol))
        .filter((result): result is { success: true; data: SymbolInfo } => result.success)
        .map((result) => result.data);
      if (parsed.length > 0) this.symbols = parsed;
    }
    if (Array.isArray(message.positions)) {
      const parsed = message.positions
        .map((position) => positionSchema.safeParse(position))
        .filter((result): result is { success: true; data: Position } => result.success)
        .map((result) => result.data);
      this.positions = parsed;
      for (const handler of this.handlers) handler({ kind: 'positions', positions: parsed });
    }
    for (const event of message.events ?? []) {
      if (event.kind === 'trade_closed' && event.ticket) {
        const trade = this.positions.find((position) => position.ticket === event.ticket);
        for (const handler of this.handlers) {
          handler({
            kind: 'trade_closed',
            trade: trade ?? ({
              ticket: event.ticket,
              symbol: event.symbol ?? '',
              side: event.side ?? 'buy',
              volume: event.volume ?? 0,
              closedVolume: event.closedVolume ?? event.volume ?? 0,
              openPrice: event.openPrice ?? event.price ?? 0,
              currentPrice: event.price ?? null,
              stopLoss: null,
              takeProfit: null,
              kind: 'market',
              pendingType: null,
              expiry: null,
              magic: event.magic ?? 0,
              comment: event.comment ?? '',
              originRequestId: null,
              openedAt: event.at ?? new Date().toISOString(),
              profit: event.profit ?? null,
              swap: event.swap ?? 0,
              commission: event.commission ?? 0,
            } satisfies Position),
            closePrice: event.price ?? 0,
            profit: event.profit ?? 0,
          });
        }
      }
      if (event.kind === 'error' && event.message) {
        for (const handler of this.handlers) handler({ kind: 'log', level: 'error', message: event.message });
      }
    }
  }

  private settleResults(results: readonly EaCommandResult[]): void {
    for (const result of results) {
      const pending = this.pending.get(result.requestId);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(result.requestId);
      pending.resolve(result);
    }
  }

  /**
   * Hands out commands to the EA.
   *
   * A command that was already sent is not repeated on the very next poll (the
   * EA may still be executing it); it is re-sent only if the EA seems to have
   * missed it, which keeps execution at-most-once under normal operation and
   * at-least-once when a poll is lost.
   */
  private takeCommands(limit: number): Array<{ requestId: string; kind: string; params: Record<string, unknown> }> {
    const out: Array<{ requestId: string; kind: string; params: Record<string, unknown> }> = [];
    const now = Date.now();
    const resendAfterMs = 5_000;
    for (const [requestId, command] of this.pending) {
      if (out.length >= limit) break;
      if (command.lastSentAt !== null && now - command.lastSentAt < resendAfterMs) continue;
      command.lastSentAt = now;
      command.sendCount += 1;
      out.push({ requestId, kind: command.kind, params: command.params });
    }
    return out;
  }

  /** Version/health summary surfaced in the dashboard. */
  status() {
    return {
      platform: this.platform,
      label: this.label,
      eaVersion: this.eaVersion,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      ageMs: this.eaAgeMs(),
      pendingCommands: this.pending.size,
      symbols: this.symbols.length,
      positions: this.positions.length,
    };
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Pending order types the EA understands (kept for the protocol docs). */
export const EA_PENDING_TYPES: readonly PendingOrderType[] = [
  'buy_limit',
  'sell_limit',
  'buy_stop',
  'sell_stop',
  'buy_stop_limit',
  'sell_stop_limit',
];
