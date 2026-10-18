import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '@trade-copier/db';
import type { AgentHub } from './agents.js';
import type { UiHub } from '../realtime/hub.js';
import type { ConnectorRegistry } from './connectors.js';

/**
 * Slave-side reconciliation.
 *
 * A bridge agent only knows what the terminal currently shows. When the agent
 * reconnects (or periodically, for long-lived sessions) the engine compares its
 * own trade links against the live positions and closes links whose slave
 * position no longer exists — the case where a user closed a copied trade by
 * hand in the terminal.
 *
 * Re-opening positions that exist on the master but are missing on the slave
 * (`reopenMissing`) is documented as an unknown in the reference product, so it
 * ships **off** and must be opted into per follower (FEATURES.md U7).
 */
export interface ReconcilerDeps {
  readonly repos: Repositories;
  readonly hub: AgentHub;
  readonly ui: UiHub;
  readonly registry: ConnectorRegistry;
  readonly log: FastifyBaseLogger;
  readonly now?: (() => Date) | undefined;
}

export interface ReconcileReport {
  readonly checkedAccounts: number;
  readonly closedOrphans: number;
  readonly reopenedMissing: number;
  readonly skipped: number;
}

export class Reconciler {
  private readonly now: () => Date;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Reconciles every account that currently has a live agent session. */
  async tick(): Promise<ReconcileReport> {
    const report = { checkedAccounts: 0, closedOrphans: 0, reopenedMissing: 0, skipped: 0 };
    const pairs = await this.deps.repos.copiers.listActiveFollowerPairs();
    const byAccount = new Map<string, Array<{ copierId: string; followerId: string; copierUserId: string }>>();
    for (const pair of pairs) {
      const list = byAccount.get(pair.accountId);
      const entry = { copierId: pair.copierId, followerId: pair.followerId, copierUserId: pair.copierUserId };
      if (list) list.push(entry);
      else byAccount.set(pair.accountId, [entry]);
    }

    for (const [accountId, followers] of byAccount) {
      const cache = this.deps.hub.cacheFor(accountId);
      if (!cache) continue;
      report.checkedAccounts += 1;
      const liveTickets = new Set(cache.positions().map((position) => position.ticket));

      for (const follower of followers) {
        const settings = await this.deps.repos.copiers.findFollower(follower.followerId);
        if (!settings) continue;
        const policy = settings.settings.reconnectPolicy;
        if (!policy?.enabled) {
          report.skipped += 1;
          continue;
        }

        const links = await this.deps.repos.engine.listOpenLinksByAccount(accountId);
        const ownLinks = links.filter((link) => link.followerId === follower.followerId);

        for (const link of ownLinks) {
          if (!link.slaveTicket || liveTickets.has(link.slaveTicket)) continue;
          if (!policy.closeOrphans) {
            report.skipped += 1;
            continue;
          }
          await this.deps.repos.engine.updateLinkState(link.id, {
            state: 'closed',
            closedAt: this.now(),
            errorCode: 'RECONNECT_MISMATCH',
            errorMessage: 'Slave position disappeared while the master position is still open',
          });
          await this.deps.repos.engine.log({
            copierId: follower.copierId,
            followerId: follower.followerId,
            accountId,
            level: 'warn',
            code: 'RECONNECT_MISMATCH',
            message: `Slave ticket ${link.slaveTicket} is no longer open at the broker; link closed`,
            context: { slaveTicket: link.slaveTicket, masterSymbol: link.masterSymbol, masterVolume: link.masterVolume },
          });
          report.closedOrphans += 1;
        }

        if (policy.reopenMissing) {
          report.reopenedMissing += await this.reopenMissing(follower.followerId, accountId);
        }
      }

      this.deps.ui.publish(followers[0]?.copierUserId ?? '', 'copiers', {
        type: 'copier.updated',
        copierId: followers[0]?.copierId ?? '',
        status: 'enabled',
        followerStates: followers.map((follower) => ({
          followerId: follower.followerId,
          accountId,
          enabled: true,
          effectiveStatus: 'reconciled',
          blockedReason: null,
        })),
        at: this.now().toISOString(),
      });
    }

    if (report.closedOrphans > 0) this.deps.log.warn(report, 'reconciliation closed orphaned slave positions');
    return report;
  }

  /**
   * Re-opens slave positions for master trades the follower has no live link
   * for. Opt-in only; the volume comes from the follower's own settings, so the
   * rebuilt position matches what the user configured.
   */
  private async reopenMissing(followerId: string, accountId: string): Promise<number> {
    const follower = await this.deps.repos.copiers.findFollower(followerId);
    if (!follower) return 0;
    const connector = await this.deps.registry.for(accountId);
    if (!connector) return 0;

    const masterTrades = await this.deps.repos.engine.listMasterTradesForCopier(follower.copierId);
    let reopened = 0;
    for (const trade of masterTrades) {
      if (trade.state !== 'open') continue;
      const link = await this.deps.repos.engine.findLink(trade.id, followerId);
      if (link && (link.state === 'open' || link.state === 'partial' || link.state === 'pending')) continue;
      const slaveSymbol = link?.slaveSymbol ?? trade.symbol;
      const side = follower.settings.reverseTrade ? (trade.side === 'buy' ? 'sell' : 'buy') : trade.side;
      const result = await connector.placeMarketOrder({
        requestId: `reconcile:${trade.id}:${followerId}`,
        symbol: slaveSymbol,
        side,
        volume: link?.filledVolume ?? trade.volume,
        stopLoss: null,
        takeProfit: null,
        maxSlippagePips: follower.settings.maxSlippagePips,
        magic: link?.magic ?? null,
        comment: 'reconcile',
      });
      if (!result.ok) {
        this.deps.log.warn({ err: result.error, masterTradeId: trade.id }, 'reopen during reconciliation failed');
        continue;
      }
      await this.deps.repos.engine.upsertLink({
        masterTradeId: trade.id,
        followerId,
        copierId: follower.copierId,
        slaveAccountId: accountId,
        masterSymbol: trade.symbol,
        slaveSymbol,
        side,
        masterVolume: trade.volume,
        requestedVolume: result.value.filledVolume,
        state: 'open',
      });
      reopened += 1;
    }
    return reopened;
  }
}
