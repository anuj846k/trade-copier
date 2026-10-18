import type {
  AccountSnapshot,
  CopierErrorCode,
  PendingOrderType,
  Platform,
  Position,
  Quote,
  SymbolInfo,
  TradeSide,
} from '@trade-copier/contracts';
import type { Result } from '@trade-copier/domain';

/**
 * The broker integration boundary.
 *
 * Everything platform-specific lives behind `BrokerConnector`. The copy engine
 * only ever sees `Position`, `SymbolInfo`, `Quote` and `AccountSnapshot`
 * (contracts), plus the request types below, so a connector for MT4, MT5,
 * cTrader or a proprietary bridge is interchangeable.
 *
 * Connectors MUST NOT throw for expected failures (rejections, timeouts,
 * disconnects). They return `Result<T, BrokerError>`; only programming errors
 * throw.
 */
export interface BrokerError {
  /** Normalised taxonomy shared with the copier log and the UI. */
  readonly code: CopierErrorCode;
  readonly message: string;
  /** Raw broker/platform code, kept for support tickets. */
  readonly brokerCode?: string | number | null;
  readonly retryable?: boolean;
}

export interface BrokerCredentials {
  readonly login: string;
  readonly password: string;
  readonly server: string;
  /** Platform-specific extras (portable path, account id, api host …). */
  readonly extra?: Record<string, string> | undefined;
}

export interface BrokerCapabilities {
  readonly pendingOrders: boolean;
  readonly partialClose: boolean;
  readonly modifyStops: boolean;
  /** Allows an opposite position in the same symbol. */
  readonly hedging: boolean;
  /** One net position per symbol (opposite orders close instead of opening). */
  readonly netting: boolean;
  readonly closeAll: boolean;
  readonly quotes: boolean;
  /** Broker supports SL/TP attached to the order request (all MT-class do). */
  readonly tickValueReporting: boolean;
}

export interface MarketOrderRequest {
  /** Idempotency key derived from the copy decision (see domain/ids.ts). */
  readonly requestId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly volume: number;
  readonly stopLoss?: number | null;
  readonly takeProfit?: number | null;
  /** Maximum accepted deviation from the requested price, in pips. */
  readonly maxSlippagePips?: number | null;
  readonly magic?: number | null;
  readonly comment?: string | null;
}

export interface PendingOrderRequest {
  readonly requestId: string;
  readonly symbol: string;
  readonly side: TradeSide;
  readonly volume: number;
  readonly pendingType: PendingOrderType;
  readonly price: number;
  readonly stopLoss?: number | null;
  readonly takeProfit?: number | null;
  readonly expiry?: string | null;
  readonly magic?: number | null;
  readonly comment?: string | null;
}

export interface OrderFill {
  readonly ticket: string;
  readonly filledVolume: number;
  readonly filledPrice: number;
  /** Slippage actually experienced, in pips (positive = worse than requested). */
  readonly slippagePips?: number | null;
  readonly at: string;
}

export interface ModifyRequest {
  readonly ticket: string;
  readonly stopLoss?: number | null;
  readonly takeProfit?: number | null;
}

export interface CloseRequest {
  readonly ticket: string;
  /** null/undefined closes the whole remaining volume. */
  readonly volume?: number | null;
  readonly maxSlippagePips?: number | null;
  readonly comment?: string | null;
}

export interface CloseResult {
  readonly ticket: string;
  readonly closedVolume: number;
  readonly closePrice: number;
  /** Realised P/L of the closed part, in account currency. */
  readonly profit: number;
  /** True when nothing is left open after this close. */
  readonly fullyClosed: boolean;
  readonly at: string;
}

export type BrokerEvent =
  | { readonly kind: 'snapshot'; readonly snapshot: AccountSnapshot }
  | { readonly kind: 'positions'; readonly positions: readonly Position[] }
  | { readonly kind: 'trade_closed'; readonly trade: Position; readonly closePrice: number; readonly profit: number }
  | { readonly kind: 'disconnected'; readonly reason: string }
  | { readonly kind: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly kind: 'quote'; readonly quote: Quote };

export type BrokerEventHandler = (event: BrokerEvent) => void;

export interface BrokerConnector {
  readonly platform: Platform;
  /** Human-readable target (e.g. `MT5 12345678@ICMarkets-Live`). */
  readonly label: string;

  connect(): Promise<Result<AccountSnapshot, BrokerError>>;
  disconnect(): Promise<void>;
  ping(): Promise<Result<{ latencyMs: number }, BrokerError>>;

  listSymbols(): Promise<Result<SymbolInfo[], BrokerError>>;
  listPositions(): Promise<Result<Position[], BrokerError>>;
  getSnapshot(): Promise<Result<AccountSnapshot, BrokerError>>;
  getQuote(symbol: string): Promise<Result<Quote, BrokerError>>;

  placeMarketOrder(request: MarketOrderRequest): Promise<Result<OrderFill, BrokerError>>;
  placePendingOrder(request: PendingOrderRequest): Promise<Result<OrderFill, BrokerError>>;
  modifyPosition(request: ModifyRequest): Promise<Result<void, BrokerError>>;
  closePosition(request: CloseRequest): Promise<Result<CloseResult, BrokerError>>;
  cancelPendingOrder(ticket: string): Promise<Result<void, BrokerError>>;

  /** Emergency close: everything, or only copier-placed trades (by magic set). */
  closeAll(input: { reason: string; magic?: number | null; tickets?: readonly string[] | null }): Promise<Result<{ closed: number }, BrokerError>>;

  /** Live updates. Optional: polling-only connectors omit it. */
  subscribe?(handler: BrokerEventHandler): () => void;

  capabilities(): BrokerCapabilities;
}

/** Default capabilities for MT4/MT5-class platforms. */
export const MT_CLASS_CAPABILITIES: BrokerCapabilities = {
  pendingOrders: true,
  partialClose: true,
  modifyStops: true,
  hedging: true,
  netting: false,
  closeAll: true,
  quotes: true,
  tickValueReporting: true,
};

export function brokerError(
  code: CopierErrorCode,
  message: string,
  options: { brokerCode?: string | number | null; retryable?: boolean } = {},
): BrokerError {
  return { code, message, brokerCode: options.brokerCode ?? null, retryable: options.retryable ?? false };
}

/** Maps a connector's platform-specific numeric retcode into our taxonomy. */
export type BrokerRetcodeMapper = (retcode: number | string, context?: string) => BrokerError;
