import type { FastifyBaseLogger } from 'fastify';
import type { AccountSnapshot } from '@trade-copier/contracts';
import type { Repositories } from '@trade-copier/db';
import type { AgentHub } from './agents.js';

/**
 * Equity/balance snapshot collector.
 *
 * The dashboard's equity chart and the analytics drawdown both read from
 * `account_snapshots`. Writing a tick for every live account on a fixed cadence
 * (rather than one row per price change) keeps the table small enough to query
 * without downsampling at the API layer.
 */
export interface SnapshotCollectorDeps {
  readonly repos: Repositories;
  readonly hub: AgentHub;
  readonly log: FastifyBaseLogger;
  readonly now?: (() => Date) | undefined;
}

export class SnapshotCollector {
  private readonly now: () => Date;

  constructor(private readonly deps: SnapshotCollectorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async tick(): Promise<number> {
    const accounts = await this.deps.repos.accounts.listAllConnected();
    let written = 0;

    for (const account of accounts) {
      const cache = this.deps.hub.cacheFor(account.id);
      const fromCache = cache?.snapshot() ?? null;
      const snapshot: AccountSnapshot | null =
        fromCache ??
        (account.balance !== null && account.equity !== null
          ? {
              accountId: account.id,
              balance: account.balance,
              equity: account.equity,
              margin: account.margin ?? 0,
              freeMargin: account.freeMargin ?? 0,
              marginLevel: account.marginLevel ?? null,
              currency: account.currency,
              leverage: account.leverage,
              at: (account.equityUpdatedAt ?? this.now()).toISOString(),
            }
          : null);
      if (!snapshot) continue;

      const positions = cache?.positions() ?? [];
      const openVolume = positions
        .filter((position) => position.kind === 'market')
        .reduce((sum, position) => sum + position.volume, 0);

      await this.deps.repos.engine.recordSnapshot(
        account.id,
        { ...snapshot, accountId: account.id, at: snapshot.at },
        openVolume,
        positions.length,
      );
      written += 1;
    }

    if (written > 0) this.deps.log.debug({ written }, 'recorded equity snapshots');
    return written;
  }
}
