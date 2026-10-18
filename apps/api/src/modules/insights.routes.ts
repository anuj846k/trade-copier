import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  notificationChannelKindSchema,
  notificationEventSchema,
  type ClosedTrade,
  type Position,
} from '@trade-copier/contracts';
import { computeAnalytics } from '@trade-copier/domain';
import { ApiError } from '../lib/errors.js';
import { requireCopier } from './copiers.routes.js';
import { requireAccount } from './accounts.routes.js';
import type { NotificationChannelRecord } from '@trade-copier/db';

/**
 * Read models: execution log, notifications, analytics, audit, plans and the
 * diagnostics endpoint the dashboard's system page reads.
 *
 * Everything here is derived from tables the engine writes, so no query blocks
 * the copy path and the dashboard can be refreshed as often as the UI likes.
 */

export const insightRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { repos, env } = fastify;

  // -------------------------------------------------------------------------
  // execution log
  // -------------------------------------------------------------------------

  fastify.get('/logs', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const query = logQuerySchema.parse(request.query);
    const result = await repos.engine.listLogs({
      userId,
      copierId: query.copierId,
      followerId: query.followerId,
      accountId: query.accountId,
      levels: query.level,
      codes: query.code,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      entries: result.rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        level: row.level,
        code: row.code,
        message: row.message,
        context: row.context,
        copierId: row.copierId,
        followerId: row.followerId,
        accountId: row.accountId,
      })),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  /** "Download log" — the same filter set, as CSV. */
  fastify.get('/logs/export', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const query = logQuerySchema.parse(request.query);
    const result = await repos.engine.listLogs({
      userId,
      copierId: query.copierId,
      followerId: query.followerId,
      accountId: query.accountId,
      levels: query.level,
      codes: query.code,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: 5_000,
      offset: 0,
    });
    const header = 'timestamp,level,code,message,accountId,followerId,copierId,context\n';
    const body = result.rows
      .map((row) =>
        [
          row.createdAt.toISOString(),
          row.level,
          row.code,
          row.message,
          row.accountId ?? '',
          row.followerId ?? '',
          row.copierId ?? '',
          row.context ? JSON.stringify(row.context) : '',
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="trade-copier-log-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(header + body);
  });

  // -------------------------------------------------------------------------
  // notifications
  // -------------------------------------------------------------------------

  fastify.get('/notifications', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const [outbox, channels, settings] = await Promise.all([
      repos.platform.listNotifications(userId, query.limit),
      repos.platform.listChannels(userId),
      repos.platform.listNotificationSettings(userId),
    ]);
    return {
      notifications: outbox.map((row) => ({
        id: row.id,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        channelId: row.channelId,
        payload: row.payload,
        sentAt: row.sentAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      channels: channels.map(serializeChannel),
      settings,
      availableEvents: notificationEventSchema.options,
    };
  });

  fastify.get('/notifications/channels', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const channels = await repos.platform.listChannels(userId);
    return { channels: channels.map(serializeChannel) };
  });

  fastify.post('/notifications/channels', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const body = channelSchema.parse(request.body);
    const channel = await repos.platform.upsertChannel({
      userId,
      kind: body.kind,
      enabled: body.enabled,
      config: body.config,
      secretsEncrypted: body.secret ? fastify.cipher.encrypt(body.secret) : null,
    });
    await repos.platform.audit({ userId, action: 'notification_channel.upserted', entityType: 'channel', entityId: channel.id, meta: { kind: body.kind }, ip: request.ip });
    return reply.status(201).send({ channel: serializeChannel(channel) });
  });

  fastify.patch('/notifications/channels/:channelId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { channelId } = request.params as { channelId: string };
    const existing = await repos.platform.findChannel(channelId);
    if (!existing || existing.userId !== userId) throw ApiError.notFound('Channel not found');

    const body = channelPatchSchema.parse(request.body);
    const channel = await repos.platform.upsertChannel({
      userId,
      kind: existing.kind,
      enabled: body.enabled ?? existing.enabled,
      config: { ...existing.config, ...(body.config ?? {}) },
      ...(body.secret !== undefined ? { secretsEncrypted: body.secret ? fastify.cipher.encrypt(body.secret) : null } : {}),
    });
    return { channel: serializeChannel(channel) };
  });

  fastify.delete('/notifications/channels/:channelId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { channelId } = request.params as { channelId: string };
    const deleted = await repos.platform.deleteChannel(userId, channelId);
    if (!deleted) throw ApiError.notFound('Channel not found');
    return { ok: true };
  });

  fastify.put('/notifications/settings', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const body = z
      .object({
        channelId: z.string().min(1),
        event: notificationEventSchema,
        enabled: z.boolean(),
        subject: z.string().max(200).nullable().optional(),
        template: z.string().max(5_000).nullable().optional(),
        accountBlocklist: z.array(z.string()).max(200).optional(),
      })
      .parse(request.body);
    const channel = await repos.platform.findChannel(body.channelId);
    if (!channel || channel.userId !== userId) throw ApiError.notFound('Channel not found');

    await repos.platform.upsertNotificationSetting({
      userId,
      channelId: body.channelId,
      event: body.event,
      enabled: body.enabled,
      subject: body.subject ?? null,
      template: body.template ?? null,
      accountBlocklist: body.accountBlocklist ?? [],
    });
    return { ok: true, settings: await repos.platform.listNotificationSettings(userId) };
  });

  /** Sends one synthetic notification so the user can verify their channel. */
  fastify.post('/notifications/test', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const body = z.object({ channelId: z.string().min(1) }).parse(request.body);
    const channel = await repos.platform.findChannel(body.channelId);
    if (!channel || channel.userId !== userId) throw ApiError.notFound('Channel not found');
    await repos.platform.enqueueNotification({
      userId,
      channelId: channel.id,
      event: 'account_connected',
      payload: {
        test: true,
        message: 'This is a test notification from Trade Copier.',
        at: new Date().toISOString(),
      },
      dedupeKey: `test:${channel.id}:${Date.now()}`,
    });
    return { ok: true, queued: true, note: 'The delivery worker will send it within a few seconds; failures appear in the list below.' };
  });

  // -------------------------------------------------------------------------
  // analytics
  // -------------------------------------------------------------------------

  fastify.get('/analytics/dashboard', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const user = await repos.auth.findUserById(userId);
    const [accounts, copiers, subscription] = await Promise.all([
      repos.accounts.listAccessible(userId),
      repos.copiers.listByUser(userId),
      repos.platform.getSubscription(userId),
    ]);

    const engineAccounts = accounts.filter((account) => account.role !== 'slave');
    const equityByAccount = accounts.map((account) => ({
      accountId: account.id,
      label: account.label,
      currency: account.currency,
      balance: account.balance,
      equity: account.equity,
      online: fastify.engine.hub.isAccountOnline(account.id),
    }));
    const totalEquity = equityByAccount.reduce((sum, entry) => sum + (entry.equity ?? entry.balance ?? 0), 0);

    let openLinkCount = 0;
    let runningCopiers = 0;
    for (const copier of copiers) {
      const counts = await repos.engine.linkStateCounts(copier.id);
      openLinkCount += (counts.open ?? 0) + (counts.partial ?? 0);
      if (copier.status === 'enabled') runningCopiers += 1;
    }

    const recentLogs = await repos.engine.listLogs({ userId, limit: 15 });
    return {
      user: user ? { id: user.id, firstName: user.firstName, email: user.email, timezone: user.timezone } : null,
      totals: {
        accounts: accounts.length,
        masterAccounts: engineAccounts.length,
        copiers: copiers.length,
        runningCopiers,
        openCopiedTrades: openLinkCount,
        totalEquity,
        currency: equityByAccount[0]?.currency ?? 'USD',
      },
      equityByAccount,
      subscription: subscription ? { planCode: subscription.planCode, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null } : null,
      recentLog: recentLogs.rows.map((row) => ({ id: row.id, at: row.createdAt.toISOString(), level: row.level, code: row.code, message: row.message })),
    };
  });

  fastify.get('/analytics/accounts/:accountId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    const account = await requireAccount(fastify, userId, accountId);
    const user = await repos.auth.findUserById(userId);

    const query = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        followerId: z.string().optional(),
      })
      .parse(request.query);
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    const to = query.to ? new Date(query.to) : new Date();

    const [rawTrades, snapshots, followers] = await Promise.all([
      repos.engine.listClosedTrades(accountId, from, to, 10_000),
      repos.engine.listSnapshots(accountId, from, to, 5_000),
      repos.copiers.listByFollowerAccount(accountId),
    ]);
    const followerIds = query.followerId ? [query.followerId] : followers.map((entry) => entry.followerId);
    const closedTrades: ClosedTrade[] = rawTrades
      .filter((trade) => (query.followerId ? trade.followerId === query.followerId : true))
      .map((trade) => ({
        ticket: trade.ticket,
        symbol: trade.symbol,
        side: trade.side as ClosedTrade['side'],
        volume: trade.volume,
        openPrice: trade.openPrice,
        closePrice: trade.closePrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        magic: trade.magic,
        comment: trade.comment,
        profit: trade.profit,
        swap: trade.swap,
        commission: trade.commission,
        openedAt: trade.openedAt.toISOString(),
        closedAt: trade.closedAt.toISOString(),
        followerId: trade.followerId,
      }));

    const cache = fastify.engine.hub.cacheFor(accountId);
    const openPositions: readonly Position[] = cache?.positions() ?? [];
    const balance = account.balance ?? 0;
    const equity = account.equity ?? balance;

    const analytics = computeAnalytics({
      currency: account.currency,
      balance,
      equity,
      closedTrades,
      openPositions: openPositions.map((position) => ({
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        profit: position.profit ?? null,
      })),
      equitySeries: snapshots.map((snapshot) => ({
        at: snapshot.takenAt.toISOString(),
        balance: snapshot.balance,
        equity: snapshot.equity,
      })),
      timezone: user?.timezone ?? 'UTC',
      startingBalance: account.referenceBalance ?? undefined,
    });

    return {
      account: { id: account.id, label: account.label, currency: account.currency, online: fastify.engine.hub.isAccountOnline(account.id) },
      from: from.toISOString(),
      to: to.toISOString(),
      followerIds,
      analytics,
      openPositions: openPositions.map((position) => ({
        ticket: position.ticket,
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        openPrice: position.openPrice,
        profit: position.profit,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
      })),
    };
  });

  fastify.get('/analytics/copiers/:copierId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, userId, copierId);
    const query = z
      .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
      .parse(request.query);
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    const to = query.to ? new Date(query.to) : new Date();

    const [counts, followers, logs] = await Promise.all([
      repos.engine.linkStateCounts(copierId),
      repos.copiers.listFollowersResolved(copierId),
      repos.engine.listLogs({ userId, copierId, limit: 200 }),
    ]);

    const accounts = await repos.accounts.listByUser(userId);
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const perFollower = await Promise.all(
      followers.map(async (follower) => {
        const copied = await repos.engine.copiedTradesSince(follower.accountId, from, [follower.id]);
        const profit = copied.reduce((sum, trade) => sum + trade.profit + trade.swap + trade.commission, 0);
        return {
          followerId: follower.id,
          accountId: follower.accountId,
          label: accountById.get(follower.accountId)?.label ?? follower.accountId,
          copiedTrades: copied.length,
          realisedProfit: round2(profit),
          links: await repos.engine.linkStateCounts(copierId),
          lastErrorCode: follower.lastErrorCode,
          lastErrorAt: follower.lastEventAt?.toISOString() ?? null,
        };
      }),
    );

    return {
      copier: { id: copier.id, name: copier.name, status: copier.status },
      from: from.toISOString(),
      to: to.toISOString(),
      linkStateCounts: counts,
      followers: perFollower,
      errorRate: {
        failed: (counts.failed ?? 0) + (counts.skipped ?? 0),
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      },
      recentLog: logs.rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        level: row.level,
        code: row.code,
        message: row.message,
        followerId: row.followerId,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------

  fastify.get('/audit', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const entries = await repos.platform.listAudit(userId, query.limit);
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        meta: entry.meta,
        ip: entry.ip,
        at: entry.createdAt.toISOString(),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // billing / plans
  // -------------------------------------------------------------------------

  fastify.get('/billing/plans', async () => {
    const plans = await repos.platform.listPlans();
    return { plans: plans.filter((plan) => plan.active) };
  });

  fastify.get('/billing/subscription', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const [subscription, activeAccounts] = await Promise.all([
      repos.platform.getSubscription(userId),
      repos.platform.countActiveAccountsForPlan(userId),
    ]);
    return {
      subscription: subscription
        ? {
            planCode: subscription.planCode,
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }
        : null,
      usage: { activeAccounts },
    };
  });

  /**
   * Plan selection.
   *
   * There is no payment provider in this build: `POST /billing/subscribe` only
   * records the intent and marks the subscription `trialing`. Plugging in
   * Stripe/Paddle means verifying the provider webhook here and calling
   * `upsertSubscription` from it (see docs/MANUAL-STEPS.md).
   */
  fastify.post('/billing/subscribe', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const body = z
      .object({ planCode: z.string().min(1), providerCheckoutId: z.string().max(200).optional() })
      .parse(request.body);
    if (!env.ENABLED_PLAN_CODES.includes(body.planCode)) {
      throw ApiError.badRequest(`Unknown plan ${body.planCode}`, { enabled: env.ENABLED_PLAN_CODES });
    }
    const now = new Date();
    await repos.platform.upsertSubscription({
      userId,
      planCode: body.planCode,
      status: 'trialing',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000),
      providerRef: body.providerCheckoutId ?? null,
    });
    await repos.platform.audit({ userId, action: 'billing.subscribe_requested', meta: { planCode: body.planCode }, ip: request.ip });
    return {
      ok: true,
      note: 'No payment provider is wired up in this build: the subscription is marked trialing and must be confirmed by your billing webhook.',
      redirectUrl: null,
    };
  });

  // -------------------------------------------------------------------------
  // diagnostics
  // -------------------------------------------------------------------------

  fastify.get('/diagnostics', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const user = await repos.auth.findUserById(userId);
    const [diagnostics, queueDepth, oldestQueuedAgeMs, logsLastHour] = await Promise.all([
      repos.platform.diagnostics(),
      repos.engine.queueDepth(),
      repos.engine.oldestQueuedAgeMs(),
      repos.platform.countLogsSince(new Date(Date.now() - 60 * 60 * 1_000)),
    ]);
    return {
      user: { id: userId, role: user?.role ?? 'user' },
      database: diagnostics,
      queue: { depth: queueDepth, oldestQueuedAgeMs },
      logsLastHour,
      engine: {
        workerPollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
        copyRetryWindowMs: env.COPY_RETRY_WINDOW_MS,
        commandTimeoutMs: env.COMMAND_TIMEOUT_MS,
        equityProtectionIntervalMs: env.EQUITY_PROTECTION_INTERVAL_MS,
        snapshotIntervalMs: env.EQUITY_SNAPSHOT_INTERVAL_MS,
      },
      agents: fastify.engine.hub.stats(),
      realtime: fastify.ui.stats(),
      uptimeSeconds: Math.round(process.uptime()),
      version: env.APP_VERSION ?? 'dev',
    };
  });
};

// ---------------------------------------------------------------------------
// helpers + schemas
// ---------------------------------------------------------------------------

const logQuerySchema = z.object({
  copierId: z.string().optional(),
  followerId: z.string().optional(),
  accountId: z.string().optional(),
  level: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
  code: z.array(z.string()).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const channelSchema = z.object({
  kind: notificationChannelKindSchema,
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
  secret: z.string().max(500).nullable().optional(),
});

const channelPatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  secret: z.string().max(500).nullable().optional(),
});

function serializeChannel(channel: NotificationChannelRecord) {
  return {
    id: channel.id,
    kind: channel.kind,
    enabled: channel.enabled,
    config: maskSecrets(channel.config),
    hasSecret: channel.hasSecret,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

/** Config may carry a password-like field for user-defined webhooks. */
function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = /pass|secret|token|key/i.test(key) ? '••••••' : value;
  }
  return out;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const __testables = { maskSecrets, csvCell, round2 };
