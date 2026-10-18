import { z } from 'zod';

/**
 * Machine-readable failure taxonomy surfaced in copier logs and notifications.
 * Mirrors the reference product's documented error codes
 * (docs `trade-copier/error-codes`) plus copier-side gate reasons.
 */
export const copierErrorCodeSchema = z.enum([
  // --- symbol / symbol mapping -------------------------------------------------
  'SYMBOL_NOT_MAPPED',
  'SYMBOL_DISABLED',
  'SYMBOL_MISMATCH',
  // --- account / copier state --------------------------------------------------
  'COPIER_DISABLED',
  'FOLLOWER_DISABLED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_DISCONNECTED',
  'AGENT_OFFLINE',
  // --- filters / schedule ------------------------------------------------------
  'FILTERED_MAGIC',
  'FILTERED_COMMENT',
  'FILTERED_SIDE',
  'FILTERED_LOT',
  'FILTERED_SYMBOL',
  'OUTSIDE_TRADING_HOURS',
  // --- protection --------------------------------------------------------------
  'EQUITY_PROTECTION',
  'INSUFFICIENT_MARGIN',
  // --- broker / execution ------------------------------------------------------
  'MARKET_CLOSED',
  'TRADE_DISABLED',
  'INVALID_VOLUME',
  'INVALID_PRICE',
  'INVALID_SLTP',
  'OFF_QUOTES',
  'REQUOTE',
  'NO_MONEY',
  'PRICE_CHANGED',
  'TICKET_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'LIMIT_ORDERS_DISABLED',
  'TOO_MANY_REQUESTS',
  'BROKER_ERROR',
  'UNKNOWN_SYMBOL',
  // --- copier-side guards ------------------------------------------------------
  'STALE_QUOTE',
  'SPREAD_TOO_WIDE',
  'SLIPPAGE_EXCEEDED',
  'ORDER_EXPIRED',
  'CONTRACT_MISMATCH',
  'VOLUME_CHANGED',
  'DUPLICATE_REQUEST',
  // --- benign informational skips (expected behaviour, not failures) --------
  'PENDING_DEFERRED',
  'STRICT_CLOSE_IGNORED',
  'NOT_COPIED',
  'RECONNECT_MISMATCH',
  'TIMEOUT',
  // --- agent / bridge transport --------------------------------
  'BRIDGE_TIMEOUT',
  'AGENT_VERSION_MISMATCH',
  'LINK_CLOSED',
  // --- broker rejections with a dedicated message -----------------
  'BROKER_REJECTED',
  'VOLUME_TOO_SMALL',
  'VOLUME_TOO_LARGE',
  'QUOTE_UNAVAILABLE',
  'NOT_IMPLEMENTED',
  'VALIDATION',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type CopierErrorCode = z.infer<typeof copierErrorCodeSchema>;

export interface CopierErrorMeta {
  /** Whether the dispatcher should keep retrying inside the retry window. */
  readonly retryable: boolean;
  /** Short user-facing message (docs-style). */
  readonly message: string;
  /** Actionable hint shown in logs / notifications. */
  readonly hint: string;
  /** Default log severity when this failure is recorded. */
  readonly level: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Error catalogue. Strings are intentionally user-facing and mirror the
 * reference docs wording where the semantics line up.
 */
export const ERROR_CATALOG: Record<CopierErrorCode, CopierErrorMeta> = {
  SYMBOL_NOT_MAPPED: {
    retryable: false,
    message: 'Symbol is not mapped for this slave account.',
    hint: 'Map the master symbol to the slave symbol (Map Symbols) or run auto-mapping.',
    level: 'error',
  },
  SYMBOL_DISABLED: {
    retryable: false,
    message: 'Symbol is deactivated or mapped incorrectly.',
    hint: 'Enable the symbol on the trading account, or map it to the tradeable variant (for example EURUSD -> EURUSD.e8).',
    level: 'error',
  },
  SYMBOL_MISMATCH: {
    retryable: false,
    message: 'Several symbol variants exist and none is selected.',
    hint: 'Select the suffix you actually trade (for example EURUSD.mini).',
    level: 'error',
  },
  COPIER_DISABLED: {
    retryable: false,
    message: 'Copier is disabled.',
    hint: 'Enable the copier (or use Disabled - Monitor Existing to only manage open trades).',
    level: 'info',
  },
  FOLLOWER_DISABLED: {
    retryable: false,
    message: 'Slave is disabled.',
    hint: 'Enable the slave on the copier row.',
    level: 'info',
  },
  ACCOUNT_DISABLED: {
    retryable: false,
    message: 'Trading account is disabled.',
    hint: 'Enable the account under Accounts.',
    level: 'info',
  },
  ACCOUNT_DISCONNECTED: {
    retryable: true,
    message: 'Trading account is not connected.',
    hint: 'Check connection status and the bridge agent / broker credentials.',
    level: 'warn',
  },
  AGENT_OFFLINE: {
    retryable: true,
    message: 'Bridge agent is offline.',
    hint: 'Restart the bridge agent; queued copies will be retried when it reconnects.',
    level: 'warn',
  },
  FILTERED_MAGIC: {
    retryable: false,
    message: 'Trade ignored by magic number filter.',
    hint: 'Adjust the magic number filter to include this expert advisor.',
    level: 'info',
  },
  FILTERED_COMMENT: {
    retryable: false,
    message: 'Trade ignored by comment filter.',
    hint: 'Adjust the comment filter.',
    level: 'info',
  },
  FILTERED_SIDE: {
    retryable: false,
    message: 'Trade side filter excludes this trade.',
    hint: 'Set the trade side filter to All Trades to copy buys and sells.',
    level: 'info',
  },
  FILTERED_LOT: {
    retryable: false,
    message: 'Master lot size is outside the configured range.',
    hint: 'Widen the minimum/maximum lot filter.',
    level: 'info',
  },
  FILTERED_SYMBOL: {
    retryable: false,
    message: 'Symbol is excluded by the copier filter.',
    hint: 'Remove the symbol exclusion or add the symbol to the include list.',
    level: 'info',
  },
  OUTSIDE_TRADING_HOURS: {
    retryable: false,
    message: 'Outside configured trading hours.',
    hint: 'New trades are only copied inside the configured windows; existing trades continue to be managed.',
    level: 'info',
  },
  EQUITY_PROTECTION: {
    retryable: false,
    message: 'Equity Protection is active for this account.',
    hint: 'Review the Equity Protection limits and re-enable the copier.',
    level: 'warn',
  },
  INSUFFICIENT_MARGIN: {
    retryable: true,
    message: 'Not enough free margin to open the requested volume.',
    hint: 'Reduce the risk multiplier or deposit funds.',
    level: 'error',
  },
  MARKET_CLOSED: {
    retryable: true,
    message: 'Market is closed with the broker.',
    hint: 'Copying is retried for the retry window; avoid trading during swap/maintenance breaks.',
    level: 'warn',
  },
  TRADE_DISABLED: {
    retryable: false,
    message: 'Trade is disabled for this symbol.',
    hint: 'The broker has trading disabled, or the symbol requires mapping to the tradeable variant.',
    level: 'error',
  },
  INVALID_VOLUME: {
    retryable: false,
    message: 'Invalid volume.',
    hint: 'Volumes below the symbol minimum or above the maximum are rejected; enable Force Minimum/Maximum Lot Size.',
    level: 'error',
  },
  INVALID_PRICE: {
    retryable: false,
    message: 'Invalid price.',
    hint: 'Common with pending orders across brokers with different quotes — unselect Copy Pending Orders.',
    level: 'error',
  },
  INVALID_SLTP: {
    retryable: false,
    message: 'Invalid S/L or T/P.',
    hint: 'The requested S/L or T/P is the wrong side of the market; increase the distance or stop copying S/L and T/P.',
    level: 'error',
  },
  OFF_QUOTES: {
    retryable: true,
    message: 'Off quotes.',
    hint: 'Broker could not quote a price (low liquidity or market closed); the copier retries.',
    level: 'warn',
  },
  REQUOTE: {
    retryable: true,
    message: 'Requote.',
    hint: 'Price moved too fast to fill; the copier retries.',
    level: 'warn',
  },
  NO_MONEY: {
    retryable: true,
    message: 'Not enough money.',
    hint: 'Free margin is insufficient; reduce volume or deposit.',
    level: 'error',
  },
  PRICE_CHANGED: {
    retryable: true,
    message: 'Price changed before execution.',
    hint: 'Increase the slippage tolerance for this slave.',
    level: 'warn',
  },
  TICKET_NOT_FOUND: {
    retryable: false,
    message: 'Ticket not found on the slave account.',
    hint: 'The slave position was already closed (for example its own S/L was hit).',
    level: 'warn',
  },
  ORDER_NOT_FOUND: {
    retryable: false,
    message: 'Order not found on the slave account.',
    hint: 'The order no longer exists; check the copier logs for the earlier failure that caused it.',
    level: 'warn',
  },
  LIMIT_ORDERS_DISABLED: {
    retryable: true,
    message: 'Limit orders are disabled for this symbol.',
    hint: 'Enable Copy Pending Orders off so the order is executed as a market order on fill.',
    level: 'warn',
  },
  TOO_MANY_REQUESTS: {
    retryable: true,
    message: 'Broker rate limited the request.',
    hint: 'The copier backs off and retries.',
    level: 'warn',
  },
  BROKER_ERROR: {
    retryable: true,
    message: 'Broker returned an unspecified error.',
    hint: 'Inspect the raw broker response in the log context.',
    level: 'error',
  },
  UNKNOWN_SYMBOL: {
    retryable: false,
    message: 'Symbol does not exist on the slave account.',
    hint: 'Refresh symbols for the account and re-map.',
    level: 'error',
  },
  STALE_QUOTE: {
    retryable: true,
    message: 'No fresh quote available for the symbol.',
    hint: 'The bridge agent could not provide a recent quote; the copier retries.',
    level: 'warn',
  },
  SPREAD_TOO_WIDE: {
    retryable: true,
    message: 'Spread is wider than the configured maximum.',
    hint: 'Raise the maximum spread or wait for liquid conditions.',
    level: 'warn',
  },
  SLIPPAGE_EXCEEDED: {
    retryable: true,
    message: 'Slippage tolerance exceeded.',
    hint: 'Increase slippage tolerance for this slave account.',
    level: 'warn',
  },
  ORDER_EXPIRED: {
    retryable: false,
    message: 'Order expired before it could be copied.',
    hint: 'Pending orders with a past expiry are not copied.',
    level: 'info',
  },
  CONTRACT_MISMATCH: {
    retryable: false,
    message: 'Contract sizes differ between master and slave.',
    hint: 'Enable Contract Alignment so contract size differences are honoured.',
    level: 'warn',
  },
  VOLUME_CHANGED: {
    retryable: true,
    message: 'Master volume changed while the copy was in flight.',
    hint: 'The copier reconciles the copied volume on the next pass.',
    level: 'info',
  },
  DUPLICATE_REQUEST: {
    retryable: false,
    message: 'Duplicate copy request suppressed.',
    hint: 'Idempotency guard: the same master trade was already copied to this slave.',
    level: 'debug',
  },
  PENDING_DEFERRED: {
    retryable: false,
    message: 'Pending order will be copied when it fills.',
    hint: 'Enable Copy Pending Orders to replicate the pending order itself instead of waiting for the fill.',
    level: 'info',
  },
  STRICT_CLOSE_IGNORED: {
    retryable: false,
    message: 'Master close ignored because Strict Close is enabled.',
    hint: 'The slave exits only through its own stop loss / take profit. Disable Strict Close to mirror closes.',
    level: 'info',
  },
  NOT_COPIED: {
    retryable: false,
    message: 'No slave copy exists for this master trade.',
    hint: 'The trade was never copied to this slave (filtered, skipped or created before the copier).',
    level: 'debug',
  },
  RECONNECT_MISMATCH: {
    retryable: false,
    message: 'Slave state did not match the expected state after reconnect.',
    hint: 'Review the reconciliation report; enable Repair On Reconnect to auto-fix.',
    level: 'warn',
  },
  TIMEOUT: {
    retryable: true,
    message: 'The bridge agent did not respond in time.',
    hint: 'The command is retried; check agent latency and connectivity.',
    level: 'warn',
  },
  NOT_IMPLEMENTED: {
    retryable: false,
    message: 'This action is not supported by the platform adapter yet.',
    hint: 'See docs/BRIDGE.md for the adapter capability matrix.',
    level: 'error',
  },
  VALIDATION: {
    retryable: false,
    message: 'Request failed validation.',
    hint: 'Check the request payload for the offending field.',
    level: 'error',
  },
  RATE_LIMITED: {
    retryable: true,
    message: 'Rate limited by the copier API.',
    hint: 'Reduce request rate.',
    level: 'warn',
  },
  INTERNAL: {
    retryable: true,
    message: 'Unexpected internal error.',
    hint: 'Check the API logs for the stack trace.',
    level: 'error',
  },
  BRIDGE_TIMEOUT: {
    retryable: true,
    message: 'The bridge agent did not answer in time.',
    hint: 'Check that the agent is running and that its terminal is still connected to the broker.',
    level: 'warn',
  },
  AGENT_VERSION_MISMATCH: {
    retryable: false,
    message: 'The bridge agent uses an incompatible protocol version.',
    hint: 'Update the agent to the same version as the server.',
    level: 'error',
  },
  LINK_CLOSED: {
    retryable: false,
    message: 'The copy was cancelled because its slave position no longer exists.',
    hint: 'Queued commands are dropped when the position they refer to is gone.',
    level: 'info',
  },
  BROKER_REJECTED: {
    retryable: false,
    message: 'The broker rejected the order.',
    hint: 'The broker\u2019s own message is kept in the log; common causes are market closed, invalid volume or a disabled symbol.',
    level: 'error',
  },
  VOLUME_TOO_SMALL: {
    retryable: false,
    message: 'The calculated volume is below the minimum lot size.',
    hint: 'Raise the risk value or enable Force Minimum Lot Size for this slave.',
    level: 'warn',
  },
  VOLUME_TOO_LARGE: {
    retryable: false,
    message: 'The calculated volume is above the maximum lot size.',
    hint: 'Lower the risk value or enable Force Maximum Lot Size for this slave.',
    level: 'warn',
  },
  QUOTE_UNAVAILABLE: {
    retryable: true,
    message: 'No live quote is available for the symbol.',
    hint: 'The symbol may be closed, hidden in Market Watch, or the agent is not streaming quotes.',
    level: 'info',
  },
};

export function isRetryable(code: CopierErrorCode): boolean {
  return ERROR_CATALOG[code].retryable;
}

export function errorMeta(code: CopierErrorCode): CopierErrorMeta {
  return ERROR_CATALOG[code];
}

/**
 * Map a raw broker/agent error string onto the taxonomy. Brokers are wildly
 * inconsistent ("Off quotes", "OFF_QUOTES", "ERR_OFF_QUOTES", retcode 10004…),
 * so matching is normalised and then falls back to BROKER_ERROR.
 */
const BROKER_ERROR_PATTERNS: ReadonlyArray<readonly [CopierErrorCode, RegExp]> = [
  ['MARKET_CLOSED', /market\s*closed|market_closed|no\s*prices|10018/i],
  ['TRADE_DISABLED', /trade\s*disabled|trading\s*disabled|10017/i],
  ['INVALID_VOLUME', /invalid\s*volume|invalid_volume|10014|volume\s*invalid/i],
  ['INVALID_PRICE', /invalid\s*price|invalid_price|10015/i],
  ['INVALID_SLTP', /invalid\s*(s\/?l|t\/?p)|invalid\s*stops|invalid_stops|10016/i],
  ['OFF_QUOTES', /off\s*quotes|off_quotes|10021/i],
  ['REQUOTE', /requote|10004/i],
  ['NO_MONEY', /no\s*money|no_money|not\s*enough\s*money|10019/i],
  ['PRICE_CHANGED', /price\s*changed|price_changed|10020/i],
  ['TICKET_NOT_FOUND', /ticket\s*not\s*found|position\s*not\s*found|10013/i],
  ['ORDER_NOT_FOUND', /order\s*not\s*found|unknown\s*order/i],
  ['TOO_MANY_REQUESTS', /too\s*many\s*requests|10024|rate\s*limit(ed)?|10033/i],
  ['LIMIT_ORDERS_DISABLED', /limit\s*orders?\s*disabled|10032/i],
  ['UNKNOWN_SYMBOL', /unknown\s*symbol|symbol\s*not\s*found|invalid\s*symbol/i],
];

export function classifyBrokerError(raw: string | null | undefined): CopierErrorCode {
  if (!raw) return 'BROKER_ERROR';
  for (const [code, pattern] of BROKER_ERROR_PATTERNS) {
    if (pattern.test(raw)) return code;
  }
  return 'BROKER_ERROR';
}

/** Wire shape for a failure. */
export const copierErrorSchema = z.object({
  code: copierErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean(),
  /** Raw broker/agent payload, preserved for diagnosis (never parsed for logic). */
  raw: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});
export type CopierError = z.infer<typeof copierErrorSchema>;

export function toCopierError(code: CopierErrorCode, raw?: string, context?: Record<string, unknown>): CopierError {
  const meta = ERROR_CATALOG[code];
  return {
    code,
    message: meta.message,
    hint: meta.hint,
    retryable: meta.retryable,
    ...(raw === undefined ? {} : { raw }),
    ...(context === undefined ? {} : { context }),
  };
}

/**
 * Non-error log codes.
 *
 * The execution log is the product's audit trail, so successful actions carry a
 * code too — a user filtering by `COPIED` sees every mirroring decision the
 * engine made, exactly like the "copied" rows in the reference dashboard.
 */
export const copierLogCodeSchema = z.enum([
  'COPIED',
  'COPIED_MODIFY',
  'COPIED_CLOSE',
  'COPIED_CLOSE_PARTIAL',
  'COPIED_CANCEL',
  'DEFERRED',
  'COMMAND_ACKED',
  'COMMAND_FAILED',
]);
export type CopierLogCode = z.infer<typeof copierLogCodeSchema>;

const SUCCESS_CODES: ReadonlySet<string> = new Set(copierLogCodeSchema.options);

/** True when the code represents a completed action rather than a failure. */
export function isSuccessLogCode(code: string): boolean {
  return SUCCESS_CODES.has(code);
}

/** Any code that may appear in an execution log row. */
export type CopierLogCodeValue = CopierErrorCode | CopierLogCode | (string & {});
