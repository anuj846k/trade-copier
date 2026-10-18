import { z } from 'zod';

/**
 * HTTP API contracts. Request/response shapes are the single source of truth for
 * the Fastify routes, the Next.js BFF and the browser client.
 */

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(12, 'Use at least 12 characters')
    .max(200)
    .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
      message: 'Include upper case, lower case and a digit',
    }),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  timezone: z.string().min(1).default('UTC'),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  refreshExpiresAt: z.string().datetime(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  timezone: z.string(),
  role: z.enum(['user', 'admin']),
  totpEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type UserDto = z.infer<typeof userSchema>;

export const authSessionSchema = z.object({
  user: userSchema,
  tokens: authTokensSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(10) });
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: registerRequestSchema.shape.password,
});
export const updateProfileRequestSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).optional(),
});
export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export const totpVerifyRequestSchema = z.object({
  secret: z.string(),
  token: z.string().regex(/^\d{6}$/),
});

// ---------------------------------------------------------------------------
// trading accounts
// ---------------------------------------------------------------------------

export const createAccountRequestSchema = z.object({
  label: z.string().min(1).max(80),
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock']),
  login: z.string().min(1).max(64),
  server: z.string().min(1).max(120),
  /** Master accounts may use the read-only investor password. */
  password: z.string().min(1).max(200).optional(),
  /** Optional investor (read-only) password, stored encrypted. */
  investorPassword: z.string().min(1).max(200).optional(),
  kind: z.enum(['demo', 'live']).default('live'),
  brokerName: z.string().max(120).optional(),
  /** Connect this account through an already-registered bridge agent. */
  agentToken: z.string().min(10).optional(),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

export const accountDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock']),
  login: z.string(),
  server: z.string(),
  brokerName: z.string().nullable(),
  kind: z.enum(['demo', 'live']),
  currency: z.string(),
  leverage: z.number().int().nullable(),
  status: z.enum(['connecting', 'connected', 'disconnected', 'degraded', 'error', 'disabled']),
  enabled: z.boolean(),
  balance: z.number().nullable(),
  equity: z.number().nullable(),
  freeMargin: z.number().nullable(),
  marginLevel: z.number().nullable(),
  equityUpdatedAt: z.string().datetime().nullable(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  isMaster: z.boolean(),
  isSlave: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AccountDto = z.infer<typeof accountDtoSchema>;

export const accountSymbolsQuerySchema = z.object({
  search: z.string().optional(),
  assetClass: z.enum(['forex', 'metal', 'index', 'energy', 'crypto', 'stock', 'unknown']).optional(),
  assetClasses: z.string().optional(),
  mapped: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateAccountSymbolSchema = z.object({
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// copiers
// ---------------------------------------------------------------------------

export const createCopierRequestSchema = z.object({
  name: z.string().min(1).max(80),
  masterAccountId: z.string().min(1),
  /** Immediate mirror of the master's currently open positions (one-shot). */
  copyExistingTrades: z.boolean().default(false),
  followers: z
    .array(
      z.object({
        accountId: z.string().min(1),
        settings: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
});
export type CreateCopierRequest = z.infer<typeof createCopierRequestSchema>;

export const updateCopierRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  status: z.enum(['enabled', 'disabled_monitor_existing', 'disabled', 'paused']).optional(),
  pausedUntil: z.string().datetime().nullable().optional(),
});
export type UpdateCopierRequest = z.infer<typeof updateCopierRequestSchema>;

export const upsertFollowerRequestSchema = z.object({
  accountId: z.string().min(1),
  settings: z.record(z.unknown()).default({}),
});

export const updateFollowerRequestSchema = z.object({
  settings: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const upsertSymbolOverrideRequestSchema = z.object({
  masterSymbol: z.string().min(1),
  settings: z.record(z.unknown()),
});

export const upsertSymbolMappingRequestSchema = z.object({
  masterSymbol: z.string().min(1),
  slaveSymbol: z.string().min(1),
});

export const autoMapRequestSchema = z.object({
  /** Restrict auto-mapping to a subset of master symbols. */
  masterSymbols: z.array(z.string()).optional(),
  /** Overwrite existing manual mappings. */
  overwrite: z.boolean().default(false),
});

export const bulkSymbolMappingRequestSchema = z.object({
  suffix: z.string().max(16).default(''),
  /** Reset all mappings for this slave. */
  deleteAll: z.boolean().default(false),
});

export const followerDtoSchema = z.object({
  id: z.string(),
  copierId: z.string(),
  accountId: z.string(),
  accountLabel: z.string(),
  enabled: z.boolean(),
  settings: z.record(z.unknown()),
  effectiveStatus: z.enum([
    'active',
    'paused',
    'disabled',
    'blocked_copier',
    'blocked_account',
    'blocked_equity_protection',
  ]),
  blockedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FollowerDto = z.infer<typeof followerDtoSchema>;

export const copierDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['enabled', 'disabled_monitor_existing', 'disabled', 'paused']),
  pausedUntil: z.string().datetime().nullable(),
  masterAccountId: z.string(),
  masterAccountLabel: z.string(),
  followers: z.array(followerDtoSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CopierDto = z.infer<typeof copierDtoSchema>;

// ---------------------------------------------------------------------------
// logs, trades, analytics
// ---------------------------------------------------------------------------

export const logQuerySchema = z.object({
  copierId: z.string().optional(),
  followerId: z.string().optional(),
  accountId: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  code: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

export const logEntryDtoSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  code: z.string(),
  message: z.string(),
  copierId: z.string().nullable(),
  followerId: z.string().nullable(),
  accountId: z.string().nullable(),
  masterTradeId: z.string().nullable(),
  context: z.record(z.unknown()).nullable(),
});
export type LogEntryDto = z.infer<typeof logEntryDtoSchema>;

export const tradeLinkDtoSchema = z.object({
  id: z.string(),
  masterTradeId: z.string(),
  followerId: z.string(),
  slaveAccountId: z.string(),
  masterSymbol: z.string(),
  slaveSymbol: z.string().nullable(),
  side: z.enum(['buy', 'sell']),
  masterVolume: z.number(),
  requestedVolume: z.number().nullable(),
  filledVolume: z.number().nullable(),
  filledPrice: z.number().nullable(),
  slaveTicket: z.string().nullable(),
  status: z.enum(['pending', 'open', 'closed', 'failed', 'skipped', 'partial']),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  realizedProfit: z.number().nullable(),
  openedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type TradeLinkDto = z.infer<typeof tradeLinkDtoSchema>;

export const analyticsQuerySchema = z.object({
  accountId: z.string().min(1),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Bucket size for the equity series. */
  granularity: z.enum(['hour', 'day']).default('day'),
});

export const accountAnalyticsSchema = z.object({
  accountId: z.string(),
  currency: z.string(),
  balance: z.number(),
  equity: z.number(),
  growth: z.number(),
  growthPercent: z.number(),
  openPositions: z.number().int(),
  openVolume: z.number(),
  tradesTaken: z.number().int(),
  lotsTraded: z.number(),
  winRate: z.number(),
  lossRate: z.number(),
  longsWonRate: z.number(),
  shortsWonRate: z.number(),
  bestTrade: z.object({ profit: z.number(), percent: z.number() }),
  worstTrade: z.object({ profit: z.number(), percent: z.number() }),
  averageWinPercent: z.number(),
  averageLossPercent: z.number(),
  profitFactor: z.number().nullable(),
  expectancy: z.number(),
  maxDrawdown: z.object({ absolute: z.number(), percent: z.number() }),
  netProfit: z.number(),
  equitySeries: z.array(z.object({ at: z.string().datetime(), balance: z.number(), equity: z.number() })),
  /** Weekday (1-7) x hour (0-23) buckets. */
  heatmap: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        hour: z.number().int().min(0).max(23),
        trades: z.number().int(),
        profit: z.number(),
      }),
    )
    .default([]),
});
export type AccountAnalytics = z.infer<typeof accountAnalyticsSchema>;

// ---------------------------------------------------------------------------
// equity protection
// ---------------------------------------------------------------------------

export const equityProtectionSchema = z.object({
  enabled: z.boolean().default(false),
  /** Local time of the daily balance/equity reset used as the reference. */
  resetTime: timeOfDaySchemaOrDefault('00:00'),
  resetTimezone: z.string().min(1).default('UTC'),
  // --- stop-loss style protection ---
  maxDrawdownPercent: z.number().positive().nullable().default(null),
  maxDrawdownValue: z.number().positive().nullable().default(null),
  absoluteMinEquity: z.number().positive().nullable().default(null),
  // --- take-profit style protection ---
  maxProfitPercent: z.number().positive().nullable().default(null),
  maxProfitValue: z.number().positive().nullable().default(null),
  absoluteMaxEquity: z.number().positive().nullable().default(null),
  // --- actions (mutually exclusive groups, matching the reference UI) ---
  disableCopier: z.boolean().default(false),
  closeCopiedTrades: z.boolean().default(false),
  closeAllTrades: z.boolean().default(false),
  notify: z.boolean().default(true),
});
export type EquityProtection = z.infer<typeof equityProtectionSchema>;

function timeOfDaySchemaOrDefault(fallback: string) {
  return z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .default(fallback);
}

export const equityProtectionEventDtoSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  reason: z.string(),
  triggeredValue: z.number(),
  threshold: z.number(),
  actions: z.array(z.string()),
  snapshot: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export const upsertNotificationChannelRequestSchema = z.object({
  kind: z.enum(['email', 'telegram', 'webhook', 'slack', 'discord']),
  enabled: z.boolean().default(true),
  config: z
    .object({
      address: z.string().email().optional(),
      chatId: z.string().optional(),
      botToken: z.string().optional(),
      url: z.string().url().optional(),
      secret: z.string().optional(),
    })
    .default({}),
});

export const notificationChannelDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(['email', 'telegram', 'webhook', 'slack', 'discord']),
  enabled: z.boolean(),
  /** Secrets are never returned; only non-sensitive configuration. */
  config: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

export const upsertNotificationSettingRequestSchema = z.object({
  channelId: z.string(),
  event: z.string(),
  enabled: z.boolean().default(true),
  subject: z.string().max(200).optional(),
  template: z.string().max(4000).optional(),
  accountBlocklist: z.array(z.string()).default([]),
});

export const notificationSettingDtoSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  event: z.string(),
  enabled: z.boolean(),
  subject: z.string().nullable(),
  template: z.string().nullable(),
  accountBlocklist: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// billing / entitlement
// ---------------------------------------------------------------------------

export const planDtoSchema = z.object({
  code: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  interval: z.enum(['month', 'quarter', 'semiannual', 'year']),
  maxAccounts: z.number().int().nullable(),
  features: z.array(z.string()),
});
export type PlanDto = z.infer<typeof planDtoSchema>;

export const subscriptionDtoSchema = z.object({
  id: z.string(),
  planCode: z.string(),
  status: z.enum(['active', 'past_due', 'cancelled', 'trialing']),
  currentPeriodEnd: z.string().datetime(),
  accountsUsed: z.number().int(),
  accountsLimit: z.number().int().nullable(),
});

export const createSubscriptionRequestSchema = z.object({
  planCode: z.string().min(1),
});

// ---------------------------------------------------------------------------
// account sharing
// ---------------------------------------------------------------------------

export const createAccountShareRequestSchema = z.object({
  accountId: z.string().min(1),
  granteeEmail: z.string().email(),
  role: z.enum(['viewer', 'manager', 'copier']).default('viewer'),
  shareBalance: z.boolean().default(true),
  shareEquity: z.boolean().default(true),
  shareHistory: z.boolean().default(true),
  canCopy: z.boolean().default(false),
});

export const accountShareDtoSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  role: z.enum(['viewer', 'manager', 'copier']),
  status: z.enum(['active', 'revoked']),
  granteeEmail: z.string(),
  permissions: z.record(z.boolean()),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export const apiKeyDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(80),
  expiresAt: z.string().datetime().nullable().default(null),
});

export const createApiKeyResponseSchema = z.object({
  apiKey: apiKeyDtoSchema,
  /** Returned exactly once. */
  secret: z.string(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.record(z.object({ status: z.enum(['ok', 'fail']), message: z.string().optional() })),
});

export const readyResponseSchema = z.object({
  realtimeTicket: z.string(),
  expiresAt: z.string().datetime(),
});
