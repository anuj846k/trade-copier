import type { AccountSnapshot, Platform, Position, Quote, SymbolInfo } from '@trade-copier/contracts';
import { derivePipSize, normalizeSymbol, classifyAssetClass, ok, err, type Result } from '@trade-copier/domain';
import {
  brokerError,
  MT_CLASS_CAPABILITIES,
  type BrokerCapabilities,
  type BrokerConnector,
  type BrokerError,
  type BrokerEvent,
  type BrokerEventHandler,
  type CloseRequest,
  type CloseResult,
  type MarketOrderRequest,
  type OrderFill,
  type PendingOrderRequest,
  type ModifyRequest,
} from './types.js';

export interface MockSymbolSpec {
  name: string;
  digits?: number;
  contractSize?: number;
  minLot?: number;
  maxLot?: number;
  lotStep?: number;
  maxLotPerOrder?: number | null;
  basePrice?: number;
  /** Typical spread in pips. */
  spreadPips?: number;
  tradeMode?: SymbolInfo['tradeMode'];
  quoteCurrency?: string;
}

export interface MockConnectorOptions {
  login?: string;
  server?: string;
  currency?: string;
  balance?: number;
  leverage?: number;
  symbols?: MockSymbolSpec[];
  /** Slippage applied to every fill, in pips (signed: positive = adverse). */
  slippagePips?: number;
  /** Deterministic RNG seed; identical seeds produce identical fills. */
  seed?: number;
  /**
   * First ticket number handed out. Defaults to a value derived from `seed`.
   *
   * The copy engine resolves a broker-reported close by `(account, ticket)`, so
   * a long-lived deployment whose mock tickets restarted at the same number on
   * every boot would attribute a new run's P/L to an earlier run's link. Real
   * terminals hand out monotonic tickets, so callers that are not a single test
   * process should pass a fresh base here.
   */
  ticketStart?: number;
  /** Simulated round-trip latency, in ms. */
  latencyMs?: number;
  /** Fraction of orders rejected (0..1) — exercises retry paths in tests. */
  rejectRate?: number;
  /** When false, market-hours gates are evaluated by the caller, not here. */
  alwaysOpen?: boolean;
  /** Watch-only connector: mutations fail with TRADE_DISABLED. */
  readOnly?: boolean;
  platform?: Platform;
}

const DEFAULT_SPECS: MockSymbolSpec[] = [
  { name: 'EURUSD', basePrice: 1.0850, spreadPips: 0.8, quoteCurrency: 'USD' },
  { name: 'GBPUSD', basePrice: 1.2650, spreadPips: 1.1, quoteCurrency: 'USD' },
  { name: 'USDJPY', basePrice: 149.5, digits: 3, spreadPips: 0.9, quoteCurrency: 'JPY' },
  { name: 'USDCAD', basePrice: 1.3600, spreadPips: 1.3, quoteCurrency: 'CAD' },
  { name: 'AUDUSD', basePrice: 0.6550, spreadPips: 1.0, quoteCurrency: 'USD' },
  { name: 'XAUUSD', basePrice: 2350.0, digits: 2, contractSize: 100, minLot: 0.01, spreadPips: 15, quoteCurrency: 'USD' },
  { name: 'US30', basePrice: 39_500, digits: 1, contractSize: 1, minLot: 0.1, spreadPips: 30, quoteCurrency: 'USD' },
  { name: 'BTCUSD', basePrice: 62_000, digits: 2, contractSize: 1, minLot: 0.01, spreadPips: 200, quoteCurrency: 'USD' },
];

/** Deterministic 32-bit PRNG (mulberry32) so mock runs are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * In-memory broker used by unit tests, the seeding script and the copy
 * simulator. It implements the same `BrokerConnector` contract as the real
 * MT4/MT5 bridge adapter, including fill slippage, rejections, partial closes
 * and floating P/L, so the engine can be tested end-to-end without a broker.
 */
export class MockConnector implements BrokerConnector {
  readonly platform: Platform;
  readonly label: string;

  private readonly options: Required<Pick<MockConnectorOptions, 'currency' | 'balance' | 'leverage' | 'slippagePips' | 'latencyMs' | 'rejectRate' | 'alwaysOpen' | 'readOnly'>>;
  private readonly random: () => number;
  private readonly handlers = new Set<BrokerEventHandler>();
  private readonly specs = new Map<string, SymbolInfo>();
  private readonly prices = new Map<string, number>();
  private positions = new Map<string, Position>();
  private ticketCounter: number;
  private connected = false;
  private forcedError: BrokerError | null = null;

  constructor(options: MockConnectorOptions = {}) {
    this.platform = options.platform ?? 'mock';
    this.label = `Mock ${options.login ?? '00000000'}@${options.server ?? 'Mock-Server'}`;
    this.ticketCounter = options.ticketStart ?? 10_000_000 + Math.floor((options.seed ?? 1) * 137);
    this.random = mulberry32(options.seed ?? 42);
    this.options = {
      currency: options.currency ?? 'USD',
      balance: options.balance ?? 100_000,
      leverage: options.leverage ?? 100,
      slippagePips: options.slippagePips ?? 0,
      latencyMs: options.latencyMs ?? 0,
      rejectRate: options.rejectRate ?? 0,
      alwaysOpen: options.alwaysOpen ?? true,
      readOnly: options.readOnly ?? false,
    };

    for (const spec of options.symbols ?? DEFAULT_SPECS) {
      const info = this.buildSymbolInfo(spec);
      this.specs.set(info.name, info);
      this.prices.set(info.name, spec.basePrice ?? 1);
    }
  }

  // --- test helpers --------------------------------------------------------

  /** Moves the market so tests can drive SL/TP and slippage scenarios. */
  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /** Injects a one-shot broker error (next mutating call fails). */
  failNext(error: BrokerError): void {
    this.forcedError = error;
  }

  /** Adds a position that was not created through this connector. */
  seedPosition(partial: Partial<Position> & { symbol: string }): Position {
    const symbol = this.specs.get(partial.symbol);
    if (!symbol) throw new Error(`unknown symbol ${partial.symbol}`);
    const ticket = String(this.nextTicket());
    const position: Position = {
      ticket,
      symbol: partial.symbol,
      side: partial.side ?? 'buy',
      volume: partial.volume ?? 0.1,
      closedVolume: partial.closedVolume ?? 0,
      openPrice: partial.openPrice ?? this.prices.get(partial.symbol) ?? 1,
      currentPrice: partial.currentPrice ?? this.prices.get(partial.symbol) ?? 1,
      stopLoss: partial.stopLoss ?? null,
      takeProfit: partial.takeProfit ?? null,
      kind: partial.kind ?? 'market',
      pendingType: partial.pendingType ?? null,
      expiry: partial.expiry ?? null,
      magic: partial.magic ?? 0,
      comment: partial.comment ?? '',
      originRequestId: partial.originRequestId ?? null,
      openedAt: partial.openedAt ?? new Date().toISOString(),
      updatedAt: partial.updatedAt,
      profit: partial.profit ?? 0,
      swap: 0,
      commission: 0,
    };
    this.positions.set(ticket, position);
    return position;
  }

  get openPositions(): readonly Position[] {
    return [...this.positions.values()];
  }

  // --- BrokerConnector ----------------------------------------------------

  capabilities(): BrokerCapabilities {
    return MT_CLASS_CAPABILITIES;
  }

  async connect(): Promise<Result<AccountSnapshot, BrokerError>> {
    this.connected = true;
    this.emit({ kind: 'log', level: 'info', message: `${this.label} connected (mock)` });
    return this.getSnapshot();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit({ kind: 'disconnected', reason: 'client requested disconnect' });
  }

  async ping(): Promise<Result<{ latencyMs: number }, BrokerError>> {
    if (!this.connected) return err(brokerError('ACCOUNT_DISCONNECTED', 'Not connected', { retryable: true }));
    return ok({ latencyMs: this.options.latencyMs });
  }

  async listSymbols(): Promise<Result<SymbolInfo[], BrokerError>> {
    const failure = this.ensureConnected();
    if (failure) return err(failure);
    return ok([...this.specs.values()]);
  }

  async listPositions(): Promise<Result<Position[], BrokerError>> {
    const failure = this.ensureConnected();
    if (failure) return err(failure);
    return ok(this.refreshFloating().map((position) => ({ ...position })));
  }

  async getSnapshot(): Promise<Result<AccountSnapshot, BrokerError>> {
    const failure = this.ensureConnected();
    if (failure) return err(failure);
    const positions = this.refreshFloating();
    const floating = positions.reduce((sum, position) => sum + (position.profit ?? 0), 0);
    const margin = positions.reduce(
      (sum, position) => sum + (position.volume * (this.specs.get(position.symbol)?.contractSize ?? 100_000) * (position.currentPrice ?? 1)) / this.options.leverage,
      0,
    );
    const snapshot: AccountSnapshot = {
      accountId: 'mock',
      balance: this.options.balance,
      equity: this.options.balance + floating,
      margin,
      freeMargin: this.options.balance + floating - margin,
      marginLevel: margin > 0 ? ((this.options.balance + floating) / margin) * 100 : null,
      currency: this.options.currency,
      leverage: this.options.leverage,
      at: new Date().toISOString(),
    };
    this.emit({ kind: 'snapshot', snapshot });
    return ok(snapshot);
  }

  async getQuote(symbol: string): Promise<Result<Quote, BrokerError>> {
    const info = this.specs.get(symbol);
    if (!info) return err(brokerError('SYMBOL_NOT_MAPPED', `Symbol ${symbol} is not offered by ${this.label}`));
    const mid = this.prices.get(symbol) ?? 1;
    const spread = (info.pipSize * (info.assetClass === 'forex' ? 1 : 2)) + info.pipSize * this.options.slippagePips * 0;
    const quote: Quote = {
      symbol,
      bid: round(mid - spread / 2, info.digits),
      ask: round(mid + spread / 2, info.digits),
      at: new Date().toISOString(),
    };
    this.emit({ kind: 'quote', quote });
    return ok(quote);
  }

  async placeMarketOrder(request: MarketOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const failure = this.beforeMutation(request.symbol);
    if (failure) return err(failure);
    const info = this.specs.get(request.symbol)!;

    const volumeError = this.validateVolume(info, request.volume);
    if (volumeError) return err(volumeError);

    const quote = this.quoteFor(info);
    const requestedPrice = request.side === 'buy' ? quote.ask : quote.bid;
    const adversePips = this.options.slippagePips + (this.options.slippagePips === 0 ? 0 : this.random() * this.options.slippagePips);
    const slippage = request.side === 'buy' ? 1 : -1;
    const filledPrice = round(requestedPrice + slippage * adversePips * info.pipSize, info.digits);

    if (request.maxSlippagePips !== null && request.maxSlippagePips !== undefined && adversePips > request.maxSlippagePips) {
      return err(
        brokerError('SLIPPAGE_EXCEEDED', `Fill would slip ${adversePips.toFixed(1)} pips (tolerance ${request.maxSlippagePips})`, {
          retryable: true,
        }),
      );
    }

    if (this.capabilities().netting) {
      const opposite = [...this.positions.values()].find(
        (position) => position.symbol === request.symbol && position.side !== request.side,
      );
      if (opposite) {
        // Netting: an opposite order reduces/exceeds the existing position.
        if (request.volume <= opposite.volume) {
          await this.closePosition({ ticket: opposite.ticket, volume: request.volume });
          return ok({ ticket: opposite.ticket, filledVolume: request.volume, filledPrice, slippagePips: adversePips, at: new Date().toISOString() });
        }
      }
    }

    const ticket = String(this.nextTicket());
    const position: Position = {
      ticket,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      closedVolume: 0,
      openPrice: filledPrice,
      currentPrice: filledPrice,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      kind: 'market',
      pendingType: null,
      expiry: null,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
      originRequestId: request.requestId,
      openedAt: new Date().toISOString(),
      profit: 0,
      swap: 0,
      commission: 0,
    };
    this.positions.set(ticket, position);
    this.emitPositions();
    return ok({ ticket, filledVolume: request.volume, filledPrice, slippagePips: adversePips, at: position.openedAt });
  }

  async placePendingOrder(request: PendingOrderRequest): Promise<Result<OrderFill, BrokerError>> {
    const failure = this.beforeMutation(request.symbol);
    if (failure) return err(failure);
    const info = this.specs.get(request.symbol)!;
    const volumeError = this.validateVolume(info, request.volume);
    if (volumeError) return err(volumeError);

    const ticket = String(this.nextTicket());
    const position: Position = {
      ticket,
      symbol: request.symbol,
      side: request.side,
      volume: request.volume,
      closedVolume: 0,
      openPrice: request.price,
      currentPrice: request.price,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      kind: 'pending',
      pendingType: request.pendingType,
      expiry: request.expiry ?? null,
      magic: request.magic ?? 0,
      comment: request.comment ?? '',
      originRequestId: request.requestId,
      openedAt: new Date().toISOString(),
      profit: 0,
      swap: 0,
      commission: 0,
    };
    this.positions.set(ticket, position);
    this.emitPositions();
    return ok({ ticket, filledVolume: 0, filledPrice: request.price, at: position.openedAt });
  }

  async modifyPosition(request: ModifyRequest): Promise<Result<void, BrokerError>> {
    const failure = this.beforeMutation();
    if (failure) return err(failure);
    const position = this.positions.get(request.ticket);
    if (!position) return err(brokerError('TICKET_NOT_FOUND', `Ticket ${request.ticket} not found`));
    const info = this.specs.get(position.symbol)!;
    if (request.stopLoss !== undefined) position.stopLoss = request.stopLoss === null ? null : round(request.stopLoss, info.digits);
    if (request.takeProfit !== undefined) position.takeProfit = request.takeProfit === null ? null : round(request.takeProfit, info.digits);
    position.updatedAt = new Date().toISOString();
    this.positions.set(request.ticket, position);
    this.emitPositions();
    return ok(undefined);
  }

  async closePosition(request: CloseRequest): Promise<Result<CloseResult, BrokerError>> {
    const failure = this.beforeMutation();
    if (failure) return err(failure);
    const position = this.positions.get(request.ticket);
    if (!position) return err(brokerError('TICKET_NOT_FOUND', `Ticket ${request.ticket} not found`));
    const info = this.specs.get(position.symbol)!;

    const closeVolume = Math.min(request.volume ?? position.volume, position.volume);
    if (!(closeVolume > 0)) return err(brokerError('VALIDATION', 'Close volume must be positive'));

    const quote = this.quoteFor(info);
    const price = position.side === 'buy' ? quote.bid : quote.ask;
    const profit = round(profitFor(position, price, closeVolume, info.contractSize), 2);

    position.closedVolume += closeVolume;
    position.volume = round(position.volume - closeVolume, 4);
    const fullyClosed = position.volume <= 0.0000001;
    if (fullyClosed) {
      this.positions.delete(request.ticket);
      this.emit({ kind: 'trade_closed', trade: position, closePrice: price, profit });
    } else {
      position.profit = round((position.profit ?? 0) - 0, 2);
      this.positions.set(position.ticket, position);
      this.emit({ kind: 'trade_closed', trade: { ...position, volume: closeVolume }, closePrice: price, profit });
    }
    this.emitPositions();

    return ok({
      ticket: request.ticket,
      closedVolume: closeVolume,
      closePrice: round(price, info.digits),
      profit,
      fullyClosed,
      at: new Date().toISOString(),
    });
  }

  async cancelPendingOrder(ticket: string): Promise<Result<void, BrokerError>> {
    const failure = this.beforeMutation();
    if (failure) return err(failure);
    const position = this.positions.get(ticket);
    if (!position) return err(brokerError('TICKET_NOT_FOUND', `Ticket ${ticket} not found`));
    if (position.kind !== 'pending') return err(brokerError('VALIDATION', `Ticket ${ticket} is not a pending order`));
    this.positions.delete(ticket);
    this.emitPositions();
    return ok(undefined);
  }

  async closeAll(input: {
    reason: string;
    magic?: number | null;
    tickets?: readonly string[] | null;
  }): Promise<Result<{ closed: number }, BrokerError>> {
    const failure = this.beforeMutation();
    if (failure) return err(failure);
    const targets = [...this.positions.values()].filter((position) => {
      if (input.tickets && input.tickets.length > 0) return input.tickets.includes(position.ticket);
      if (input.magic !== null && input.magic !== undefined) return position.magic === input.magic;
      return true;
    });
    for (const position of targets) {
      await this.closePosition({ ticket: position.ticket, comment: input.reason });
    }
    return ok({ closed: targets.length });
  }

  subscribe(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // --- internals -----------------------------------------------------------

  private ensureConnected(): BrokerError | null {
    if (!this.connected) return brokerError('ACCOUNT_DISCONNECTED', 'Connector is not connected', { retryable: true });
    return null;
  }

  private beforeMutation(symbol?: string): BrokerError | null {
    const connection = this.ensureConnected();
    if (connection) return connection;
    if (this.options.readOnly) return brokerError('TRADE_DISABLED', 'Connector is read-only (investor password)');
    if (this.forcedError) {
      const error = this.forcedError;
      this.forcedError = null;
      return error;
    }
    if (this.options.rejectRate > 0 && this.random() < this.options.rejectRate) {
      return brokerError('BROKER_REJECTED', 'Simulated broker rejection', { retryable: true, brokerCode: 10004 });
    }
    if (symbol && !this.specs.has(symbol)) {
      return brokerError('SYMBOL_MISMATCH', `Symbol ${symbol} is not offered by ${this.label}`);
    }
    return null;
  }

  private validateVolume(info: SymbolInfo, volume: number): BrokerError | null {
    if (volume < info.minLot) return brokerError('VOLUME_TOO_SMALL', `${volume} is below the minimum lot ${info.minLot} for ${info.name}`);
    if (volume > info.maxLot) return brokerError('VOLUME_TOO_LARGE', `${volume} is above the maximum lot ${info.maxLot} for ${info.name}`);
    const cap = info.maxLotPerOrder ?? info.maxLot;
    if (volume > cap) return brokerError('VOLUME_TOO_LARGE', `${volume} exceeds the per-order cap ${cap} for ${info.name}`);
    if (info.tradeMode !== 'full' && info.tradeMode !== 'long_only' && info.tradeMode !== 'short_only') {
      return brokerError('TRADE_DISABLED', `${info.name} is not tradable (${info.tradeMode})`);
    }
    return null;
  }

  private quoteFor(info: SymbolInfo): Quote {
    const mid = this.prices.get(info.name) ?? 1;
    const spread = info.pipSize * (info.assetClass === 'forex' ? 0.8 : 1.5);
    return {
      symbol: info.name,
      bid: round(mid - spread / 2, info.digits),
      ask: round(mid + spread / 2, info.digits),
      at: new Date().toISOString(),
    };
  }

  private refreshFloating(): Position[] {
    const out: Position[] = [];
    for (const position of this.positions.values()) {
      if (position.kind === 'pending') {
        out.push(position);
        continue;
      }
      const info = this.specs.get(position.symbol);
      if (!info) continue;
      const price = this.prices.get(position.symbol) ?? position.openPrice;
      position.currentPrice = price;
      position.profit = round(profitFor(position, price, position.volume, info.contractSize), 2);
      out.push(position);
    }
    return out;
  }

  private emit(event: BrokerEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private emitPositions(): void {
    this.emit({ kind: 'positions', positions: this.refreshFloating().map((position) => ({ ...position })) });
  }

  private nextTicket(): number {
    this.ticketCounter += 1;
    return this.ticketCounter;
  }

  private buildSymbolInfo(spec: MockSymbolSpec): SymbolInfo {
    const normalized = normalizeSymbol(spec.name);
    const digits = spec.digits ?? 5;
    const pipSize = derivePipSize(digits);
    const point = round(Math.pow(10, -digits), digits + 2);
    return {
      name: spec.name,
      canonical: normalized.canonical,
      assetClass: classifyAssetClass(normalized.canonical),
      digits,
      point: point === 0 ? pipSize / 10 : point,
      pipSize,
      contractSize: spec.contractSize ?? 100_000,
      minLot: spec.minLot ?? 0.01,
      maxLot: spec.maxLot ?? 100,
      lotStep: spec.lotStep ?? 0.01,
      tradeMode: spec.tradeMode ?? 'full',
      enabled: true,
      quoteCurrency: spec.quoteCurrency ?? 'USD',
      maxLotPerOrder: spec.maxLotPerOrder ?? null,
      swapLong: null,
      swapShort: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** P/L in account currency for a position slice (quote-currency = account). */
export function profitFor(position: Position, price: number, volume: number, contractSize: number): number {
  const delta = position.side === 'buy' ? price - position.openPrice : position.openPrice - price;
  return delta * volume * contractSize;
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
