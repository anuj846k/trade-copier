import { z } from 'zod';
import {
  assetClassSchema,
  orderKindSchema,
  pendingOrderTypeSchema,
  symbolTradeModeSchema,
  tradeSideSchema,
} from './platform.js';

export const symbolInfoSchema = z.object({
  /** Broker symbol exactly as returned by the platform (identity — never normalised away). */
  name: z.string().min(1),
  /** Canonical instrument key derived from `name` (display/lookup only). */
  canonical: z.string().min(1),
  assetClass: assetClassSchema.default('unknown'),
  digits: z.number().int().min(0).max(8),
  /** Smallest price increment (1e-5 for a 5-digit EURUSD quote). */
  point: z.number().positive(),
  /** One pip in price terms (10 points on a 5-digit quote, 0.01 on JPY pairs). */
  pipSize: z.number().positive(),
  /** Units of the base asset per 1.00 lot (100000 for FX standard). */
  contractSize: z.number().positive(),
  minLot: z.number().positive(),
  maxLot: z.number().positive(),
  lotStep: z.number().positive(),
  /** Broker's own trade mode; `disabled` symbols must never be traded. */
  tradeMode: symbolTradeModeSchema.default('full'),
  /** Trading account level toggle (reference: "disable a symbol on your trading account"). */
  enabled: z.boolean().default(true),
  quoteCurrency: z.string().min(3).max(8),
  /** Upper bound used when the broker refuses volumes above this per order. */
  maxLotPerOrder: z.number().positive().nullable().default(null),
  /** Swap and commission are informational for reporting only. */
  swapLong: z.number().nullable().default(null),
  swapShort: z.number().nullable().default(null),
  updatedAt: z.string().datetime().optional(),
});
export type SymbolInfo = z.infer<typeof symbolInfoSchema>;

export const quoteSchema = z.object({
  symbol: z.string().min(1),
  bid: z.number().positive(),
  ask: z.number().positive(),
  at: z.string().datetime(),
});
export type Quote = z.infer<typeof quoteSchema>;

/** A live position, normalised across platforms. */
export const positionSchema = z.object({
  /** Broker ticket/position id, as a string to survive 64-bit ids. */
  ticket: z.string().min(1),
  symbol: z.string().min(1),
  side: tradeSideSchema,
  volume: z.number().positive(),
  /** Volume already closed by partial closes. */
  closedVolume: z.number().nonnegative().default(0),
  openPrice: z.number().positive(),
  currentPrice: z.number().positive().nullable().default(null),
  stopLoss: z.number().positive().nullable().default(null),
  takeProfit: z.number().positive().nullable().default(null),
  /** Position or pending order. */
  kind: orderKindSchema.default('market'),
  pendingType: pendingOrderTypeSchema.nullable().default(null),
  expiry: z.string().datetime().nullable().default(null),
  magic: z.number().int().default(0),
  comment: z.string().max(128).default(''),
  /** Server-assigned id of the trade that opened this position, when we caused it. */
  originRequestId: z.string().nullable().default(null),
  openedAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  /** Broker-reported floating P/L in account currency. */
  profit: z.number().nullable().default(null),
  swap: z.number().nullable().default(null),
  commission: z.number().nullable().default(null),
});
export type Position = z.infer<typeof positionSchema>;

/** A closed trade leg, used for analytics. */
export const closedTradeSchema = z.object({
  ticket: z.string(),
  symbol: z.string(),
  side: tradeSideSchema,
  volume: z.number().nonnegative(),
  openPrice: z.number(),
  closePrice: z.number(),
  stopLoss: z.number().nullable().default(null),
  takeProfit: z.number().nullable().default(null),
  magic: z.number().int().default(0),
  comment: z.string().default(''),
  profit: z.number(),
  swap: z.number().default(0),
  commission: z.number().default(0),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime(),
  /** Which follower this copy belonged to, when it was copier-placed. */
  followerId: z.string().nullable().default(null),
});
export type ClosedTrade = z.infer<typeof closedTradeSchema>;

export const accountSnapshotSchema = z.object({
  accountId: z.string(),
  balance: z.number(),
  equity: z.number(),
  margin: z.number().default(0),
  freeMargin: z.number().default(0),
  marginLevel: z.number().nullable().default(null),
  currency: z.string().min(3).max(8),
  leverage: z.number().int().positive().nullable().default(null),
  at: z.string().datetime(),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

/** Everything the bridge agent reports about an account on connect. */
export const accountBundleSchema = z.object({
  accountId: z.string(),
  snapshot: accountSnapshotSchema,
  symbols: z.array(symbolInfoSchema),
  positions: z.array(positionSchema),
});
export type AccountBundle = z.infer<typeof accountBundleSchema>;
