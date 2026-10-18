import type { FastifyBaseLogger } from 'fastify';
import { MockConnector, type BrokerConnector } from '@trade-copier/broker';
import type { Repositories } from '@trade-copier/db';
import type { AgentHub } from './agents.js';

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
    this.deps.log.info({ accountId, symbols: symbols.length }, 'registered mock broker connector');
    return connector;
  }
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100_000;
  }
  return hash + 1;
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
