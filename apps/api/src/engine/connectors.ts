import type { FastifyBaseLogger } from 'fastify';
import type { Platform } from '@trade-copier/contracts';
import { MockConnector, type BrokerConnector } from '@trade-copier/broker';
import type { Repositories } from '@trade-copier/db';
import { AccountCache, type AgentHub } from './agents.js';

/**
 * Resolves the connector for an account.
 *
 * Production path: the account is served by a bridge agent, and the agent hub
 * owns a `RemoteConnector` for it. Local path: no agent is present (demo mode,
 * integration tests, the copy simulator), so a `MockConnector` is registered
 * explicitly — the engine cannot tell the two apart, which is the point of the
 * broker boundary.
 */
export class ConnectorRegistry {
  private readonly mocks = new Map<string, BrokerConnector>();

  constructor(
    private readonly deps: {
      readonly hub: AgentHub;
      readonly repos: Repositories;
      readonly log: FastifyBaseLogger;
    },
  ) {}

  registerMock(accountId: string, connector: BrokerConnector): void {
    this.mocks.set(accountId, connector);
  }

  unregisterMock(accountId: string): void {
    this.mocks.delete(accountId);
    this.deps.hub.detachLocalCache(accountId);
  }

  /** The connector to use, or null when the account has no live transport. */
  async for(accountId: string): Promise<BrokerConnector | null> {
    const remote = this.deps.hub.connectorFor(accountId);
    if (remote) return remote;
    return this.mocks.get(accountId) ?? null;
  }

  /** True when an agent (not a mock) currently serves the account. */
  isRemote(accountId: string): boolean {
    return this.deps.hub.connectorFor(accountId) !== null;
  }

  /**
   * Creates and registers a mock connector for an account, seeded with the
   * broker symbols and balance already stored for it. Used by the dev
   * simulator and by integration tests (`tools/simulate-copy.ts`).
   */
  async createMock(accountId: string): Promise<BrokerConnector | null> {
    const account = await this.deps.repos.accounts.findById(accountId);
    if (!account) return null;
    const symbols = await this.deps.repos.accounts.listSymbols(accountId);
    const connector = new MockConnector({
      login: account.login,
      server: account.server,
      currency: account.currency,
      balance: account.balance ?? 10_000,
      leverage: account.leverage ?? 100,
      platform: account.platform,
      seed: hashSeed(account.id),
      ticketStart: mockTicketBase(account.id),
      latencyMs: 15,
      symbols: symbols.map((symbol) => ({
        name: symbol.name,
        basePrice: basePriceFor(symbol.canonical),
        digits: symbol.digits,
        spreadPips: 1,
        quoteCurrency: symbol.quoteCurrency,
        minLot: symbol.minLot,
        maxLot: symbol.maxLot,
        lotStep: symbol.lotStep,
        contractSize: symbol.contractSize,
      })),
    });
    this.registerMock(accountId, connector);
    await connector.connect();
    await this.mirrorIntoHub(accountId, account.platform, connector);
    this.deps.log.info({ accountId, symbols: symbols.length }, 'registered mock broker connector');
    return connector;
  }

  /**
   * Mirrors a mock connector into an `AccountCache` on the hub.
   *
   * The engine's decisions are driven by the cache an agent fills with quotes,
   * positions and snapshots. A mock has no agent, so without this the cache
   * would be empty and the pipeline would (correctly) refuse to price anything:
   * every open would be skipped with `STALE_QUOTE`. Bridging the mock's events
   * into the cache keeps the decision path identical to production, and one
   * quote per symbol is seeded up front because a mock only produces a quote
   * when asked — it has no streaming feed.
   */
  private async mirrorIntoHub(accountId: string, platform: Platform, connector: BrokerConnector): Promise<void> {
    const cache = new AccountCache(accountId, platform);
    // `subscribe` is optional on the boundary (a connector may be poll-only).
    connector.subscribe?.((event) => {
      switch (event.kind) {
        case 'positions':
          cache.setPositions(event.positions);
          break;
        case 'snapshot':
          cache.setSnapshot(event.snapshot);
          break;
        case 'quote':
          cache.setQuotes([event.quote]);
          break;
        case 'trade_closed':
          cache.removePosition(event.trade.ticket);
          break;
        default:
          // `log` and `disconnected` carry no cache state.
          break;
      }
    });

    const symbols = await connector.listSymbols();
    if (symbols.ok) cache.setSymbols(symbols.value);

    const snapshot = await connector.getSnapshot();
    if (snapshot.ok) cache.setSnapshot(snapshot.value);

    const positions = await connector.listPositions();
    if (positions.ok) cache.setPositions(positions.value);

    for (const symbol of symbols.ok ? symbols.value : []) {
      // `getQuote` emits a `quote` event, which the subscription stores.
      await connector.getQuote(symbol.name);
    }

    this.deps.hub.attachLocalCache(cache);
  }
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100_000;
  }
  return hash + 1;
}

/**
 * A ticket base that does not repeat between process starts.
 *
 * Links are reconciled by `(account, ticket)`, so two runs that started their
 * mock's counter at the same number would have the second run's closes land on
 * the first run's links (see `MockConnectorOptions.ticketStart`). Prices stay
 * deterministic — only the ticket space moves.
 */
function mockTicketBase(accountId: string): number {
  return 10_000_000_000 + (Date.now() % 1_000_000_000) * 1_000 + (hashSeed(accountId) % 1_000);
}

/** Plausible starting prices so charts and slippage look sane in demo mode. */
function basePriceFor(canonical: string): number {
  const upper = canonical.toUpperCase();
  if (upper.includes('JPY')) return 149.5;
  if (upper.includes('XAU')) return 2_050;
  if (upper.includes('XAG')) return 23.5;
  if (/^(US30|US100|NAS100|US500|SPX500|GER40|UK100)/.test(upper)) return 15_000;
  if (upper.includes('BTC')) return 42_000;
  if (upper.includes('ETH')) return 2_300;
  if (upper.includes('OIL')) return 78;
  if (/^[A-Z]{6}$/.test(upper)) return 1.1;
  return 100;
}
