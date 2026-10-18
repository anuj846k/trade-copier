import { z } from 'zod';

/**
 * Platforms this copier can talk to. `mock` is a first-class member: the whole
 * stack must be runnable end-to-end without broker credentials (see docs/BRIDGE.md).
 */
export const platformSchema = z.enum([
  'mt4',
  'mt5',
  'ctrader',
  'matchtrader',
  'tradelocker',
  'dxtrade',
  'mock',
]);
export type Platform = z.infer<typeof platformSchema>;

export const CFD_PLATFORMS: readonly Platform[] = [
  'mt4',
  'mt5',
  'ctrader',
  'matchtrader',
  'tradelocker',
  'dxtrade',
] as const;

export const PLATFORM_LABELS: Record<Platform, string> = {
  mt4: 'MetaTrader 4',
  mt5: 'MetaTrader 5',
  ctrader: 'cTrader',
  matchtrader: 'Match-Trader',
  tradelocker: 'TradeLocker',
  dxtrade: 'DXtrade',
  mock: 'Simulated (mock bridge)',
};

/** How the connector reaches the platform. */
export const connectionModeSchema = z.enum(['bridge_agent', 'cloud_api']);
export type ConnectionMode = z.infer<typeof connectionModeSchema>;

export const accountKindSchema = z.enum(['demo', 'live']);
export type AccountKind = z.infer<typeof accountKindSchema>;

export const accountStatusSchema = z.enum([
  'connecting',
  'connected',
  'disconnected',
  'degraded',
  'error',
  'disabled',
]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const accountRoleSchema = z.enum(['master', 'slave', 'both']);
export type AccountRole = z.infer<typeof accountRoleSchema>;

export const tradeSideSchema = z.enum(['buy', 'sell']);
export type TradeSide = z.infer<typeof tradeSideSchema>;

/** Position or pending order. */
export const orderKindSchema = z.enum(['market', 'pending']);
export type OrderKind = z.infer<typeof orderKindSchema>;

export const pendingOrderTypeSchema = z.enum([
  'buy_limit',
  'sell_limit',
  'buy_stop',
  'sell_stop',
  'buy_stop_limit',
  'sell_stop_limit',
]);
export type PendingOrderType = z.infer<typeof pendingOrderTypeSchema>;

/** Mirrors the broker's own trade mode for a symbol (MT5 `SYMBOL_TRADE_MODE_*`). */
export const symbolTradeModeSchema = z.enum([
  'full',
  'long_only',
  'short_only',
  'close_only',
  'disabled',
]);
export type SymbolTradeMode = z.infer<typeof symbolTradeModeSchema>;

export const assetClassSchema = z.enum(['forex', 'metal', 'index', 'energy', 'crypto', 'stock', 'unknown']);
export type AssetClass = z.infer<typeof assetClassSchema>;

export const copierStatusSchema = z.enum([
  'enabled',
  /** Ignore new master opens; keep managing (closing/modifying) existing copies. */
  'disabled_monitor_existing',
  'disabled',
  'paused',
]);
export type CopierStatus = z.infer<typeof copierStatusSchema>;

export const copierLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type CopierLogLevel = z.infer<typeof copierLogLevelSchema>;

export const userRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const notificationChannelKindSchema = z.enum(['email', 'telegram', 'webhook', 'slack', 'discord']);
export type NotificationChannelKind = z.infer<typeof notificationChannelKindSchema>;

export const notificationEventSchema = z.enum([
  'account_added',
  'account_deleted',
  'account_enabled',
  'account_disabled',
  'account_connected',
  'account_disconnected',
  'trade_copy_failed',
  'trade_copied',
  'copier_created',
  'copier_modified',
  'copier_deleted',
  'copier_enabled',
  'copier_disabled',
  'equity_protection_triggered',
  'subscription_renewal_due',
  'subscription_renewed',
  'subscription_failed',
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const accountShareRoleSchema = z.enum(['viewer', 'manager', 'copier']);
export type AccountShareRole = z.infer<typeof accountShareRoleSchema>;
