import { z } from 'zod';
import { positionSchema, quoteSchema, symbolInfoSchema } from './trade.js';

/**
 * Realtime protocol. Two independent channels:
 *
 *  - `/bridge/agent` — outbound-only from a bridge agent (EA/host connector)
 *    that owns one or more broker accounts. Auth via agent token.
 *  - `/ws` — dashboard clients. Auth via a short-lived single-use ticket.
 *
 * Every message is `{ type, ...payload }` and validated on both ends.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// bridge agent -> server
// ---------------------------------------------------------------------------

export const agentAccountDescriptorSchema = z.object({
  accountId: z.string(),
  login: z.string(),
  server: z.string(),
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock']),
  currency: z.string(),
  leverage: z.number().int().positive().nullable().default(null),
  kind: z.enum(['demo', 'live']).default('live'),
  /** Capability flags so the server never issues unsupported commands. */
  capabilities: z
    .object({
      pendingOrders: z.boolean().default(true),
      partialClose: z.boolean().default(true),
      modify: z.boolean().default(true),
      expiry: z.boolean().default(false),
      quotes: z.boolean().default(true),
      closeOnly: z.boolean().default(true),
    })
    .default({}),
});

export const agentHelloSchema = z.object({
  type: z.literal('agent.hello'),
  protocolVersion: z.number().int(),
  agentToken: z.string().min(10),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  host: z.string().max(120).optional(),
  accounts: z.array(agentAccountDescriptorSchema),
});

export const agentHeartbeatSchema = z.object({
  type: z.literal('agent.heartbeat'),
  at: z.string().datetime(),
  queueDepth: z.number().int().nonnegative().default(0),
  latencyMs: z.number().nonnegative().nullable().default(null),
});

export const agentAccountStateSchema = z.object({
  type: z.literal('account.state'),
  accountId: z.string(),
  balance: z.number(),
  equity: z.number(),
  margin: z.number().default(0),
  freeMargin: z.number().default(0),
  marginLevel: z.number().nullable().default(null),
  currency: z.string().optional(),
  leverage: z.number().int().positive().nullable().optional(),
  at: z.string().datetime(),
});

export const agentSymbolsSchema = z.object({
  type: z.literal('agent.symbols'),
  accountId: z.string(),
  /** Full replacement set for the account. */
  symbols: z.array(symbolInfoSchema),
});

export const agentPositionsSnapshotSchema = z.object({
  type: z.literal('agent.positions.snapshot'),
  accountId: z.string(),
  /** Request id echoed back when this snapshot was requested. */
  requestId: z.string().nullable().default(null),
  positions: z.array(positionSchema),
});

export const agentQuoteSchema = z.object({
  type: z.literal('agent.quote'),
  accountId: z.string(),
  quotes: z.array(quoteSchema).min(1).max(200),
});

export const agentPositionEventSchema = z.object({
  type: z.enum(['position.opened', 'position.modified', 'position.closed']),
  accountId: z.string(),
  position: positionSchema,
});

export const agentOrderEventSchema = z.object({
  type: z.enum(['order.placed', 'order.modified', 'order.cancelled']),
  accountId: z.string(),
  order: positionSchema,
});

export const agentClosedTradeSchema = z.object({
  type: z.literal('closed_trade'),
  accountId: z.string(),
  trade: z.object({
    ticket: z.string(),
    symbol: z.string(),
    side: z.enum(['buy', 'sell']),
    volume: z.number(),
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
  }),
});

export const agentCommandResultSchema = z.object({
  type: z.literal('command.result'),
  requestId: z.string(),
  status: z.enum(['filled', 'accepted', 'partial', 'rejected', 'error']),
  ticket: z.string().nullable().default(null),
  filledVolume: z.number().nullable().default(null),
  filledPrice: z.number().nullable().default(null),
  closedVolume: z.number().nullable().default(null),
  errorCode: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  /** Echoed decision trace, useful for post-mortems. */
  message: z.string().nullable().default(null),
});

export const agentPongSchema = z.object({
  type: z.literal('agent.pong'),
  ts: z.string().datetime(),
});

export const agentLogSchema = z.object({
  type: z.literal('agent.log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  accountId: z.string().nullable().default(null),
  context: z.record(z.unknown()).nullable().default(null),
});

export const bridgeInboundSchema = z.discriminatedUnion('type', [
  agentHelloSchema,
  agentHeartbeatSchema,
  agentAccountStateSchema,
  agentSymbolsSchema,
  agentPositionsSnapshotSchema,
  agentQuoteSchema,
  agentPositionEventSchema,
  agentOrderEventSchema,
  agentClosedTradeSchema,
  agentCommandResultSchema,
  agentPongSchema,
  agentLogSchema,
]);
export type BridgeInboundMessage = z.infer<typeof bridgeInboundSchema>;

// ---------------------------------------------------------------------------
// server -> bridge agent
// ---------------------------------------------------------------------------

export const serverWelcomeSchema = z.object({
  type: z.literal('server.welcome'),
  agentId: z.string(),
  protocolVersion: z.number().int(),
  serverTime: z.string().datetime(),
  heartbeatIntervalMs: z.number().int().positive(),
  /** Accounts the agent is allowed to serve (authoritative list). */
  accounts: z.array(z.object({ accountId: z.string(), login: z.string(), server: z.string() })),
});

export const serverRequestSnapshotSchema = z.object({
  type: z.literal('server.request.snapshot'),
  requestId: z.string(),
  accountId: z.string(),
  include: z.array(z.enum(['account', 'symbols', 'positions'])).min(1),
});

/** Execution command issued by the copy engine. */
export const commandKindSchema = z.enum([
  'open',
  'close',
  'close_partial',
  'modify',
  'place_pending',
  'cancel_pending',
  'close_all',
]);
export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandParamsSchema = z.object({
  /** Required for open / place_pending; omitted for ticket-scoped actions. */
  symbol: z.string().min(1).optional(),
  side: z.enum(['buy', 'sell']).optional(),
  volume: z.number().positive().optional(),
  /** Broker ticket for close/modify/cancel actions. */
  ticket: z.string().optional(),
  price: z.number().positive().nullable().optional(),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  /** Requested deviation in pips; adapters convert to platform points. */
  maxSlippagePips: z.number().nonnegative().optional(),
  magic: z.number().int().optional(),
  comment: z.string().max(128).optional(),
  pendingType: z.string().nullable().optional(),
  expiry: z.string().datetime().nullable().optional(),
  /** Only close positions that carry this magic (used by Equity Protection). */
  filterMagic: z.number().int().nullable().optional(),
  /** Only close positions tagged with these request ids (copier-placed only). */
  originRequestIds: z.array(z.string()).optional(),
});
export type CommandParams = z.infer<typeof commandParamsSchema>;

export const serverCommandSchema = z.object({
  type: z.literal('server.command'),
  requestId: z.string(),
  accountId: z.string(),
  kind: commandKindSchema,
  params: commandParamsSchema,
  /** Hard deadline for the agent to return a result. */
  timeoutMs: z.number().int().positive(),
  /** Correlates the copy decision that produced this command. */
  trace: z
    .object({
      copierId: z.string().nullable().default(null),
      followerId: z.string().nullable().default(null),
      masterTradeId: z.string().nullable().default(null),
      masterTicket: z.string().nullable().default(null),
    })
    .default({}),
});
export type ServerCommand = z.infer<typeof serverCommandSchema>;

export const serverPingSchema = z.object({
  type: z.literal('server.ping'),
  ts: z.string().datetime(),
});

export const bridgeOutboundSchema = z.discriminatedUnion('type', [
  serverWelcomeSchema,
  serverRequestSnapshotSchema,
  serverCommandSchema,
  serverPingSchema,
]);
export type BridgeOutboundMessage = z.infer<typeof bridgeOutboundSchema>;

// ---------------------------------------------------------------------------
// dashboard /ws
// ---------------------------------------------------------------------------

export const realtimeTopicSchema = z.enum([
  'accounts',
  'copiers',
  'trades',
  'logs',
  'notifications',
  'equity_protection',
]);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

export const uiClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topics: z.array(realtimeTopicSchema).min(1) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(realtimeTopicSchema).min(1) }),
  z.object({ type: z.literal('ping') }),
]);
export type UiClientMessage = z.infer<typeof uiClientMessageSchema>;

export const uiServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    topics: z.array(realtimeTopicSchema),
    serverTime: z.string().datetime(),
  }),
  z.object({ type: z.literal('pong'), ts: z.string().datetime() }),
  z.object({
    type: z.literal('account.status'),
    accountId: z.string(),
    status: z.string(),
    balance: z.number().nullable(),
    equity: z.number().nullable(),
    freeMargin: z.number().nullable(),
    lastErrorCode: z.string().nullable(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('copier.updated'),
    copierId: z.string(),
    status: z.string(),
    followerStates: z.array(
      z.object({
        followerId: z.string(),
        accountId: z.string(),
        enabled: z.boolean(),
        effectiveStatus: z.string(),
        blockedReason: z.string().nullable(),
      }),
    ),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('trade.updated'),
    masterTradeId: z.string(),
    ticket: z.string(),
    symbol: z.string(),
    side: z.enum(['buy', 'sell']),
    volume: z.number(),
    state: z.enum(['open', 'closed']),
    links: z.array(
      z.object({
        followerId: z.string(),
        accountId: z.string(),
        status: z.string(),
        errorCode: z.string().nullable(),
        filledVolume: z.number().nullable(),
      }),
    ),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('log.appended'),
    entry: z.record(z.unknown()),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('equity_protection.triggered'),
    accountId: z.string(),
    reason: z.string(),
    actions: z.array(z.string()),
    at: z.string().datetime(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type UiServerMessage = z.infer<typeof uiServerMessageSchema>;
