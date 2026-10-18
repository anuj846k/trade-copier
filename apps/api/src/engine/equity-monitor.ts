import type { FastifyBaseLogger } from 'fastify';
import { DateTime } from 'luxon';
import { evaluateEquityProtection, type EquityProtectionTrigger } from '@trade-copier/domain';
import type { AccountRecord, Repositories } from '@trade-copier/db';
import type { ConnectorRegistry } from './connectors.js';
import type { UiHub } from '../realtime/hub.js';

/**
 * Equity Protection monitor.
 *
 * Two responsibilities, both idempotent:
 *
 *  1. **Breach detection** — every tick, evaluate each enabled protection
 *     against the account's current balance/equity and execute the configured
 *     actions exactly once per cooldown window.
 *  2. **Daily reference reset** — the drawdown reference is the balance at the
 *     account's configured local reset time (`resetTime`/`resetTimezone`), so
 *     "3% daily drawdown" means today, not since the account was created.
 */
export interface EquityMonitorDeps {
  readonly repos: Repositories;
  readonly ui: UiHub;
  readonly registry: ConnectorRegistry;
  readonly log: FastifyBaseLogger;
  /** Minimum time between two activations for the same account. */
  readonly cooldownMs?: number;
  readonly now?: (() => Date) | undefined;
}

export class EquityMonitor {
  private readonly activations = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: EquityMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async tick(): Promise<number> {
    const protections = await this.deps.repos.platform.listEnabledEquityProtections();
    let fired = 0;
    for (const protection of protections) {
      const account = await this.deps.repos.accounts.findById(protection.accountId);
      if (!account || account.deletedAt || !account.enabled) continue;

      const balance = account.balance ?? account.referenceBalance ?? 0;
      const equity = account.equity ?? balance;
      const evaluation = evaluateEquityProtection({
        config: protection,
        balance,
        equity,
        referenceBalance: account.referenceBalance ?? balance,
      });
      if (!evaluation.triggered) continue;

      const last = this.activations.get(account.id) ?? 0;
      if (this.now().getTime() - last < (this.deps.cooldownMs ?? 60_000)) continue;
      this.activations.set(account.id, this.now().getTime());
      await this.fire(account, evaluation);
      fired += 1;
    }
    return fired;
  }

  private async fire(
    account: AccountRecord,
    evaluation: Extract<EquityProtectionTrigger, { triggered: true }>,
  ): Promise<void> {
    const executed: string[] = [];
    const connector = await this.deps.registry.for(account.id);

    // Capital first: close what we can, then stop copying, then tell the user.
    if (evaluation.actions.includes('close_all_trades') && connector) {
      const closed = await connector.closeAll({ reason: 'equity_protection', magic: null });
      executed.push(`close_all_trades:${closed.ok ? closed.value.closed : 0}`);
      if (!closed.ok) {
        this.deps.log.warn({ accountId: account.id, error: closed.error }, 'equity protection close_all failed');
      }
    } else if (evaluation.actions.includes('close_copied_trades') && connector) {
      const links = await this.deps.repos.engine.listOpenLinksByAccount(account.id);
      const tickets = links.map((link) => link.slaveTicket).filter((ticket): ticket is string => Boolean(ticket));
      const closed = await connector.closeAll({ reason: 'equity_protection', magic: null, tickets });
      executed.push(`close_copied_trades:${closed.ok ? closed.value.closed : 0}`);
      if (!closed.ok) {
        this.deps.log.warn({ accountId: account.id, error: closed.error }, 'equity protection close_copied_trades failed');
      }
    }

    if (evaluation.actions.includes('disable_copier')) {
      const pairs = await this.deps.repos.copiers.listByFollowerAccount(account.id);
      for (const { followerId } of pairs) {
        await this.deps.repos.copiers.updateFollower(followerId, { enabled: false });
      }
      executed.push(`disable_copier:${pairs.length}`);
    }

    if (evaluation.actions.includes('notify')) {
      const subscribers = await this.deps.repos.platform.resolveSubscribers('equity_protection_triggered', {
        userId: account.userId,
        accountId: account.id,
      });
      for (const { channel } of subscribers) {
        await this.deps.repos.platform.enqueueNotification({
          userId: account.userId,
          channelId: channel.id,
          event: 'equity_protection_triggered',
          payload: {
            accountId: account.id,
            accountLabel: account.label,
            rule: evaluation.rule,
            threshold: evaluation.threshold,
            observed: evaluation.observed,
            message: evaluation.message,
            actions: executed,
          },
          dedupeKey: `equity_protection:${account.id}:${evaluation.rule}:${this.now().toISOString().slice(0, 16)}:${channel.id}`,
        });
      }
      executed.push('notify');
    }

    await this.deps.repos.platform.recordEquityProtectionEvent({
      accountId: account.id,
      userId: account.userId,
      kind: 'breach',
      rule: evaluation.rule,
      threshold: evaluation.threshold,
      observed: evaluation.observed,
      actions: executed,
      snapshot: {
        balance: account.balance,
        equity: account.equity,
        referenceBalance: account.referenceBalance,
        message: evaluation.message,
        configuredActions: evaluation.actions,
      },
    });

    await this.deps.repos.engine.log({
      userId: account.userId,
      accountId: account.id,
      level: 'warn',
      code: 'EQUITY_PROTECTION',
      message: evaluation.message,
      context: { rule: evaluation.rule, threshold: evaluation.threshold, observed: evaluation.observed, actions: executed },
    });

    this.deps.ui.publish(account.userId, 'equity_protection', {
      type: 'equity_protection.triggered',
      accountId: account.id,
      reason: evaluation.rule,
      actions: executed,
      at: this.now().toISOString(),
    });

    this.deps.log.warn(
      { accountId: account.id, rule: evaluation.rule, observed: evaluation.observed, threshold: evaluation.threshold },
      'equity protection triggered',
    );
  }

  /**
   * Rolls each account's drawdown reference forward once per local day.
   *
   * Runs on a short interval and is idempotent: the daily-reset table has a
   * unique (account, day) key, so only the first pass of the day writes.
   */
  async dailyReset(): Promise<number> {
    const now = this.now();
    const protections = await this.deps.repos.platform.listEnabledEquityProtections();
    let resets = 0;

    for (const protection of protections) {
      const account = await this.deps.repos.accounts.findById(protection.accountId);
      if (!account || account.deletedAt) continue;
      const zone = protection.resetTimezone || 'UTC';
      const local = DateTime.fromJSDate(now, { zone });
      const [hourRaw = '0', minuteRaw = '0'] = (protection.resetTime || '00:00').split(':');
      const resetToday = local.set({
        hour: Number(hourRaw),
        minute: Number(minuteRaw),
        second: 0,
        millisecond: 0,
      });
      // Only reset once the account's local reset time has passed today.
      if (local < resetToday) continue;

      const day = local.toFormat('yyyy-MM-dd');
      const pending = await this.deps.repos.platform.accountsNeedingDailyReset(day);
      if (!pending.includes(account.id)) continue;

      const balance = account.balance ?? account.referenceBalance ?? 0;
      const equity = account.equity ?? balance;
      await this.deps.repos.accounts.setDailyReference(account.id, balance, now);
      const { created } = await this.deps.repos.platform.recordDailyReset({ accountId: account.id, balance, equity, at: now });
      if (!created) continue;
      resets += 1;
      await this.deps.repos.platform.recordEquityProtectionEvent({
        accountId: account.id,
        userId: account.userId,
        kind: 'reset',
        rule: 'max_drawdown_percent',
        threshold: balance,
        observed: balance,
        actions: [],
        snapshot: { day, timezone: zone, resetTime: protection.resetTime },
      });
      this.deps.log.info({ accountId: account.id, day, balance }, 'daily equity reference reset');
    }
    return resets;
  }
}
