import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  AccountSnapshot,
  ClosedTrade,
  CommandKind,
  CommandParams,
  CopierErrorCode,
  CopierLogLevel,
  Position,
  TradeSide,
} from '@trade-copier/contracts';
import type { LinkState, MasterTradeState } from '../schema/enums.js';
import type { Database } from '../client.js';
import { id } from '../ids.js';
import {
  accountClosedTrades,
  accountSnapshots,
  accountSymbols,
  copierFollowers,
  copyCommands,
  executionLogs,
  masterTrades,
  tradeLinks,
} from '../schema/tables.js';
import { extractRows } from './accounts.js';
import { fromNum, fromNumRequired, toNum, toNumOrNull, toMinute, toTimestamp, toTimestampOrNull } from '../values.js';

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface MasterTradeRecord {
  id: string;
  copierId: string;
  accountId: string;
  ticket: string;
  symbol: string;
  side: TradeSide;
  kind: 'market' | 'pending';
  pendingType: string | null;
  state: MasterTradeState;
  volume: number;
  closedVolume: number;
  openPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiry: Date | null;
  magic: number;
  comment: string;
  openedAt: Date;
  closedAt: Date | null;
  closePrice: number | null;
  raw: Record<string, unknown>;
}

export interface TradeLinkRecord {
  id: string;
  masterTradeId: string;
  followerId: string;
  copierId: string;
  slaveAccountId: string;
  masterSymbol: string;
  slaveSymbol: string | null;
  side: TradeSide;
  masterVolume: number;
  requestedVolume: number | null;
  filledVolume: number | null;
  closedVolume: number;
  filledPrice: number | null;
  slaveTicket: string | null;
  magic: number | null;
  state: LinkState;
  seq: number;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  realizedProfit: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface CommandRecord {
  id: string;
  requestId: string;
  copierId: string | null;
  followerId: string | null;
  masterTradeId: string | null;
  linkId: string | null;
  accountId: string;
  kind: CommandKind;
  params: CommandParams;
  seq: number;
  status: 'queued' | 'dispatched' | 'acked' | 'failed' | 'dead' | 'cancelled';
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  retryDeadlineAt: Date | null;
  lockedBy: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  trace: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: Date;
}

export interface LogInput {
  userId?: string | null;
  copierId?: string | null;
  followerId?: string | null;
  accountId?: string | null;
  masterTradeId?: string | null;
  requestId?: string | null;
  level: CopierLogLevel;
  code: CopierErrorCode | string;
  message: string;
  context?: Record<string, unknown> | null;
  at?: Date;
}

export class EngineRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // master trades
  // -------------------------------------------------------------------------

  /**
   * Inserts or updates the master trade snapshot and returns the row *before*
   * the update, so the caller can diff state transitions.
   */
  async upsertMasterTrade(input: {
    copierId: string;
    accountId: string;
    position: Position;
  }): Promise<{ previous: MasterTradeRecord | null; current: MasterTradeRecord }> {
    const position = input.position;
    const state: MasterTradeState =
      position.kind === 'pending' ? 'open' : position.volume > 0 ? 'open' : 'closed';

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(masterTrades)
        .where(and(eq(masterTrades.copierId, input.copierId), eq(masterTrades.ticket, position.ticket)))
        .for('update')
        .limit(1);

      const values = {
        symbol: position.symbol,
        side: position.side,
        kind: position.kind,
        pendingType: position.pendingType ?? null,
        state,
        volume: fromNumRequired(position.volume),
        closedVolume: fromNumRequired(position.closedVolume ?? 0),
        openPrice: fromNumRequired(position.openPrice),
        currentPrice: fromNum(position.currentPrice ?? null),
        stopLoss: fromNum(position.stopLoss ?? null),
        takeProfit: fromNum(position.takeProfit ?? null),
        expiry: position.expiry ? new Date(position.expiry) : null,
        magic: position.magic ?? 0,
        comment: position.comment ?? '',
        openedAt: new Date(position.openedAt),
        raw: position as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      };

      if (existing) {
        const [updated] = await tx
          .update(masterTrades)
          .set(values)
          .where(eq(masterTrades.id, existing.id))
          .returning();
        return { previous: toMasterTrade(existing), current: toMasterTrade(updated!) };
      }

      const [inserted] = await tx
        .insert(masterTrades)
        .values({
          id: id('masterTrade'),
          copierId: input.copierId,
          accountId: input.accountId,
          ticket: position.ticket,
          ...values,
        })
        .returning();
      return { previous: null, current: toMasterTrade(inserted!) };
    });
  }

  async markMasterTradeClosed(input: {
    copierId: string;
    ticket: string;
    closePrice?: number | null;
    closedAt?: Date;
    realizedProfit?: number | null;
  }): Promise<MasterTradeRecord | null> {
    const [row] = await this.db
      .update(masterTrades)
      .set({
        state: 'closed',
        volume: '0',
        currentPrice: fromNum(input.closePrice ?? null),
        closePrice: fromNum(input.closePrice ?? null),
        closedAt: input.closedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(masterTrades.copierId, input.copierId), eq(masterTrades.ticket, input.ticket)))
      .returning();
    return row ? toMasterTrade(row) : null;
  }

  async listOpenMasterTrades(copierId: string): Promise<MasterTradeRecord[]> {
    const rows = await this.db
      .select()
      .from(masterTrades)
      .where(and(eq(masterTrades.copierId, copierId), inArray(masterTrades.state, ['open', 'partial'])));
    return rows.map(toMasterTrade);
  }

  async findMasterTrade(copierId: string, ticket: string): Promise<MasterTradeRecord | null> {
    const [row] = await this.db
      .select()
      .from(masterTrades)
      .where(and(eq(masterTrades.copierId, copierId), eq(masterTrades.ticket, ticket)))
      .limit(1);
    return row ? toMasterTrade(row) : null;
  }

  /** Master trades still open on a follower's stream (closes must still flow). */
  async listMasterTradesForCopier(copierId: string, limit = 500): Promise<MasterTradeRecord[]> {
    const rows = await this.db
      .select()
      .from(masterTrades)
      .where(eq(masterTrades.copierId, copierId))
      .orderBy(desc(masterTrades.openedAt))
      .limit(limit);
    return rows.map(toMasterTrade);
  }

  // -------------------------------------------------------------------------
  // trade links
  // -------------------------------------------------------------------------

  async upsertLink(input: {
    masterTradeId: string;
    followerId: string;
    copierId: string;
    slaveAccountId: string;
    masterSymbol: string;
    slaveSymbol: string | null;
    side: TradeSide;
    masterVolume: number;
    requestedVolume?: number | null;
    state?: LinkState;
    seq?: number;
  }): Promise<TradeLinkRecord> {
    const [row] = await this.db
      .insert(tradeLinks)
      .values({
        id: id('link'),
        masterTradeId: input.masterTradeId,
        followerId: input.followerId,
        copierId: input.copierId,
        slaveAccountId: input.slaveAccountId,
        masterSymbol: input.masterSymbol,
        slaveSymbol: input.slaveSymbol,
        side: input.side,
        masterVolume: fromNumRequired(input.masterVolume),
        requestedVolume: fromNum(input.requestedVolume ?? null),
        state: input.state ?? 'pending',
        seq: input.seq ?? 1,
      })
      .onConflictDoUpdate({
        target: [tradeLinks.masterTradeId, tradeLinks.followerId],
        set: {
          slaveSymbol: input.slaveSymbol,
          requestedVolume: fromNum(input.requestedVolume ?? null),
          seq: input.seq ?? 1,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toLink(row!);
  }

  async findLink(masterTradeId: string, followerId: string): Promise<TradeLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(tradeLinks)
      .where(and(eq(tradeLinks.masterTradeId, masterTradeId), eq(tradeLinks.followerId, followerId)))
      .limit(1);
    return row ? toLink(row) : null;
  }

  async findLinkById(linkId: string): Promise<TradeLinkRecord | null> {
    const [row] = await this.db.select().from(tradeLinks).where(eq(tradeLinks.id, linkId)).limit(1);
    return row ? toLink(row) : null;
  }

  async findLinkBySlaveTicket(slaveAccountId: string, slaveTicket: string): Promise<TradeLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(tradeLinks)
      .where(and(eq(tradeLinks.slaveAccountId, slaveAccountId), eq(tradeLinks.slaveTicket, slaveTicket)))
      .limit(1);
    return row ? toLink(row) : null;
  }

  async listLinksByMasterTrade(masterTradeId: string): Promise<TradeLinkRecord[]> {
    const rows = await this.db.select().from(tradeLinks).where(eq(tradeLinks.masterTradeId, masterTradeId));
    return rows.map(toLink);
  }

  async listLinksForFollower(followerId: string, limit = 200): Promise<TradeLinkRecord[]> {
    const rows = await this.db
      .select()
      .from(tradeLinks)
      .where(eq(tradeLinks.followerId, followerId))
      .orderBy(desc(tradeLinks.createdAt))
      .limit(limit);
    return rows.map(toLink);
  }

  /** Open slave positions on an account (for equity protection / close-all). */
  async listOpenLinksByAccount(accountId: string): Promise<TradeLinkRecord[]> {
    const rows = await this.db
      .select()
      .from(tradeLinks)
      .where(
        and(
          eq(tradeLinks.slaveAccountId, accountId),
          inArray(tradeLinks.state, ['pending', 'open', 'partial']),
        ),
      );
    return rows.map(toLink);
  }

  async updateLinkState(
    linkId: string,
    patch: Partial<{
      state: LinkState;
      slaveTicket: string | null;
      filledVolume: number | null;
      filledPrice: number | null;
      closedVolume: number;
      magic: number | null;
      seq: number;
      errorCode: string | null;
      errorMessage: string | null;
      realizedProfit: number | null;
      openedAt: Date | null;
      closedAt: Date | null;
      attempts: number;
    }>,
  ): Promise<TradeLinkRecord | null> {
    const { filledVolume, filledPrice, closedVolume, realizedProfit, ...rest } = patch;
    const [row] = await this.db
      .update(tradeLinks)
      .set({
        ...rest,
        ...(filledVolume !== undefined ? { filledVolume: fromNum(filledVolume) } : {}),
        ...(filledPrice !== undefined ? { filledPrice: fromNum(filledPrice) } : {}),
        ...(closedVolume !== undefined ? { closedVolume: fromNumRequired(closedVolume) } : {}),
        ...(realizedProfit !== undefined ? { realizedProfit: fromNum(realizedProfit) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tradeLinks.id, linkId))
      .returning();
    return row ? toLink(row) : null;
  }

  async incrementLinkAttempts(linkId: string, error: { code: string; message: string }): Promise<void> {
    await this.db
      .update(tradeLinks)
      .set({
        attempts: sql`${tradeLinks.attempts} + 1`,
        errorCode: error.code,
        errorMessage: error.message,
        updatedAt: new Date(),
      })
      .where(eq(tradeLinks.id, linkId));
  }

  /** Opens the link after a successful fill. */
  async activateLink(input: {
    linkId: string;
    slaveTicket: string;
    filledVolume: number;
    filledPrice: number;
    magic: number | null;
    openedAt?: Date;
  }): Promise<TradeLinkRecord | null> {
    return this.updateLinkState(input.linkId, {
      state: 'open',
      slaveTicket: input.slaveTicket,
      filledVolume: input.filledVolume,
      filledPrice: input.filledPrice,
      magic: input.magic,
      errorCode: null,
      errorMessage: null,
      openedAt: input.openedAt ?? new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // durable command queue
  // -------------------------------------------------------------------------

  /**
   * Enqueues a command. `requestId` makes it idempotent: replaying the same
   * decision (restart, retry, duplicate event) never double-executes.
   */
  async enqueueCommand(input: {
    requestId: string;
    accountId: string;
    kind: CommandKind;
    params: CommandParams;
    copierId?: string | null;
    followerId?: string | null;
    masterTradeId?: string | null;
    linkId?: string | null;
    seq?: number;
    priority?: number;
    maxAttempts?: number;
    retryDeadlineAt?: Date | null;
    nextAttemptAt?: Date;
    trace?: Record<string, unknown>;
    delayMs?: number;
  }): Promise<{ command: CommandRecord; created: boolean }> {
    const nextAttemptAt = input.nextAttemptAt
      ? input.nextAttemptAt
      : new Date(Date.now() + (input.delayMs ?? 0));

    const [inserted] = await this.db
      .insert(copyCommands)
      .values({
        id: id('command'),
        requestId: input.requestId,
        accountId: input.accountId,
        kind: input.kind,
        params: input.params,
        copierId: input.copierId ?? null,
        followerId: input.followerId ?? null,
        masterTradeId: input.masterTradeId ?? null,
        linkId: input.linkId ?? null,
        seq: input.seq ?? 0,
        priority: input.priority ?? 100,
        maxAttempts: input.maxAttempts ?? 24,
        nextAttemptAt,
        retryDeadlineAt: input.retryDeadlineAt ?? null,
        trace: input.trace ?? {},
        status: 'queued',
      })
      .onConflictDoNothing({ target: copyCommands.requestId })
      .returning();

    if (inserted) return { command: toCommand(inserted), created: true };

    const [existing] = await this.db
      .select()
      .from(copyCommands)
      .where(eq(copyCommands.requestId, input.requestId))
      .limit(1);
    return { command: toCommand(existing!), created: false };
  }

  /**
   * Claims up to `limit` due commands for a worker.
   *
   * `FOR UPDATE SKIP LOCKED` lets several worker processes scale horizontally
   * without any coordination service. The `not exists` clause enforces FIFO per
   * link, so a close can never overtake the open it refers to.
   */
  async claimCommands(workerId: string, limit: number): Promise<CommandRecord[]> {
    const result = await this.db.execute(sql`
      with claimed as (
        select c.id
        from copy_commands c
        where c.status = 'queued'
          and c.next_attempt_at <= now()
          and not exists (
            select 1 from copy_commands p
            where p.link_id is not null
              and p.link_id = c.link_id
              and p.status in ('queued', 'dispatched')
              and p.seq < c.seq
          )
        order by c.priority asc, c.next_attempt_at asc, c.created_at asc
        limit ${limit}
        for update skip locked
      )
      update copy_commands c
      set status = 'dispatched',
          locked_by = ${workerId},
          locked_at = now(),
          dispatched_at = now(),
          attempts = c.attempts + 1,
          updated_at = now()
      from claimed
      where c.id = claimed.id
      returning c.*
    `);
    return extractRows<Record<string, unknown>>(result).map(toClaimedCommand);
  }

  /** Returns a claimed command to the queue (agent offline, transient error). */
  async requeueCommand(
    commandId: string,
    input: { nextAttemptAt: Date; errorCode?: string | null; errorMessage?: string | null },
  ): Promise<void> {
    await this.db
      .update(copyCommands)
      .set({
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.errorCode ?? null,
        lastErrorMessage: input.errorMessage ?? null,
        updatedAt: new Date(),
      })
      .where(eq(copyCommands.id, commandId));
  }

  async completeCommand(
    commandId: string,
    input: { status: 'acked' | 'failed' | 'dead' | 'cancelled'; errorCode?: string | null; errorMessage?: string | null; latencyMs?: number | null },
  ): Promise<void> {
    await this.db
      .update(copyCommands)
      .set({
        status: input.status,
        ackedAt: input.status === 'acked' ? new Date() : null,
        lastErrorCode: input.errorCode ?? null,
        lastErrorMessage: input.errorMessage ?? null,
        latencyMs: input.latencyMs ?? null,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(copyCommands.id, commandId));
  }

  /**
   * Reclaims commands that were dispatched but never acknowledged — the worker
   * or the agent died mid-flight. Called by the heartbeat monitor.
   */
  async reapStuckCommands(olderThanMs: number, maxAttemptsExceededStatus: 'queued' | 'dead' = 'queued'): Promise<number> {
    const rows = await this.db.execute(sql`
      update copy_commands
      set status = case when attempts >= max_attempts then 'dead'::command_status else ${maxAttemptsExceededStatus}::command_status end,
          locked_by = null,
          locked_at = null,
          next_attempt_at = now(),
          last_error_code = coalesce(last_error_code, 'BRIDGE_TIMEOUT'),
          last_error_message = coalesce(last_error_message, 'command was not acknowledged in time'),
          updated_at = now()
      where status = 'dispatched'
        and locked_at < now() - (${olderThanMs}::int * interval '1 millisecond')
      returning id
    `);
    return extractRows<{ id: string }>(rows).length;
  }

  /** Commands that must be cancelled because their link died. */
  async cancelQueuedCommandsForLink(linkId: string, reason: string): Promise<number> {
    const rows = await this.db
      .update(copyCommands)
      .set({
        status: 'cancelled',
        lastErrorCode: 'LINK_CLOSED',
        lastErrorMessage: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(copyCommands.linkId, linkId), inArray(copyCommands.status, ['queued', 'dispatched'])))
      .returning({ id: copyCommands.id });
    return rows.length;
  }

  async findCommandByRequestId(requestId: string): Promise<CommandRecord | null> {
    const [row] = await this.db.select().from(copyCommands).where(eq(copyCommands.requestId, requestId)).limit(1);
    return row ? toCommand(row) : null;
  }

  async listCommandsForAccount(
    accountId: string,
    options: { limit?: number; statuses?: CommandRecord['status'][] } = {},
  ): Promise<CommandRecord[]> {
    const rows = await this.db
      .select()
      .from(copyCommands)
      .where(
        and(
          eq(copyCommands.accountId, accountId),
          options.statuses ? inArray(copyCommands.status, options.statuses) : sql`true`,
        ),
      )
      .orderBy(desc(copyCommands.createdAt))
      .limit(options.limit ?? 100);
    return rows.map(toCommand);
  }

  async queueDepth(accountId?: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(copyCommands)
      .where(
        and(
          eq(copyCommands.status, 'queued'),
          accountId ? eq(copyCommands.accountId, accountId) : sql`true`,
        ),
      );
    return row?.count ?? 0;
  }

  /** Oldest queued command age — the number operators care about (p99 lag). */
  async oldestQueuedAgeMs(): Promise<number | null> {
    const [row] = await this.db
      .select({ oldest: sql<Date | null>`min(${copyCommands.createdAt})` })
      .from(copyCommands)
      .where(eq(copyCommands.status, 'queued'));
    if (!row?.oldest) return null;
    return Date.now() - new Date(row.oldest).getTime();
  }

  // -------------------------------------------------------------------------
  // execution logs
  // -------------------------------------------------------------------------

  async log(input: LogInput): Promise<void> {
    await this.db.insert(executionLogs).values({
      id: id('log'),
      userId: input.userId ?? null,
      copierId: input.copierId ?? null,
      followerId: input.followerId ?? null,
      accountId: input.accountId ?? null,
      masterTradeId: input.masterTradeId ?? null,
      requestId: input.requestId ?? null,
      level: input.level,
      code: input.code,
      message: input.message,
      context: input.context ?? null,
      ...(input.at ? { createdAt: input.at } : {}),
    });
  }

  async logMany(inputs: readonly LogInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.insert(executionLogs).values(
      inputs.map((input) => ({
        id: id('log'),
        userId: input.userId ?? null,
        copierId: input.copierId ?? null,
        followerId: input.followerId ?? null,
        accountId: input.accountId ?? null,
        masterTradeId: input.masterTradeId ?? null,
        requestId: input.requestId ?? null,
        level: input.level,
        code: input.code,
        message: input.message,
        context: input.context ?? null,
        ...(input.at ? { createdAt: input.at } : {}),
      })),
    );
  }

  async listLogs(filter: {
    userId: string;
    copierId?: string | undefined;
    followerId?: string | undefined;
    accountId?: string | undefined;
    levels?: CopierLogLevel[] | undefined;
    codes?: string[] | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) {
    const conditions = [eq(executionLogs.userId, filter.userId)];
    if (filter.copierId) conditions.push(eq(executionLogs.copierId, filter.copierId));
    if (filter.followerId) conditions.push(eq(executionLogs.followerId, filter.followerId));
    if (filter.accountId) conditions.push(eq(executionLogs.accountId, filter.accountId));
    if (filter.levels?.length) conditions.push(inArray(executionLogs.level, filter.levels));
    if (filter.codes?.length) conditions.push(inArray(executionLogs.code, filter.codes));
    if (filter.from) conditions.push(gte(executionLogs.createdAt, filter.from));
    if (filter.to) conditions.push(lte(executionLogs.createdAt, filter.to));

    const rows = await this.db
      .select()
      .from(executionLogs)
      .where(and(...conditions))
      .orderBy(desc(executionLogs.createdAt))
      .limit(Math.min(filter.limit ?? 100, 500))
      .offset(filter.offset ?? 0);

    const [total] = await this.db
      .select({ count: count() })
      .from(executionLogs)
      .where(and(...conditions));

    return { rows, total: total?.count ?? 0 };
  }

  /** Retention: deletes logs older than the window (called by the scheduler). */
  async pruneLogs(olderThan: Date): Promise<number> {
    const rows = await this.db
      .delete(executionLogs)
      .where(lte(executionLogs.createdAt, olderThan))
      .returning({ id: executionLogs.id });
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // snapshots + closed trades (written by the snapshot collector)
  // -------------------------------------------------------------------------

  async recordSnapshot(accountId: string, snapshot: AccountSnapshot, openVolume: number, openPositions: number): Promise<void> {
    await this.db
      .insert(accountSnapshots)
      .values({
        id: id('snapshot'),
        accountId,
        balance: fromNumRequired(snapshot.balance),
        equity: fromNumRequired(snapshot.equity),
        margin: fromNum(snapshot.margin),
        freeMargin: fromNum(snapshot.freeMargin),
        openVolume: fromNumRequired(openVolume),
        openPositions,
        takenAt: toMinute(new Date(snapshot.at)),
      })
      .onConflictDoUpdate({
        target: [accountSnapshots.accountId, accountSnapshots.takenAt],
        set: {
          balance: fromNumRequired(snapshot.balance),
          equity: fromNumRequired(snapshot.equity),
          margin: fromNum(snapshot.margin),
          freeMargin: fromNum(snapshot.freeMargin),
          openVolume: fromNumRequired(openVolume),
          openPositions,
        },
      });
  }

  async listSnapshots(accountId: string, from: Date, to: Date, limit = 5000) {
    const rows = await this.db
      .select({
        takenAt: accountSnapshots.takenAt,
        balance: accountSnapshots.balance,
        equity: accountSnapshots.equity,
        margin: accountSnapshots.margin,
        freeMargin: accountSnapshots.freeMargin,
      })
      .from(accountSnapshots)
      .where(and(eq(accountSnapshots.accountId, accountId), gte(accountSnapshots.takenAt, from), lte(accountSnapshots.takenAt, to)))
      .orderBy(asc(accountSnapshots.takenAt))
      .limit(limit);
    return rows.map((row) => ({
      takenAt: row.takenAt,
      balance: toNum(row.balance),
      equity: toNum(row.equity),
      margin: toNumOrNull(row.margin),
      freeMargin: toNumOrNull(row.freeMargin),
    }));
  }

  async recordClosedTrade(accountId: string, trade: ClosedTrade, followerId?: string | null, requestId?: string | null): Promise<void> {
    await this.db
      .insert(accountClosedTrades)
      .values({
        id: id('closedTrade'),
        accountId,
        ticket: trade.ticket,
        symbol: trade.symbol,
        side: trade.side,
        volume: fromNumRequired(trade.volume),
        openPrice: fromNumRequired(trade.openPrice),
        closePrice: fromNumRequired(trade.closePrice),
        stopLoss: fromNum(trade.stopLoss ?? null),
        takeProfit: fromNum(trade.takeProfit ?? null),
        magic: trade.magic ?? 0,
        comment: trade.comment ?? '',
        profit: fromNumRequired(trade.profit),
        swap: fromNumRequired(trade.swap ?? 0),
        commission: fromNumRequired(trade.commission ?? 0),
        followerId: followerId ?? null,
        requestId: requestId ?? null,
        openedAt: new Date(trade.openedAt),
        closedAt: new Date(trade.closedAt),
      })
      .onConflictDoNothing({ target: [accountClosedTrades.accountId, accountClosedTrades.ticket] });
  }

  async listClosedTrades(accountId: string, from: Date, to: Date, limit = 10_000) {
    const rows = await this.db
      .select()
      .from(accountClosedTrades)
      .where(
        and(
          eq(accountClosedTrades.accountId, accountId),
          gte(accountClosedTrades.closedAt, from),
          lte(accountClosedTrades.closedAt, to),
        ),
      )
      .orderBy(asc(accountClosedTrades.closedAt))
      .limit(limit);
    return rows.map((row) => ({
      ticket: row.ticket,
      symbol: row.symbol,
      side: row.side,
      volume: toNum(row.volume),
      openPrice: toNum(row.openPrice),
      closePrice: toNum(row.closePrice),
      stopLoss: toNumOrNull(row.stopLoss),
      takeProfit: toNumOrNull(row.takeProfit),
      magic: row.magic,
      comment: row.comment,
      profit: toNum(row.profit),
      swap: toNum(row.swap),
      commission: toNum(row.commission),
      followerId: row.followerId,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    }));
  }

  /** Realised P/L of copier-placed trades since `from` (Equity Protection). */
  async copiedTradesSince(accountId: string, from: Date, followerIds: readonly string[]) {
    const rows = await this.db
      .select()
      .from(accountClosedTrades)
      .where(
        and(
          eq(accountClosedTrades.accountId, accountId),
          gte(accountClosedTrades.closedAt, from),
          followerIds.length > 0 ? inArray(accountClosedTrades.followerId, [...followerIds]) : sql`${accountClosedTrades.followerId} is not null`,
        ),
      )
      .orderBy(desc(accountClosedTrades.closedAt))
      .limit(1000);
    return rows.map((row) => ({
      ticket: row.ticket,
      symbol: row.symbol,
      side: row.side,
      volume: toNum(row.volume),
      profit: toNum(row.profit),
      swap: toNum(row.swap),
      commission: toNum(row.commission),
      followerId: row.followerId,
      closedAt: row.closedAt,
    }));
  }

  /** Symbol lookup used to enrich analytics (avoid an extra round trip). */
  async symbolNamesForAccount(accountId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ name: accountSymbols.name, canonical: accountSymbols.canonical })
      .from(accountSymbols)
      .where(eq(accountSymbols.accountId, accountId));
    return new Map(rows.map((row) => [row.name, row.canonical]));
  }

  /** Counts links grouped by state for a copier (dashboard summary cards). */
  async linkStateCounts(copierId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ state: tradeLinks.state, count: count() })
      .from(tradeLinks)
      .where(eq(tradeLinks.copierId, copierId))
      .groupBy(tradeLinks.state);
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  /** Removes snapshots older than the retention window. */
  async pruneSnapshots(olderThan: Date): Promise<number> {
    const rows = await this.db.delete(accountSnapshots).where(lte(accountSnapshots.takenAt, olderThan)).returning({ id: accountSnapshots.id });
    return rows.length;
  }

  async deleteOrphanLinks(): Promise<number> {
    const rows = await this.db
      .delete(tradeLinks)
      .where(isNull(tradeLinks.masterTradeId))
      .returning({ id: tradeLinks.id });
    return rows.length;
  }

  /**
   * Deletes everything a copier has produced: links, mirrored master trades,
   * commands, execution logs and the follower-side closed-trade records.
   *
   * For the dev simulator, so a second run starts where the first one did
   * instead of inheriting old links whose slave tickets no longer exist at the
   * (mock) broker. The engine itself never calls this. Children go first so the
   * foreign keys stay satisfied at every step.
   */
  async clearCopierHistory(copierId: string): Promise<{
    links: number;
    trades: number;
    commands: number;
    logs: number;
    closedTrades: number;
  }> {
    const followers = await this.db
      .select({ id: copierFollowers.id })
      .from(copierFollowers)
      .where(eq(copierFollowers.copierId, copierId));
    const followerIds = followers.map((row) => row.id);

    const logs = await this.db.delete(executionLogs).where(eq(executionLogs.copierId, copierId)).returning({ id: executionLogs.id });
    const commands = await this.db.delete(copyCommands).where(eq(copyCommands.copierId, copierId)).returning({ id: copyCommands.id });
    const links = await this.db.delete(tradeLinks).where(eq(tradeLinks.copierId, copierId)).returning({ id: tradeLinks.id });
    const trades = await this.db.delete(masterTrades).where(eq(masterTrades.copierId, copierId)).returning({ id: masterTrades.id });
    const closedTrades =
      followerIds.length > 0
        ? await this.db
            .delete(accountClosedTrades)
            .where(inArray(accountClosedTrades.followerId, followerIds))
            .returning({ id: accountClosedTrades.id })
        : [];

    return {
      links: links.length,
      trades: trades.length,
      commands: commands.length,
      logs: logs.length,
      closedTrades: closedTrades.length,
    };
  }
}

// ---------------------------------------------------------------------------
// mappers
// ---------------------------------------------------------------------------

function toMasterTrade(row: typeof masterTrades.$inferSelect): MasterTradeRecord {
  return {
    id: row.id,
    copierId: row.copierId,
    accountId: row.accountId,
    ticket: row.ticket,
    symbol: row.symbol,
    side: row.side,
    kind: row.kind,
    pendingType: row.pendingType,
    state: row.state,
    volume: toNum(row.volume),
    closedVolume: toNum(row.closedVolume),
    openPrice: toNum(row.openPrice),
    currentPrice: toNumOrNull(row.currentPrice),
    stopLoss: toNumOrNull(row.stopLoss),
    takeProfit: toNumOrNull(row.takeProfit),
    expiry: row.expiry,
    magic: row.magic,
    comment: row.comment,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closePrice: toNumOrNull(row.closePrice),
    raw: row.raw ?? {},
  };
}

function toLink(row: typeof tradeLinks.$inferSelect): TradeLinkRecord {
  return {
    id: row.id,
    masterTradeId: row.masterTradeId,
    followerId: row.followerId,
    copierId: row.copierId,
    slaveAccountId: row.slaveAccountId,
    masterSymbol: row.masterSymbol,
    slaveSymbol: row.slaveSymbol,
    side: row.side,
    masterVolume: toNum(row.masterVolume),
    requestedVolume: toNumOrNull(row.requestedVolume),
    filledVolume: toNumOrNull(row.filledVolume),
    closedVolume: toNum(row.closedVolume),
    filledPrice: toNumOrNull(row.filledPrice),
    slaveTicket: row.slaveTicket,
    magic: row.magic,
    state: row.state,
    seq: row.seq,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    realizedProfit: toNumOrNull(row.realizedProfit),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

/**
 * Maps a `copy_commands` row to its record form.
 *
 * Used by the query-builder paths, which apply the schema's column types.
 */
function toCommand(row: typeof copyCommands.$inferSelect): CommandRecord {
  const source = row;
  return {
    id: source.id,
    requestId: source.requestId,
    copierId: source.copierId,
    followerId: source.followerId,
    masterTradeId: source.masterTradeId,
    linkId: source.linkId,
    accountId: source.accountId,
    kind: source.kind,
    params: source.params,
    seq: source.seq,
    status: source.status,
    priority: source.priority,
    attempts: source.attempts,
    maxAttempts: source.maxAttempts,
    nextAttemptAt: source.nextAttemptAt,
    retryDeadlineAt: source.retryDeadlineAt,
    lockedBy: source.lockedBy,
    lastErrorCode: source.lastErrorCode,
    lastErrorMessage: source.lastErrorMessage,
    trace: (source.trace ?? {}) as Record<string, unknown>,
    latencyMs: source.latencyMs,
    createdAt: source.createdAt,
  };
}

/**
 * Maps the row `claimCommands` returns.
 *
 * The claim is raw SQL — an atomic `UPDATE … FROM (SELECT … FOR UPDATE SKIP
 * LOCKED)` is not expressible in the query builder — and raw results bypass
 * drizzle's column mapping: keys are the *column* names and `timestamptz`
 * arrives as Postgres text rather than a `Date`. This function is the single
 * place that translation happens, which is why the shapes are spelled out.
 */
function toClaimedCommand(row: Record<string, unknown>): CommandRecord {
  const latency = row['latency_ms'];
  return {
    id: String(row['id']),
    requestId: String(row['request_id']),
    copierId: (row['copier_id'] as string | null) ?? null,
    followerId: (row['follower_id'] as string | null) ?? null,
    masterTradeId: (row['master_trade_id'] as string | null) ?? null,
    linkId: (row['link_id'] as string | null) ?? null,
    accountId: String(row['account_id']),
    kind: row['kind'] as CommandRecord['kind'],
    params: row['params'] as CommandRecord['params'],
    seq: toNum(row['seq'] as number),
    status: row['status'] as CommandRecord['status'],
    priority: toNum(row['priority'] as number),
    attempts: toNum(row['attempts'] as number),
    maxAttempts: toNum(row['max_attempts'] as number, 24),
    nextAttemptAt: toTimestamp(row['next_attempt_at']),
    retryDeadlineAt: toTimestampOrNull(row['retry_deadline_at']),
    lockedBy: (row['locked_by'] as string | null) ?? null,
    lastErrorCode: (row['last_error_code'] as string | null) ?? null,
    lastErrorMessage: (row['last_error_message'] as string | null) ?? null,
    trace: (row['trace'] ?? {}) as Record<string, unknown>,
    latencyMs: latency === null || latency === undefined ? null : toNum(latency as number),
    createdAt: toTimestamp(row['created_at']),
  };
}
