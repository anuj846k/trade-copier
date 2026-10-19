import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  CommandParams,
  CopierStatus,
  FollowerSettings,
  RiskType,
  TradingWindow,
} from '@trade-copier/contracts';
import * as enums from './enums.js';

/** Monetary / price / volume columns are numeric to avoid float drift. */
const money = (name: string) => numeric(name, { precision: 24, scale: 8 });
const price = (name: string) => numeric(name, { precision: 24, scale: 10 });
const volume = (name: string) => numeric(name, { precision: 18, scale: 4 });
const percent = (name: string) => numeric(name, { precision: 12, scale: 6 });

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    role: enums.userRoleEnum('role').notNull().default('user'),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_email_key').on(sql`lower(${table.email})`)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token; the raw value is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Rotation family: a reused token revokes the whole family. */
    familyId: text('family_id').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenHash: text('replaced_by_token_hash'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_key').on(table.tokenHash),
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('api_keys_hash_key').on(table.keyHash), index('api_keys_user_idx').on(table.userId)],
);

// ---------------------------------------------------------------------------
// bridge agents + trading accounts
// ---------------------------------------------------------------------------

export const bridgeAgents = pgTable(
  'bridge_agents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 of the agent token; the raw value is shown once at creation. */
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    version: text('version'),
    host: text('host'),
    platform: text('platform'),
    status: enums.agentStatusEnum('status').notNull().default('disconnected'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastIp: text('last_ip'),
    queueDepth: integer('queue_depth').notNull().default(0),
    latencyMs: integer('latency_ms'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('bridge_agents_token_key').on(table.tokenHash),
    index('bridge_agents_user_idx').on(table.userId),
  ],
);

export const tradingAccounts = pgTable(
  'trading_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    platform: enums.platformEnum('platform').notNull(),
    login: text('login').notNull(),
    server: text('server').notNull(),
    brokerName: text('broker_name'),
    kind: enums.accountKindEnum('kind').notNull().default('live'),
    /** Role hint used by the UI; the copier links are the source of truth. */
    role: enums.agentAccountRoleEnum('role').notNull().default('both'),
    currency: text('currency').notNull().default('USD'),
    leverage: integer('leverage'),
    status: enums.accountStatusEnum('status').notNull().default('connecting'),
    enabled: boolean('enabled').notNull().default(true),
    agentId: text('agent_id').references(() => bridgeAgents.id, { onDelete: 'set null' }),
    balance: money('balance'),
    equity: money('equity'),
    margin: money('margin'),
    freeMargin: money('free_margin'),
    marginLevel: percent('margin_level'),
    equityUpdatedAt: timestamp('equity_updated_at', { withTimezone: true }),
    /** Balance captured at the last daily reset — the Equity Protection basis. */
    referenceBalance: money('reference_balance'),
    referenceBalanceAt: timestamp('reference_balance_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    /** Capability flags reported by the agent (pending orders, partial close …). */
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('trading_accounts_user_idx').on(table.userId),
    index('trading_accounts_agent_idx').on(table.agentId),
    uniqueIndex('trading_accounts_identity_key')
      .on(table.userId, table.platform, table.login, table.server)
      .where(sql`deleted_at is null`),
  ],
);

export const accountCredentials = pgTable(
  'account_credentials',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    /** AES-256-GCM envelope: iv + auth tag + ciphertext (base64, colon separated). */
    passwordEncrypted: text('password_encrypted'),
    investorPasswordEncrypted: text('investor_password_encrypted'),
    /** Read-only server-side credential (cTrader/DXtrade style APIs). */
    apiTokenEncrypted: text('api_token_encrypted'),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('account_credentials_account_key').on(table.accountId)],
);

export const accountSymbols = pgTable(
  'account_symbols',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    /** Broker symbol name verbatim (identity). */
    name: text('name').notNull(),
    canonical: text('canonical').notNull(),
    assetClass: text('asset_class').notNull().default('unknown'),
    digits: integer('digits').notNull().default(5),
    point: price('point').notNull(),
    pipSize: price('pip_size').notNull(),
    contractSize: price('contract_size').notNull(),
    minLot: volume('min_lot').notNull(),
    maxLot: volume('max_lot').notNull(),
    lotStep: volume('lot_step').notNull().default('0.01'),
    maxLotPerOrder: volume('max_lot_per_order'),
    quoteCurrency: text('quote_currency').notNull().default('USD'),
    tradeMode: text('trade_mode').notNull().default('full'),
    /** Account-level toggle (docs: "disable a symbol on your trading account"). */
    enabled: boolean('enabled').notNull().default(true),
    swapLong: money('swap_long'),
    swapShort: money('swap_short'),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('account_symbols_name_key').on(table.accountId, table.name),
    index('account_symbols_canonical_idx').on(table.accountId, table.canonical),
  ],
);

// ---------------------------------------------------------------------------
// copiers
// ---------------------------------------------------------------------------

export const copiers = pgTable(
  'copiers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    masterAccountId: text('master_account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    status: enums.copierStatusEnum('status').notNull().default('disabled'),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    /** Master balance used by balance-multiplier sizing (snapshot at creation). */
    masterBalanceAtCreation: money('master_balance_at_creation'),
    copyExistingTradesRequested: boolean('copy_existing_trades_requested').notNull().default(false),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('copiers_user_idx').on(table.userId),
    index('copiers_master_idx').on(table.masterAccountId),
    index('copiers_status_idx').on(table.status),
  ],
);

export const copierFollowers = pgTable(
  'copier_followers',
  {
    id: text('id').primaryKey(),
    copierId: text('copier_id')
      .notNull()
      .references(() => copiers.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    riskType: enums.riskTypeEnum('risk_type').notNull().default('LOT_MULTIPLIER'),
    riskValue: percent('risk_value').notNull().default('100'),
    /** Full settings document; typed columns above are denormalised for queries. */
    settings: jsonb('settings').$type<FollowerSettings>().notNull(),
    /** Chosen broker suffix for this account (mismatch-detected flow). */
    suffixPreference: text('suffix_preference'),
    /** Pause this slave only (docs: pause copier at master or slave level). */
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Documented: "you cannot add the same account to a config multiple times".
    uniqueIndex('copier_followers_unique').on(table.copierId, table.accountId),
    index('copier_followers_account_idx').on(table.accountId),
  ],
);

export const followerSymbolOverrides = pgTable(
  'follower_symbol_overrides',
  {
    id: text('id').primaryKey(),
    followerId: text('follower_id')
      .notNull()
      .references(() => copierFollowers.id, { onDelete: 'cascade' }),
    masterSymbol: text('master_symbol').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('follower_symbol_overrides_unique').on(table.followerId, table.masterSymbol)],
);

export const symbolMappings = pgTable(
  'symbol_mappings',
  {
    id: text('id').primaryKey(),
    followerId: text('follower_id')
      .notNull()
      .references(() => copierFollowers.id, { onDelete: 'cascade' }),
    masterSymbol: text('master_symbol').notNull(),
    slaveSymbol: text('slave_symbol').notNull(),
    source: text('source').notNull().default('manual'),
    confidence: percent('confidence').notNull().default('1'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('symbol_mappings_unique').on(table.followerId, table.masterSymbol),
    index('symbol_mappings_follower_idx').on(table.followerId),
  ],
);

// ---------------------------------------------------------------------------
// trades, links and the durable command queue
// ---------------------------------------------------------------------------

export const masterTrades = pgTable(
  'master_trades',
  {
    id: text('id').primaryKey(),
    copierId: text('copier_id')
      .notNull()
      .references(() => copiers.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    ticket: text('ticket').notNull(),
    symbol: text('symbol').notNull(),
    side: enums.tradeSideEnum('side').notNull(),
    kind: enums.orderKindEnum('kind').notNull().default('market'),
    pendingType: text('pending_type'),
    state: enums.masterTradeStateEnum('state').notNull().default('open'),
    volume: volume('volume').notNull(),
    closedVolume: volume('closed_volume').notNull().default('0'),
    openPrice: price('open_price').notNull(),
    currentPrice: price('current_price'),
    stopLoss: price('stop_loss'),
    takeProfit: price('take_profit'),
    expiry: timestamp('expiry', { withTimezone: true }),
    magic: integer('magic').notNull().default(0),
    comment: text('comment').notNull().default(''),
    profit: money('profit'),
    swap: money('swap'),
    commission: money('commission'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closePrice: price('close_price'),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('master_trades_ticket_key').on(table.copierId, table.ticket),
    index('master_trades_state_idx').on(table.copierId, table.state),
    index('master_trades_account_idx').on(table.accountId),
    index('master_trades_symbol_idx').on(table.symbol),
  ],
);

export const tradeLinks = pgTable(
  'trade_links',
  {
    id: text('id').primaryKey(),
    masterTradeId: text('master_trade_id')
      .notNull()
      .references(() => masterTrades.id, { onDelete: 'cascade' }),
    followerId: text('follower_id')
      .notNull()
      .references(() => copierFollowers.id, { onDelete: 'cascade' }),
    copierId: text('copier_id')
      .notNull()
      .references(() => copiers.id, { onDelete: 'cascade' }),
    slaveAccountId: text('slave_account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    masterSymbol: text('master_symbol').notNull(),
    slaveSymbol: text('slave_symbol'),
    side: enums.tradeSideEnum('side').notNull(),
    masterVolume: volume('master_volume').notNull(),
    requestedVolume: volume('requested_volume'),
    filledVolume: volume('filled_volume'),
    /** Volume already closed on the slave (mirrors master partial closes). */
    closedVolume: volume('closed_volume').notNull().default('0'),
    filledPrice: price('filled_price'),
    slaveTicket: text('slave_ticket'),
    magic: integer('magic'),
    state: enums.linkStatusEnum('state').notNull().default('pending'),
    /** Intent counter; also part of the deterministic request id. */
    seq: integer('seq').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    realizedProfit: money('realized_profit'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('trade_links_unique').on(table.masterTradeId, table.followerId),
    index('trade_links_follower_idx').on(table.followerId, table.state),
    index('trade_links_ticket_idx').on(table.slaveAccountId, table.slaveTicket),
    index('trade_links_copier_idx').on(table.copierId),
  ],
);

export const copyCommands = pgTable(
  'copy_commands',
  {
    id: text('id').primaryKey(),
    /** Deterministic idempotency key (see domain/ids.ts). */
    requestId: text('request_id').notNull(),
    copierId: text('copier_id').references(() => copiers.id, { onDelete: 'cascade' }),
    followerId: text('follower_id').references(() => copierFollowers.id, { onDelete: 'cascade' }),
    masterTradeId: text('master_trade_id').references(() => masterTrades.id, { onDelete: 'cascade' }),
    linkId: text('link_id').references(() => tradeLinks.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    kind: enums.commandKindEnum('kind').notNull(),
    params: jsonb('params').$type<CommandParams>().notNull(),
    seq: integer('seq').notNull().default(0),
    status: enums.commandStatusEnum('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(100),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(24),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    /** Deadline for retries (documented 15 minute window for MARKET_CLOSED). */
    retryDeadlineAt: timestamp('retry_deadline_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    /** Decision trace produced by the planner, kept for explainability. */
    trace: jsonb('trace').$type<Record<string, unknown>>().notNull().default({}),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('copy_commands_request_key').on(table.requestId),
    index('copy_commands_queue_idx').on(table.status, table.nextAttemptAt, table.priority),
    index('copy_commands_account_idx').on(table.accountId, table.status),
    index('copy_commands_follower_idx').on(table.followerId),
  ],
);

export const executionLogs = pgTable(
  'execution_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    copierId: text('copier_id').references(() => copiers.id, { onDelete: 'cascade' }),
    followerId: text('follower_id').references(() => copierFollowers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    masterTradeId: text('master_trade_id').references(() => masterTrades.id, { onDelete: 'cascade' }),
    requestId: text('request_id'),
    level: enums.logLevelEnum('level').notNull().default('info'),
    /** CopierErrorCode when the row describes a failure or a skip reason. */
    code: text('code').notNull(),
    message: text('message').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('execution_logs_created_idx').on(table.createdAt),
    index('execution_logs_copier_idx').on(table.copierId, table.createdAt),
    index('execution_logs_follower_idx').on(table.followerId, table.createdAt),
    index('execution_logs_code_idx').on(table.code),
  ],
);

// ---------------------------------------------------------------------------
// snapshots + analytics
// ---------------------------------------------------------------------------

export const accountSnapshots = pgTable(
  'account_snapshots',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    balance: money('balance').notNull(),
    equity: money('equity').notNull(),
    margin: money('margin'),
    freeMargin: money('free_margin'),
    openPositions: integer('open_positions').notNull().default(0),
    openVolume: volume('open_volume').notNull().default('0'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Downsampled to one row per minute so history stays affordable.
    uniqueIndex('account_snapshots_minute_key').on(table.accountId, table.takenAt),
    index('account_snapshots_account_idx').on(table.accountId, table.takenAt),
  ],
);

export const accountClosedTrades = pgTable(
  'account_closed_trades',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    ticket: text('ticket').notNull(),
    symbol: text('symbol').notNull(),
    side: enums.tradeSideEnum('side').notNull(),
    volume: volume('volume').notNull(),
    openPrice: price('open_price').notNull(),
    closePrice: price('close_price').notNull(),
    stopLoss: price('stop_loss'),
    takeProfit: price('take_profit'),
    magic: integer('magic').notNull().default(0),
    comment: text('comment').notNull().default(''),
    profit: money('profit').notNull(),
    swap: money('swap').notNull().default('0'),
    commission: money('commission').notNull().default('0'),
    /** Set when the trade was placed by the copier (used by Equity Protection). */
    followerId: text('follower_id').references(() => copierFollowers.id, { onDelete: 'set null' }),
    requestId: text('request_id'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('account_closed_trades_ticket_key').on(table.accountId, table.ticket),
    index('account_closed_trades_account_idx').on(table.accountId, table.closedAt),
    index('account_closed_trades_follower_idx').on(table.followerId),
  ],
);

// ---------------------------------------------------------------------------
// protection, notifications, billing, sharing, jobs
// ---------------------------------------------------------------------------

export const equityProtections = pgTable(
  'equity_protections',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    resetTime: text('reset_time').notNull().default('00:00'),
    resetTimezone: text('reset_timezone').notNull().default('UTC'),
    maxDrawdownPercent: percent('max_drawdown_percent'),
    maxDrawdownValue: money('max_drawdown_value'),
    absoluteMinEquity: money('absolute_min_equity'),
    maxProfitPercent: percent('max_profit_percent'),
    maxProfitValue: money('max_profit_value'),
    absoluteMaxEquity: money('absolute_max_equity'),
    disableCopier: boolean('disable_copier').notNull().default(false),
    closeCopiedTrades: boolean('close_copied_trades').notNull().default(false),
    closeAllTrades: boolean('close_all_trades').notNull().default(false),
    notify: boolean('notify').notNull().default(true),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    lastTriggeredRule: enums.equityProtectionRuleEnum('last_triggered_rule'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('equity_protections_account_key').on(table.accountId)],
);

export const equityProtectionEvents = pgTable(
  'equity_protection_events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    rule: enums.equityProtectionRuleEnum('rule').notNull(),
    threshold: money('threshold').notNull(),
    observed: money('observed').notNull(),
    actions: jsonb('actions').$type<string[]>().notNull().default([]),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index('equity_protection_events_account_idx').on(table.accountId, table.createdAt)],
);

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: enums.notificationChannelKindEnum('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Non-sensitive configuration (address, chat id, URL). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM encrypted secrets (bot tokens, webhook signing secrets). */
    secretsEncrypted: text('secrets_encrypted'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('notification_channels_kind_key').on(table.userId, table.kind)],
);

export const notificationSettings = pgTable(
  'notification_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    subject: text('subject'),
    template: text('template'),
    accountBlocklist: jsonb('account_blocklist').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('notification_settings_unique').on(table.userId, table.channelId, table.event)],
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: enums.notificationStatusEnum('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Dedupe key so one event cannot spam a channel twice. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('notification_outbox_queue_idx').on(table.status, table.nextAttemptAt),
    uniqueIndex('notification_outbox_dedupe_key').on(table.dedupeKey),
  ],
);

export const plans = pgTable(
  'plans',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    priceCents: integer('price_cents').notNull(),
    interval: enums.billingIntervalEnum('interval').notNull().default('month'),
    maxAccounts: integer('max_accounts'),
    features: jsonb('features').$type<string[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [index('plans_active_idx').on(table.active)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code),
    status: enums.subscriptionStatusEnum('status').notNull().default('active'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** Free-form billing provider reference (Stripe id, invoice id …). */
    providerRef: text('provider_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('subscriptions_user_idx').on(table.userId), index('subscriptions_status_idx').on(table.status)],
);

export const accountShares = pgTable(
  'account_shares',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: enums.shareRoleEnum('role').notNull().default('viewer'),
    status: enums.shareStatusEnum('status').notNull().default('active'),
    permissions: jsonb('permissions')
      .$type<{ balance: boolean; equity: boolean; history: boolean; canCopy: boolean }>()
      .notNull()
      .default({ balance: true, equity: true, history: true, canCopy: false }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('account_shares_unique').on(table.accountId, table.granteeUserId).where(sql`status = 'active'`),
    index('account_shares_grantee_idx').on(table.granteeUserId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').$type<enums.AuditAction>().notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (table) => [index('audit_logs_user_idx').on(table.userId, table.createdAt), index('audit_logs_action_idx').on(table.action)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Dedupe key for singleton jobs (e.g. one snapshot collector per account). */
    dedupeKey: text('dedupe_key'),
    status: enums.jobStatusEnum('status').notNull().default('queued'),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('jobs_queue_idx').on(table.status, table.runAt),
    uniqueIndex('jobs_dedupe_key').on(table.dedupeKey),
  ],
);

/** Bookkeeping for the daily reset of Equity Protection reference balances. */
export const accountDailyResets = pgTable(
  'account_daily_resets',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'cascade' }),
    resetDay: date('reset_day').notNull(),
    referenceBalance: money('reference_balance').notNull(),
    referenceEquity: money('reference_equity').notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('account_daily_resets_unique').on(table.accountId, table.resetDay)],
);

// ---------------------------------------------------------------------------
// relations (used by drizzle's relational queries)
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(tradingAccounts),
  copiers: many(copiers),
  apiKeys: many(apiKeys),
  channels: many(notificationChannels),
}));

export const tradingAccountsRelations = relations(tradingAccounts, ({ one, many }) => ({
  user: one(users, { fields: [tradingAccounts.userId], references: [users.id] }),
  agent: one(bridgeAgents, { fields: [tradingAccounts.agentId], references: [bridgeAgents.id] }),
  symbols: many(accountSymbols),
  credentials: one(accountCredentials, {
    fields: [tradingAccounts.id],
    references: [accountCredentials.accountId],
  }),
  protection: one(equityProtections, {
    fields: [tradingAccounts.id],
    references: [equityProtections.accountId],
  }),
}));

export const copiersRelations = relations(copiers, ({ one, many }) => ({
  user: one(users, { fields: [copiers.userId], references: [users.id] }),
  masterAccount: one(tradingAccounts, {
    fields: [copiers.masterAccountId],
    references: [tradingAccounts.id],
  }),
  followers: many(copierFollowers),
  masterTrades: many(masterTrades),
}));

export const copierFollowersRelations = relations(copierFollowers, ({ one, many }) => ({
  copier: one(copiers, { fields: [copierFollowers.copierId], references: [copiers.id] }),
  account: one(tradingAccounts, { fields: [copierFollowers.accountId], references: [tradingAccounts.id] }),
  mappings: many(symbolMappings),
  overrides: many(followerSymbolOverrides),
}));

export const masterTradesRelations = relations(masterTrades, ({ one, many }) => ({
  copier: one(copiers, { fields: [masterTrades.copierId], references: [copiers.id] }),
  links: many(tradeLinks),
}));

export const tradeLinksRelations = relations(tradeLinks, ({ one }) => ({
  masterTrade: one(masterTrades, { fields: [tradeLinks.masterTradeId], references: [masterTrades.id] }),
  follower: one(copierFollowers, { fields: [tradeLinks.followerId], references: [copierFollowers.id] }),
}));

export const notificationChannelsRelations = relations(notificationChannels, ({ one, many }) => ({
  user: one(users, { fields: [notificationChannels.userId], references: [users.id] }),
  settings: many(notificationSettings),
}));

export type { CopierStatus, RiskType, TradingWindow };
