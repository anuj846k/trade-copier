import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { AccountShareRole, EquityProtection, NotificationChannelKind } from '@trade-copier/contracts';
import type { EquityProtectionRule } from '../schema/enums.js';
import type { Database } from '../client.js';
import { id } from '../ids.js';
import {
  accountDailyResets,
  accountShares,
  auditLogs,
  equityProtectionEvents,
  equityProtections,
  jobs,
  notificationChannels,
  notificationOutbox,
  notificationSettings,
  plans,
  subscriptions,
} from '../schema/tables.js';
import { extractRows } from './accounts.js';
import { fromNum, fromNumRequired, toNum, toNumOrNull, toDay } from '../values.js';

export interface EquityProtectionRecord extends EquityProtection {
  accountId: string;
  id: string;
  lastTriggeredAt: Date | null;
  /** Rule that fired most recently (`max_drawdown_percent`, …). */
  lastTriggeredRule: EquityProtectionRule | null;
}

export interface AccountShareRecord {
  id: string;
  accountId: string;
  ownerUserId: string;
  granteeUserId: string;
  role: AccountShareRole;
  status: 'active' | 'revoked';
  permissions: { balance: boolean; equity: boolean; history: boolean; canCopy: boolean };
  createdAt: Date;
}

export interface NotificationChannelRecord {
  id: string;
  userId: string;
  kind: NotificationChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
  /** True when an encrypted secret (bot token, webhook signing key) is stored. */
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed';
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
}

export class PlatformRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // equity protection
  // -------------------------------------------------------------------------

  async getEquityProtection(accountId: string): Promise<EquityProtectionRecord | null> {
    const [row] = await this.db.select().from(equityProtections).where(eq(equityProtections.accountId, accountId)).limit(1);
    return row ? toEquityProtection(row) : null;
  }

  async upsertEquityProtection(accountId: string, config: EquityProtection): Promise<EquityProtectionRecord> {
    const values = {
      enabled: config.enabled,
      resetTime: config.resetTime,
      resetTimezone: config.resetTimezone,
      maxDrawdownPercent: fromNum(config.maxDrawdownPercent ?? null),
      maxDrawdownValue: fromNum(config.maxDrawdownValue ?? null),
      absoluteMinEquity: fromNum(config.absoluteMinEquity ?? null),
      maxProfitPercent: fromNum(config.maxProfitPercent ?? null),
      maxProfitValue: fromNum(config.maxProfitValue ?? null),
      absoluteMaxEquity: fromNum(config.absoluteMaxEquity ?? null),
      disableCopier: config.disableCopier,
      closeCopiedTrades: config.closeCopiedTrades,
      closeAllTrades: config.closeAllTrades,
      notify: config.notify,
      updatedAt: new Date(),
    };

    const [row] = await this.db
      .insert(equityProtections)
      .values({ id: id('protection'), accountId, ...values })
      .onConflictDoUpdate({ target: equityProtections.accountId, set: values })
      .returning();
    return toEquityProtection(row!);
  }

  async listEnabledEquityProtections(): Promise<EquityProtectionRecord[]> {
    const rows = await this.db.select().from(equityProtections).where(eq(equityProtections.enabled, true));
    return rows.map(toEquityProtection);
  }

  async recordEquityProtectionEvent(input: {
    accountId: string;
    userId: string;
    kind: 'breach' | 'reset';
    rule: EquityProtectionRule;
    threshold: number;
    observed: number;
    actions: string[];
    snapshot: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(equityProtectionEvents).values({
      id: id('protectionEvent'),
      accountId: input.accountId,
      userId: input.userId,
      kind: input.kind,
      rule: input.rule,
      threshold: fromNumRequired(input.threshold),
      observed: fromNumRequired(input.observed),
      actions: input.actions,
      snapshot: input.snapshot,
    });
    if (input.kind === 'breach') {
      await this.db
        .update(equityProtections)
        .set({ lastTriggeredAt: new Date(), lastTriggeredRule: input.rule, updatedAt: new Date() })
        .where(eq(equityProtections.accountId, input.accountId));
    }
  }

  async listEquityProtectionEvents(accountId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(equityProtectionEvents)
      .where(eq(equityProtectionEvents.accountId, accountId))
      .orderBy(desc(equityProtectionEvents.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      rule: row.rule,
      threshold: toNum(row.threshold),
      observed: toNum(row.observed),
      actions: row.actions,
      createdAt: row.createdAt,
    }));
  }

  /** Records the daily reset of the reference balance (idempotent per day). */
  async recordDailyReset(input: {
    accountId: string;
    balance: number;
    equity: number;
    at: Date;
  }): Promise<{ created: boolean }> {
    const rows = await this.db
      .insert(accountDailyResets)
      .values({
        id: id('dailyReset'),
        accountId: input.accountId,
        resetDay: toDay(input.at),
        referenceBalance: fromNumRequired(input.balance),
        referenceEquity: fromNumRequired(input.equity),
        resetAt: input.at,
      })
      .onConflictDoNothing({ target: [accountDailyResets.accountId, accountDailyResets.resetDay] })
      .returning({ id: accountDailyResets.id });
    return { created: rows.length > 0 };
  }

  /** Accounts whose daily reference balance has not been set for `day`. */
  async accountsNeedingDailyReset(day: string): Promise<string[]> {
    const rows = await this.db
      .select({ accountId: accountDailyResets.accountId })
      .from(accountDailyResets)
      .where(eq(accountDailyResets.resetDay, day));
    return rows.map((row) => row.accountId);
  }

  // -------------------------------------------------------------------------
  // notifications
  // -------------------------------------------------------------------------

  async upsertChannel(input: {
    userId: string;
    kind: NotificationChannelKind;
    enabled: boolean;
    config: Record<string, unknown>;
    secretsEncrypted?: string | null;
  }): Promise<NotificationChannelRecord> {
    const [row] = await this.db
      .insert(notificationChannels)
      .values({
        id: id('channel'),
        userId: input.userId,
        kind: input.kind,
        enabled: input.enabled,
        config: input.config,
        secretsEncrypted: input.secretsEncrypted ?? null,
      })
      .onConflictDoUpdate({
        target: [notificationChannels.userId, notificationChannels.kind],
        set: {
          enabled: input.enabled,
          config: input.config,
          ...(input.secretsEncrypted !== undefined ? { secretsEncrypted: input.secretsEncrypted } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return toChannel(row!);
  }

  async listChannels(userId: string): Promise<NotificationChannelRecord[]> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.userId, userId))
      .orderBy(asc(notificationChannels.kind));
    return rows.map(toChannel);
  }

  async findChannel(channelId: string): Promise<NotificationChannelRecord | null> {
    const [row] = await this.db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).limit(1);
    return row ? toChannel(row) : null;
  }

  async deleteChannel(userId: string, channelId: string): Promise<boolean> {
    const rows = await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  }

  async upsertNotificationSetting(input: {
    userId: string;
    channelId: string;
    event: string;
    enabled: boolean;
    subject?: string | null;
    template?: string | null;
    accountBlocklist?: string[];
  }): Promise<void> {
    await this.db
      .insert(notificationSettings)
      .values({
        id: id('notificationSetting'),
        userId: input.userId,
        channelId: input.channelId,
        event: input.event,
        enabled: input.enabled,
        subject: input.subject ?? null,
        template: input.template ?? null,
        accountBlocklist: input.accountBlocklist ?? [],
      })
      .onConflictDoUpdate({
        target: [notificationSettings.userId, notificationSettings.channelId, notificationSettings.event],
        set: {
          enabled: input.enabled,
          subject: input.subject ?? null,
          template: input.template ?? null,
          accountBlocklist: input.accountBlocklist ?? [],
          updatedAt: new Date(),
        },
      });
  }

  async listNotificationSettings(userId: string) {
    return this.db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, userId))
      .orderBy(asc(notificationSettings.event));
  }

  /** Channels subscribed to an event, honouring per-account opt-outs. */
  /**
   * Every enabled channel subscribed to `event`.
   *
   * `userId` is required whenever the event concerns one user's account: the
   * table is shared, so an unfiltered lookup would notify unrelated tenants.
   */
  async resolveSubscribers(
    event: string,
    options: { readonly userId?: string | null; readonly accountId?: string | null } = {},
  ) {
    const rows = await this.db
      .select({ setting: notificationSettings, channel: notificationChannels })
      .from(notificationSettings)
      .innerJoin(notificationChannels, eq(notificationChannels.id, notificationSettings.channelId))
      .where(
        and(
          eq(notificationSettings.event, event),
          eq(notificationSettings.enabled, true),
          eq(notificationChannels.enabled, true),
          options.userId ? eq(notificationSettings.userId, options.userId) : undefined,
        ),
      );
    return rows
      .filter((row) => !options.accountId || !row.setting.accountBlocklist.includes(options.accountId))
      .map((row) => ({ setting: row.setting, channel: toChannel(row.channel) }));
  }

  async enqueueNotification(input: {
    userId: string;
    channelId: string;
    event: string;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(notificationOutbox)
      .values({
        id: id('notification'),
        userId: input.userId,
        channelId: input.channelId,
        event: input.event,
        payload: input.payload,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
      .returning({ id: notificationOutbox.id });
    return rows.length > 0;
  }

  async claimNotifications(workerId: string, limit: number) {
    const result = await this.db.execute(sql`
      with claimed as (
        select n.id from notification_outbox n
        where n.status = 'queued' and n.next_attempt_at <= now()
        order by n.next_attempt_at asc
        limit ${limit}
        for update skip locked
      )
      update notification_outbox n
      set status = 'sent',
          attempts = n.attempts + 1,
          sent_at = now(),
          updated_at = now()
      from claimed
      where n.id = claimed.id
        and n.id = claimed.id
      returning n.*
    `);
    void workerId;
    return extractRows<typeof notificationOutbox.$inferSelect>(result);
  }

  async markNotificationFailed(input: {
    notificationId: string;
    error: string;
    nextAttemptAt: Date;
    dead: boolean;
  }): Promise<void> {
    await this.db
      .update(notificationOutbox)
      .set({
        status: input.dead ? 'dead' : 'queued',
        lastError: input.error,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: new Date(),
      })
      .where(eq(notificationOutbox.id, input.notificationId));
  }

  async listNotifications(userId: string, limit = 100) {
    const rows = await this.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, userId))
      .orderBy(desc(notificationOutbox.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      event: row.event,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      status: row.status,
      attempts: row.attempts,
      sentAt: row.sentAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }));
  }

  // -------------------------------------------------------------------------
  // billing
  // -------------------------------------------------------------------------

  async listPlans() {
    return this.db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.priceCents));
  }

  async upsertPlan(input: {
    code: string;
    name: string;
    priceCents: number;
    interval: 'month' | 'quarter' | 'semiannual' | 'year';
    maxAccounts: number | null;
    features: string[];
    active?: boolean;
  }): Promise<void> {
    await this.db
      .insert(plans)
      .values({
        code: input.code,
        name: input.name,
        priceCents: input.priceCents,
        interval: input.interval,
        maxAccounts: input.maxAccounts,
        features: input.features,
        active: input.active ?? true,
      })
      .onConflictDoUpdate({
        target: plans.code,
        set: {
          name: input.name,
          priceCents: input.priceCents,
          interval: input.interval,
          maxAccounts: input.maxAccounts,
          features: input.features,
          active: input.active ?? true,
        },
      });
  }

  async getSubscription(userId: string) {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ['active', 'trialing', 'past_due'])))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async upsertSubscription(input: {
    userId: string;
    planCode: string;
    status: 'active' | 'trialing' | 'past_due' | 'cancelled';
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    providerRef?: string | null;
  }): Promise<void> {
    const existing = await this.getSubscription(input.userId);
    if (existing) {
      await this.db
        .update(subscriptions)
        .set({
          planCode: input.planCode,
          status: input.status,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
          providerRef: input.providerRef ?? null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, existing.id));
      return;
    }
    await this.db.insert(subscriptions).values({
      id: id('subscription'),
      userId: input.userId,
      planCode: input.planCode,
      status: input.status,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      providerRef: input.providerRef ?? null,
    });
  }

  async countAccounts(userId: string): Promise<number> {
    const result = await this.db.execute(sql`
      select count(*)::int as count from trading_accounts where user_id = ${userId} and deleted_at is null
    `);
    return extractRows<{ count: number }>(result)[0]?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // account sharing
  // -------------------------------------------------------------------------

  async createShare(input: {
    accountId: string;
    ownerUserId: string;
    granteeUserId: string;
    role: AccountShareRole;
    permissions: AccountShareRecord['permissions'];
  }): Promise<void> {
    await this.db
      .insert(accountShares)
      .values({
        id: id('share'),
        accountId: input.accountId,
        ownerUserId: input.ownerUserId,
        granteeUserId: input.granteeUserId,
        role: input.role,
        permissions: input.permissions,
      })
      .onConflictDoUpdate({
        target: [accountShares.accountId, accountShares.granteeUserId],
        set: { role: input.role, permissions: input.permissions, status: 'active', revokedAt: null, updatedAt: new Date() },
      });
  }

  async listShares(accountId: string) {
    const rows = await this.db
      .select()
      .from(accountShares)
      .where(and(eq(accountShares.accountId, accountId), eq(accountShares.status, 'active')))
      .orderBy(asc(accountShares.createdAt));
    return rows.map(toShare);
  }

  async listSharedWithMe(userId: string) {
    const rows = await this.db
      .select({ share: accountShares, ownerEmail: sql<string>`u.email` })
      .from(accountShares)
      .innerJoin(sql`users u`, sql`u.id = ${accountShares.ownerUserId}`)
      .where(and(eq(accountShares.granteeUserId, userId), eq(accountShares.status, 'active')));
    return rows.map((row) => ({ ...toShare(row.share), ownerEmail: row.ownerEmail }));
  }

  async revokeShare(ownerUserId: string, shareId: string): Promise<boolean> {
    const rows = await this.db
      .update(accountShares)
      .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(accountShares.id, shareId), eq(accountShares.ownerUserId, ownerUserId)))
      .returning({ id: accountShares.id });
    return rows.length > 0;
  }

  async findShare(accountId: string, granteeUserId: string) {
    const [row] = await this.db
      .select()
      .from(accountShares)
      .where(
        and(
          eq(accountShares.accountId, accountId),
          eq(accountShares.granteeUserId, granteeUserId),
          eq(accountShares.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // audit log
  // -------------------------------------------------------------------------

  async audit(input: {
    userId?: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    meta?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: id('audit'),
      userId: input.userId ?? null,
      action: input.action as never,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      meta: input.meta ?? {},
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  async listAudit(userId: string, limit = 100) {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  // -------------------------------------------------------------------------
  // jobs
  // -------------------------------------------------------------------------

  /** Enqueues a job; `dedupeKey` makes periodic jobs singleton. */
  async enqueueJob(input: {
    kind: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    dedupeKey?: string | null;
    maxAttempts?: number;
    replaceDedupe?: boolean;
  }): Promise<JobRecord | null> {
    const inserted = await this.db
      .insert(jobs)
      .values({
        id: id('job'),
        kind: input.kind,
        payload: input.payload ?? {},
        runAt: input.runAt ?? new Date(),
        dedupeKey: input.dedupeKey ?? null,
        maxAttempts: input.maxAttempts ?? 5,
      })
      .onConflictDoUpdate({
        target: jobs.dedupeKey,
        set: {
          ...(input.replaceDedupe !== false
            ? { status: 'queued' as const, runAt: input.runAt ?? new Date(), attempts: 0, lastError: null }
            : {}),
        },
      })
      .returning();
    return inserted[0] ? toJob(inserted[0]) : null;
  }

  async claimJobs(workerId: string, limit: number): Promise<JobRecord[]> {
    const result = await this.db.execute(sql`
      with claimed as (
        select j.id from jobs j
        where j.status = 'queued' and j.run_at <= now()
        order by j.run_at asc
        limit ${limit}
        for update skip locked
      )
      update jobs j
      set status = 'running', locked_by = ${workerId}, locked_at = now(), started_at = now(),
          attempts = j.attempts + 1, updated_at = now()
      from claimed
      where j.id = claimed.id
      returning j.*
    `);
    return extractRows<typeof jobs.$inferSelect>(result).map(toJob);
  }

  async completeJob(jobId: string, input: { failed?: boolean; error?: string | null; nextRunAt?: Date | null }): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: input.nextRunAt ? 'queued' : input.failed ? 'failed' : 'done',
        finishedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lastError: input.error ?? null,
        ...(input.nextRunAt ? { runAt: input.nextRunAt, attempts: 0 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  }

  async requeueJob(jobId: string, runAt: Date, error: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'queued', runAt, lockedBy: null, lockedAt: null, lastError: error, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }

  async reapStuckJobs(olderThanMs: number): Promise<number> {
    const result = await this.db.execute(sql`
      update jobs
      set status = case when attempts >= max_attempts then 'failed'::job_status else 'queued'::job_status end,
          locked_by = null,
          locked_at = null,
          run_at = now(),
          last_error = coalesce(last_error, 'job lock expired'),
          updated_at = now()
      where status = 'running'
        and locked_at < now() - (${olderThanMs}::int * interval '1 millisecond')
      returning id
    `);
    return extractRows<{ id: string }>(result).length;
  }

  /** Housekeeping counters for the admin/diagnostics view. */
  async diagnostics() {
    const result = await this.db.execute(sql`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from trading_accounts where deleted_at is null) as accounts,
        (select count(*)::int from copiers where deleted_at is null) as copiers,
        (select count(*)::int from copy_commands where status = 'queued') as queued_commands,
        (select count(*)::int from copy_commands where status = 'dead') as dead_commands,
        (select count(*)::int from notification_outbox where status = 'queued') as queued_notifications,
        (select count(*)::int from jobs where status = 'failed') as failed_jobs,
        (select count(*)::int from trade_links where state in ('open','partial')) as open_links,
        (select count(*)::int from bridge_agents where status = 'connected') as connected_agents
    `);
    return extractRows<Record<string, number>>(result)[0] ?? {};
  }

  async countLogsSince(since: Date): Promise<number> {
    const result = await this.db.execute(sql`
      select count(*)::int as count from execution_logs where created_at >= ${since}
    `);
    return extractRows<{ count: number }>(result)[0]?.count ?? 0;
  }

  async pruneNotifications(olderThan: Date): Promise<number> {
    const rows = await this.db
      .delete(notificationOutbox)
      .where(and(lte(notificationOutbox.createdAt, olderThan), inArray(notificationOutbox.status, ['sent', 'dead'])))
      .returning({ id: notificationOutbox.id });
    return rows.length;
  }

  async pruneJobs(olderThan: Date): Promise<number> {
    const rows = await this.db
      .delete(jobs)
      .where(and(lte(jobs.runAt, olderThan), inArray(jobs.status, ['done', 'failed'])))
      .returning({ id: jobs.id });
    return rows.length;
  }

  async pruneAudit(olderThan: Date): Promise<number> {
    const rows = await this.db.delete(auditLogs).where(lte(auditLogs.createdAt, olderThan)).returning({ id: auditLogs.id });
    return rows.length;
  }

  async countActiveAccountsForPlan(userId: string): Promise<number> {
    const result = await this.db.execute(sql`
      select count(*)::int as count from trading_accounts where user_id = ${userId} and deleted_at is null
    `);
    return extractRows<{ count: number }>(result)[0]?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// mappers
// ---------------------------------------------------------------------------

function toEquityProtection(row: typeof equityProtections.$inferSelect): EquityProtectionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    enabled: row.enabled,
    resetTime: row.resetTime,
    resetTimezone: row.resetTimezone,
    maxDrawdownPercent: toNumOrNull(row.maxDrawdownPercent),
    maxDrawdownValue: toNumOrNull(row.maxDrawdownValue),
    absoluteMinEquity: toNumOrNull(row.absoluteMinEquity),
    maxProfitPercent: toNumOrNull(row.maxProfitPercent),
    maxProfitValue: toNumOrNull(row.maxProfitValue),
    absoluteMaxEquity: toNumOrNull(row.absoluteMaxEquity),
    disableCopier: row.disableCopier,
    closeCopiedTrades: row.closeCopiedTrades,
    closeAllTrades: row.closeAllTrades,
    notify: row.notify,
    lastTriggeredAt: row.lastTriggeredAt,
    lastTriggeredRule: row.lastTriggeredRule,
  };
}

function toChannel(row: typeof notificationChannels.$inferSelect): NotificationChannelRecord {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    enabled: row.enabled,
    config: (row.config ?? {}) as Record<string, unknown>,
    hasSecret: Boolean(row.secretsEncrypted),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toShare(row: typeof accountShares.$inferSelect): AccountShareRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    ownerUserId: row.ownerUserId,
    granteeUserId: row.granteeUserId,
    role: row.role,
    status: row.status,
    permissions: row.permissions,
    createdAt: row.createdAt,
  };
}

function toJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload ?? {},
    status: row.status,
    runAt: row.runAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lockedBy: row.lockedBy,
  };
}
