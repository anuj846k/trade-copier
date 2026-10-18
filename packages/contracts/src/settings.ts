import { z } from 'zod';
import { riskTypeSchema } from './risk.js';
import { tradeSideSchema } from './platform.js';

/** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
export const isoWeekdaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export type IsoWeekday = z.infer<typeof isoWeekdaySchema>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const timeOfDaySchema = z.string().regex(HHMM, 'Time must be HH:mm (24h)');
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/** A single "copy new trades between start and end" window in the user's timezone. */
export const tradingWindowSchema = z.object({
  day: isoWeekdaySchema,
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export type TradingWindow = z.infer<typeof tradingWindowSchema>;

export const commentModeSchema = z.enum(['none', 'master', 'custom']);
export type CommentMode = z.infer<typeof commentModeSchema>;

export const magicModeSchema = z.enum(['master', 'custom']);
export type MagicMode = z.infer<typeof magicModeSchema>;

export const magicFilterSchema = z.object({
  mode: z.enum(['all', 'copy', 'ignore']).default('all'),
  values: z.array(z.number().int()).default([]),
});
export type MagicFilter = z.infer<typeof magicFilterSchema>;

export const commentFilterSchema = z.object({
  mode: z.enum(['all', 'copy', 'ignore']).default('all'),
  /** Matched as a case-insensitive substring, matching the reference behaviour. */
  values: z.array(z.string().min(1)).default([]),
});
export type CommentFilter = z.infer<typeof commentFilterSchema>;

export const lotFilterSchema = z.object({
  min: z.number().nonnegative().nullable().default(null),
  max: z.number().positive().nullable().default(null),
});
export type LotFilter = z.infer<typeof lotFilterSchema>;

export const symbolFilterSchema = z.object({
  mode: z.enum(['all', 'include', 'exclude']).default('all'),
  values: z.array(z.string().min(1)).default([]),
});
export type SymbolFilter = z.infer<typeof symbolFilterSchema>;

export const tradeFiltersSchema = z.object({
  magic: magicFilterSchema.default({ mode: 'all', values: [] }),
  comment: commentFilterSchema.default({ mode: 'all', values: [] }),
  side: z.union([z.literal('all'), tradeSideSchema]).default('all'),
  lot: lotFilterSchema.default({ min: null, max: null }),
  symbol: symbolFilterSchema.default({ mode: 'all', values: [] }),
});
export type TradeFilters = z.infer<typeof tradeFiltersSchema>;

/**
 * Reconnect reconciliation behaviour. NOT documented by the reference product
 * (see FEATURES.md U7) so it ships disabled and must be opted into per slave.
 */
export const reconnectPolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** Close slave positions that no longer exist on the master. */
  closeOrphans: z.boolean().default(false),
  /** Open slave positions that exist on the master but are missing on the slave. */
  reopenMissing: z.boolean().default(false),
});
export type ReconnectPolicy = z.infer<typeof reconnectPolicySchema>;

/**
 * The complete per-slave configuration. Every field maps to a documented
 * reference setting (see FEATURES.md §1.3–1.6) or to an explicitly flagged
 * engineering addition (`reconnectPolicy`, `maxSpreadPips`, `maxQuoteAgeMs`).
 */
export const followerSettingsSchema = z.object({
  enabled: z.boolean().default(true),

  // --- sizing ---------------------------------------------------------------
  riskType: riskTypeSchema.default('LOT_MULTIPLIER'),
  /** % for multipliers / % risk; absolute lots for FIXED_LOT. */
  riskValue: z.number().positive().default(100),
  /** Used by FIXED_BALANCE_MULTIPLIER. */
  fixedMasterBalance: z.number().positive().nullable().default(null),
  /** Additive lot offset (may be negative). */
  lotRefiner: z.number().default(0),
  /** Honour differing contract sizes. Defaults to true for balance multipliers. */
  contractAlignment: z.boolean().nullable().default(null),
  forceMinLot: z.boolean().default(false),
  forceMaxLot: z.boolean().default(false),

  // --- stop loss / take profit ---------------------------------------------
  copyStopLoss: z.boolean().default(true),
  copyTakeProfit: z.boolean().default(true),
  /** Applied when the master trade has no SL. */
  fixedStopLossPips: z.number().nonnegative().nullable().default(null),
  /** Applied when the master trade has no TP. */
  fixedTakeProfitPips: z.number().nonnegative().nullable().default(null),
  stopLossRefinePips: z.number().default(0),
  takeProfitRefinePips: z.number().default(0),
  /** Ignore master close events; the slave exits only via its own SL/TP. */
  strictClose: z.boolean().default(false),

  // --- direction ------------------------------------------------------------
  reverseTrade: z.boolean().default(false),

  // --- orders ---------------------------------------------------------------
  copyPendingOrders: z.boolean().default(false),
  copyExpiryTime: z.boolean().default(true),

  // --- identity -------------------------------------------------------------
  commentMode: commentModeSchema.default('master'),
  customComment: z.string().max(31).default(''),
  magicMode: magicModeSchema.default('master'),
  customMagic: z.number().int().min(0).max(2_147_483_647).nullable().default(null),

  // --- execution tolerances -------------------------------------------------
  /** Max deviation handed to the broker in pips (mapped to points per platform). */
  maxSlippagePips: z.number().nonnegative().default(2),
  /** Reject entries when the live spread exceeds this; null disables the check. */
  maxSpreadPips: z.number().nonnegative().nullable().default(null),
  /** Reject decisions based on quotes older than this. */
  maxQuoteAgeMs: z.number().int().positive().default(5_000),
  /** Fixed or random entry delay, in ms (Send/Modify/Close are all delayed). */
  tradeDelayMsMin: z.number().int().min(0).max(60_000).default(0),
  tradeDelayMsMax: z.number().int().min(0).max(60_000).default(0),

  // --- filters --------------------------------------------------------------
  filters: tradeFiltersSchema.default({}),

  // --- schedule -------------------------------------------------------------
  tradingHoursEnabled: z.boolean().default(false),
  tradingHours: z.array(tradingWindowSchema).default([]),
  /** IANA timezone used to evaluate tradingHours. */
  timezone: z.string().min(1).default('UTC'),

  // --- reconciliation -------------------------------------------------------
  reconnectPolicy: reconnectPolicySchema.default({}),
});
export type FollowerSettings = z.infer<typeof followerSettingsSchema>;
export type FollowerSettingsInput = z.input<typeof followerSettingsSchema>;

/** Per-symbol override: any subset of follower settings, keyed by master symbol. */
export const symbolOverrideSchema = z.object({
  masterSymbol: z.string().min(1),
  settings: followerSettingsSchema.partial().omit({ filters: true, tradingHours: true, reconnectPolicy: true }).extend({
    filters: tradeFiltersSchema.partial().optional(),
    tradingHoursEnabled: z.boolean().optional(),
    tradingHours: z.array(tradingWindowSchema).optional(),
    timezone: z.string().optional(),
    reconnectPolicy: reconnectPolicySchema.partial().optional(),
    enabled: z.boolean().optional(),
  }),
});
export type SymbolOverride = z.infer<typeof symbolOverrideSchema>;

/** mergeFollowerSettings applies an override patch on top of base settings. */
export function applySymbolOverride(base: FollowerSettings, override: SymbolOverride | undefined): FollowerSettings {
  if (!override) return base;
  const patch = override.settings;
  return {
    ...base,
    ...stripUndefined(patch),
    filters: { ...base.filters, ...stripUndefined(patch.filters ?? {}) },
    reconnectPolicy: { ...base.reconnectPolicy, ...stripUndefined(patch.reconnectPolicy ?? {}) },
  };
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** Default settings for a newly created slave (matches reference defaults). */
export const DEFAULT_FOLLOWER_SETTINGS: FollowerSettings = followerSettingsSchema.parse({});
