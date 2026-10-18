import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Database enums. These mirror the Zod enums in @trade-copier/contracts; the
 * API validates with Zod and the database enforces the same vocabulary, so an
 * unknown value can never be persisted by accident.
 */
export const platformEnum = pgEnum('platform', [
  'mt4',
  'mt5',
  'ctrader',
  'matchtrader',
  'tradelocker',
  'dxtrade',
  'mock',
]);

export const accountKindEnum = pgEnum('account_kind', ['demo', 'live']);

export const accountStatusEnum = pgEnum('account_status', [
  'connecting',
  'connected',
  'disconnected',
  'degraded',
  'error',
  'disabled',
]);

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const copierStatusEnum = pgEnum('copier_status', [
  'enabled',
  'disabled_monitor_existing',
  'disabled',
  'paused',
]);

export const riskTypeEnum = pgEnum('risk_type', [
  'LOT_MULTIPLIER',
  'FIXED_LOT',
  'BALANCE_MULTIPLIER',
  'FIXED_BALANCE_MULTIPLIER',
  'FIXED_PERCENT_RISK',
]);

export const masterTradeStateEnum = pgEnum('master_trade_state', ['open', 'partial', 'closed', 'cancelled']);

export const orderKindEnum = pgEnum('order_kind', ['market', 'pending']);

export const tradeSideEnum = pgEnum('trade_side', ['buy', 'sell']);

export const linkStatusEnum = pgEnum('link_status', [
  'pending',
  'open',
  'partial',
  'closed',
  'failed',
  'skipped',
  'cancelled',
]);

export const commandStatusEnum = pgEnum('command_status', [
  'queued',
  'dispatched',
  'acked',
  'failed',
  'dead',
  'cancelled',
]);

export const commandKindEnum = pgEnum('command_kind', [
  'open',
  'close',
  'close_partial',
  'modify',
  'place_pending',
  'cancel_pending',
  'close_all',
]);

export const logLevelEnum = pgEnum('log_level', ['debug', 'info', 'warn', 'error']);

export const notificationChannelKindEnum = pgEnum('notification_channel_kind', [
  'email',
  'telegram',
  'webhook',
  'slack',
  'discord',
]);

export const notificationStatusEnum = pgEnum('notification_status', ['queued', 'sent', 'failed', 'dead']);

export const shareRoleEnum = pgEnum('share_role', ['viewer', 'manager', 'copier']);

export const shareStatusEnum = pgEnum('share_status', ['active', 'revoked']);

export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'trialing', 'past_due', 'cancelled']);

export const billingIntervalEnum = pgEnum('billing_interval', ['month', 'quarter', 'semiannual', 'year']);

export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'done', 'failed']);

export const agentStatusEnum = pgEnum('agent_status', ['connected', 'disconnected', 'revoked']);

export const agentAccountRoleEnum = pgEnum('agent_account_role', ['master', 'slave', 'both']);

export const equityProtectionRuleEnum = pgEnum('equity_protection_rule', [
  'max_drawdown_percent',
  'max_drawdown_value',
  'absolute_min_equity',
  'max_profit_percent',
  'max_profit_value',
  'absolute_max_equity',
]);

export const auditActionEnum = pgEnum('audit_action', [
  'login',
  'logout',
  'register',
  'password_changed',
  'account_created',
  'account_deleted',
  'account_enabled',
  'account_disabled',
  'copier_created',
  'copier_updated',
  'copier_deleted',
  'follower_updated',
  'symbol_mapping_updated',
  'emergency_close',
  'api_key_created',
  'api_key_revoked',
  'share_created',
  'share_revoked',
  'equity_protection_updated',
]);

/**
 * TypeScript mirrors of the enums above. Drizzle infers these from `pgEnum`,
 * but the explicit unions keep repository signatures readable.
 */
export type PlatformName = (typeof platformEnum.enumValues)[number];
export type AccountKindName = (typeof accountKindEnum.enumValues)[number];
export type AccountStatusName = (typeof accountStatusEnum.enumValues)[number];
export type CopierStatusName = (typeof copierStatusEnum.enumValues)[number];
export type RiskTypeName = (typeof riskTypeEnum.enumValues)[number];
export type MasterTradeState = (typeof masterTradeStateEnum.enumValues)[number];
export type LinkState = (typeof linkStatusEnum.enumValues)[number];
export type CommandStatus = (typeof commandStatusEnum.enumValues)[number];
export type CommandKindName = (typeof commandKindEnum.enumValues)[number];
export type LogLevelName = (typeof logLevelEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type AgentStatus = (typeof agentStatusEnum.enumValues)[number];
export type EquityProtectionRule = (typeof equityProtectionRuleEnum.enumValues)[number];
export type NotificationChannelKindName = (typeof notificationChannelKindEnum.enumValues)[number];
export type TradeSideName = (typeof tradeSideEnum.enumValues)[number];
export type OrderKindName = (typeof orderKindEnum.enumValues)[number];
