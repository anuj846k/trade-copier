import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '@trade-copier/db';
import type { Env } from '../config/env.js';
import type { AgentHub } from './agents.js';
import type { UiHub } from '../realtime/hub.js';
import type { RateLimiter } from '../lib/ratelimit.js';
import type { TicketStore } from '../lib/tickets.js';

/**
 * Liveness + housekeeping.
 *
 * Everything here runs on short intervals and is safe to run concurrently in
 * several processes because each action is a single conditional SQL statement
 * (or an in-memory sweep owned by one process).
 */
export interface MaintenanceDeps {
  readonly env: Env;
  readonly repos: Repositories;
  readonly hub: AgentHub;
  readonly ui: UiHub;
  readonly log: FastifyBaseLogger;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly tickets?: TicketStore | undefined;
  readonly now?: (() => Date) | undefined;
}

export class MaintenanceMonitor {
  private readonly notifiedDisconnects = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: MaintenanceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Commands the worker dispatched but never got an answer for. Requeued (or
   * dead-lettered once attempts run out) so a crashed agent cannot strand a
   * close forever.
   */
  async reapCommands(): Promise<number> {
    const staleAfter = Math.max(this.deps.env.COMMAND_TIMEOUT_MS * 4, 15_000);
    const reaped = await this.deps.repos.engine.reapStuckCommands(staleAfter, 'queued');
    if (reaped > 0) this.deps.log.warn({ reaped }, 'requeued commands that were never acknowledged');
    return reaped;
  }

  /**
   * Agents that stopped heartbeating: their sockets are closed, accounts are
   * marked disconnected and the user is told once per disconnect episode (the
   * `account_disconnected` notification is what the reference product sends
   * when a terminal goes away).
   */
  async reapAgents(): Promise<number> {
    const stale = await this.deps.hub.reapSilent(this.deps.env.AGENT_HEARTBEAT_GRACE_MS);
    for (const agentId of stale) {
      this.deps.log.warn({ agentId }, 'bridge agent heartbeat timed out');
    }
    return stale.length;
  }

  /**
   * Accounts whose last heartbeat is older than the grace window, even though
   * no agent socket is attached (e.g. the agent was never connected after a
   * deploy). Marks them disconnected and stops the copy loop from choosing
   * them as a slave.
   */
  async reapStaleAccounts(): Promise<number> {
    const stale = await this.deps.repos.accounts.findStale(this.deps.env.AGENT_HEARTBEAT_GRACE_MS);
    let marked = 0;
    for (const account of stale) {
      if (this.deps.hub.isAccountOnline(account.id)) continue;
      await this.deps.repos.accounts.markStatus(account.id, 'disconnected', {
        code: account.lastErrorCode,
        message: account.lastErrorMessage,
      });
      marked += 1;

      const lastNotified = this.notifiedDisconnects.get(account.id) ?? 0;
      if (this.now().getTime() - lastNotified < 30 * 60_000) continue;
      this.notifiedDisconnects.set(account.id, this.now().getTime());

      const subscribers = await this.deps.repos.platform.resolveSubscribers('account_disconnected', {
        userId: account.userId,
        accountId: account.id,
      });
      for (const { channel } of subscribers) {
        await this.deps.repos.platform.enqueueNotification({
          userId: account.userId,
          channelId: channel.id,
          event: 'account_disconnected',
          payload: { accountId: account.id, label: account.label, lastHeartbeatAt: account.lastHeartbeatAt?.toISOString() ?? null },
          dedupeKey: `account_disconnected:${account.id}:${this.now().toISOString().slice(0, 13)}:${channel.id}`,
        });
      }

      this.deps.ui.publish(account.userId, 'accounts', {
        type: 'account.status',
        accountId: account.id,
        status: 'disconnected',
        balance: account.balance,
        equity: account.equity,
        freeMargin: account.freeMargin,
        lastErrorCode: account.lastErrorCode,
        at: this.now().toISOString(),
      });
    }
    if (marked > 0) this.deps.log.warn({ marked }, 'marked stale accounts disconnected');
    return marked;
  }

  /** Drops idle dashboard sockets, expired tickets, stale rate-limit buckets. */
  reapEphemeral(): number {
    const reaped = this.deps.ui.reap(10 * 60_000);
    this.deps.tickets?.prune();
    this.deps.rateLimiter?.prune();
    return reaped;
  }

  /** Deletes rows nobody needs to keep: logs, snapshots, notifications, audit. */
  async prune(retentionDays = 30): Promise<{ logs: number; snapshots: number; notifications: number; audit: number }> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * 60 * 60_000);
    const [logs, snapshots, notifications, audit] = await Promise.all([
      this.deps.repos.engine.pruneLogs(cutoff),
      this.deps.repos.engine.pruneSnapshots(cutoff),
      this.deps.repos.platform.pruneNotifications(cutoff),
      this.deps.repos.platform.pruneAudit(cutoff),
    ]);
    const pruned = { logs, snapshots, notifications, audit };
    this.deps.log.info(pruned, 'pruned retention-limited tables');
    return pruned;
  }

  /** Reclaims jobs that were claimed by a worker that died mid-run. */
  async reapJobs(): Promise<number> {
    const reaped = await this.deps.repos.platform.reapStuckJobs(30 * 60_000);
    if (reaped > 0) this.deps.log.warn({ reaped }, 'requeued jobs stuck in running state');
    return reaped;
  }
}
