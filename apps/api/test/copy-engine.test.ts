import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Position } from '@trade-copier/contracts';
import { followerSettingsSchema, positionSchema } from '@trade-copier/contracts';
import { hasTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/database.js';
import { silentLogger } from './helpers/logger.js';
import { testEnv } from './helpers/env.js';
import { createEngine, type CopyEngine } from '../src/engine/worker.js';
import { UiHub } from '../src/realtime/hub.js';
import type { Env } from '../src/config/env.js';

/**
 * The copy path, end to end, against a real PostgreSQL database.
 *
 * What is real here: the pipeline's decisions, the durable command outbox, the
 * dispatcher's claim/execute/ack cycle, the repositories and the SQL. What is
 * mocked: the *broker* — `ConnectorRegistry.createMock` stands in for a bridge
 * agent, so no terminal is needed.
 *
 * The fixture uses a crypto instrument on purpose. FX and metals are closed at
 * weekends and during the 21:00–22:00 UTC rollover break, which would make this
 * suite fail on a Saturday or for one hour a day; crypto is 24/7, so the
 * assertions are about the copier and not about the calendar. Market-hours
 * behaviour has its own deterministic tests in `packages/domain`.
 *
 * Skipped entirely when `TEST_DATABASE_URL` is unset (see helpers/database.ts),
 * so `pnpm test` still works on a machine without Postgres.
 */

const describeWithDatabase = hasTestDatabase() ? describe : describe.skip;

/** Master lots → follower lots must be 1:1 here, so sizing bugs are visible. */
const FIXED_LOT = 0.37;
const MASTER_SYMBOL = 'BTCUSD';
const SLAVE_SYMBOL = 'BTCUSD.raw';

interface Fixture {
  readonly db: TestDatabase;
  readonly env: Env;
  readonly engine: CopyEngine;
  readonly userId: string;
  readonly masterAccountId: string;
  readonly slaveAccountId: string;
  readonly copierId: string;
  readonly followerId: string;
  readonly filteredCopierId: string;
  readonly filteredFollowerId: string;
  readonly filteredSlaveAccountId: string;
}

describeWithDatabase('copy engine (integration)', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    const db = await resetTestDatabase();
    const { repos } = db;
    const env = testEnv({ databaseUrl: process.env['TEST_DATABASE_URL'] });

    const user = await repos.auth.createUser({
      email: `engine-${Date.now()}@example.test`,
      passwordHash: 'not-used',
      firstName: 'Engine',
      lastName: 'Test',
      timezone: 'UTC',
    });

    const master = await repos.accounts.create({
      userId: user.id,
      label: 'Master (mock)',
      platform: 'mt5',
      login: '7000001',
      server: 'Mock-Server',
      brokerName: 'Mock',
      kind: 'demo',
      currency: 'USD',
      leverage: 100,
      role: 'both',
    });
    const slave = await repos.accounts.create({
      userId: user.id,
      label: 'Follower (mock)',
      platform: 'mt5',
      login: '7000002',
      server: 'Mock-Server',
      brokerName: 'Mock',
      kind: 'demo',
      currency: 'USD',
      leverage: 500,
      role: 'slave',
    });
    const filteredSlave = await repos.accounts.create({
      userId: user.id,
      label: 'Follower with a side filter',
      platform: 'mt5',
      login: '7000003',
      server: 'Mock-Server',
      brokerName: 'Mock',
      kind: 'demo',
      currency: 'USD',
      leverage: 500,
      role: 'slave',
    });

    const masterSymbols = await repos.accounts.replaceSymbols(master.id, [crypto('BTCUSD')]);
    const slaveSymbols = await repos.accounts.replaceSymbols(slave.id, [crypto('BTCUSD.raw')]);
    await repos.accounts.replaceSymbols(filteredSlave.id, [crypto('BTCUSD.raw')]);
    expect(masterSymbols).toBe(1);
    expect(slaveSymbols).toBe(1);

    // Balances matter to BALANCE_MULTIPLIER sizing; pinned so the maths is
    // reproducible.
    const at = new Date().toISOString();
    for (const accountId of [master.id, slave.id, filteredSlave.id]) {
      await repos.accounts.applySnapshot(accountId, {
        accountId,
        balance: 10_000,
        equity: 10_000,
        margin: 0,
        freeMargin: 10_000,
        marginLevel: null,
        currency: 'USD',
        leverage: 100,
        at,
      });
    }

    const copier = await repos.copiers.create({
      userId: user.id,
      name: 'Copy to follower',
      masterAccountId: master.id,
      status: 'enabled',
    });
    const follower = await repos.copiers.addFollower({
      copierId: copier.id,
      accountId: slave.id,
      settings: followerSettingsSchema.parse({ riskType: 'FIXED_LOT', riskValue: FIXED_LOT }),
      suffixPreference: '.raw',
      enabled: true,
    });
    await repos.copiers.bulkUpsertMappings(follower.id, [
      { masterSymbol: MASTER_SYMBOL, slaveSymbol: SLAVE_SYMBOL, source: 'auto', confidence: 1 },
    ]);

    const filteredCopier = await repos.copiers.create({
      userId: user.id,
      name: 'Copy longs only',
      masterAccountId: master.id,
      status: 'enabled',
    });
    const filteredFollower = await repos.copiers.addFollower({
      copierId: filteredCopier.id,
      accountId: filteredSlave.id,
      settings: followerSettingsSchema.parse({
        riskType: 'FIXED_LOT',
        riskValue: FIXED_LOT,
        filters: { side: 'sell' },
      }),
      suffixPreference: '.raw',
      enabled: true,
    });
    await repos.copiers.bulkUpsertMappings(filteredFollower.id, [
      { masterSymbol: MASTER_SYMBOL, slaveSymbol: SLAVE_SYMBOL, source: 'auto', confidence: 1 },
    ]);

    const engine = createEngine({ env, repos, ui: new UiHub(), log: silentLogger });

    // No agents in a test process: every account is served by a mock seeded
    // from the symbols and balance just stored.
    for (const accountId of [master.id, slave.id, filteredSlave.id]) {
      const connector = await engine.registry.createMock(accountId);
      if (!connector) throw new Error(`mock connector missing for ${accountId}`);
    }

    fixture = {
      db,
      env,
      engine,
      userId: user.id,
      masterAccountId: master.id,
      slaveAccountId: slave.id,
      copierId: copier.id,
      followerId: follower.id,
      filteredCopierId: filteredCopier.id,
      filteredFollowerId: filteredFollower.id,
      filteredSlaveAccountId: filteredSlave.id,
    };
  }, 60_000);

  afterAll(async () => {
    if (!fixture) return;
    await fixture.engine.stop();
    await fixture.db.handle.close();
  });

  /** Runs the dispatcher until the outbox is empty. */
  async function drain(): Promise<number> {
    let total = 0;
    for (let round = 0; round < 20; round += 1) {
      const processed = await fixture.engine.dispatcher.tick(50);
      if (processed === 0) break;
      total += processed;
    }
    return total;
  }

  it('copies a master position with the follower sizing and the mapped symbol', async () => {
    await fixture.engine.feedMasterPositions(fixture.masterAccountId, [masterPosition({ volume: 1 })]);
    const dispatched = await drain();
    expect(dispatched).toBe(1);

    const links = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.state).toBe('open');
    expect(link.masterSymbol).toBe(MASTER_SYMBOL);
    expect(link.slaveSymbol).toBe(SLAVE_SYMBOL);
    // FIXED_LOT ignores the master's 1.00 lot and the balance difference.
    expect(link.filledVolume).toBeCloseTo(FIXED_LOT, 6);
    expect(link.filledPrice).toBeGreaterThan(0);
    expect(link.slaveTicket).not.toBeNull();
    expect(link.errorCode).toBeNull();

    // The order really reached the broker boundary, not just the database.
    const connector = await fixture.engine.registry.for(fixture.slaveAccountId);
    const positions = await connector!.listPositions();
    expect(positions.ok).toBe(true);
    if (positions.ok) {
      expect(positions.value).toHaveLength(1);
      expect(positions.value[0]?.symbol).toBe(SLAVE_SYMBOL);
      expect(positions.value[0]?.volume).toBeCloseTo(FIXED_LOT, 6);
    }

    // Two rows, on purpose: the pipeline logs the *decision* ("Opened …
    // on <follower>", carrying the rule-by-rule trace) and the dispatcher logs
    // the *execution* ("Filled …"). Filtering by account narrows it to the fill.
    const copied = await fixture.db.repos.engine.listLogs({ userId: fixture.userId, copierId: fixture.copierId, codes: ['COPIED'] });
    expect(copied.total).toBe(2);
    const messages = copied.rows.map((row) => row.message);
    expect(messages.some((message) => message.startsWith('Opened'))).toBe(true);
    expect(messages.some((message) => message.startsWith('Filled'))).toBe(true);
  });

  it('applies follower filters instead of copying everything', async () => {
    // The buy above must not reach the "sell only" follower.
    const links = await fixture.db.repos.engine.listLinksForFollower(fixture.filteredFollowerId);
    expect(links).toHaveLength(0);

    const filtered = await fixture.db.repos.engine.listLogs({
      userId: fixture.userId,
      copierId: fixture.filteredCopierId,
      codes: ['FILTERED_SIDE'],
    });
    expect(filtered.total).toBe(1);
    // The message names the side that was refused, not the one allowed.
    expect(filtered.rows[0]?.message).toContain('excluded by the side filter');
  });

  it('is idempotent: the same snapshot does not open a second position', async () => {
    const before = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    await fixture.engine.feedMasterPositions(fixture.masterAccountId, [masterPosition({ volume: 1 })]);
    expect(await drain()).toBe(0);

    const after = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    expect(after).toHaveLength(before.length);
  });

  it('closes the follower leg when the master position disappears', async () => {
    // An empty snapshot is authoritative: everything previously open is gone.
    await fixture.engine.feedMasterPositions(fixture.masterAccountId, []);
    const dispatched = await drain();
    expect(dispatched).toBe(1);

    const links = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    const link = links[0]!;
    expect(link.state).toBe('closed');
    expect(link.closedAt).not.toBeNull();

    const masterTrades = await fixture.db.repos.engine.listMasterTradesForCopier(fixture.copierId);
    expect(masterTrades[0]?.state).toBe('closed');

    const closed = await fixture.db.repos.engine.listLogs({
      userId: fixture.userId,
      copierId: fixture.copierId,
      codes: ['COPIED_CLOSE'],
    });
    expect(closed.total).toBe(2);
  });

  it('attributes realised P/L from the broker-reported closed trade', async () => {
    const links = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    const link = links[0]!;
    const openedAt = (link.openedAt ?? new Date()).toISOString();

    await fixture.engine.feedClosedTrade(fixture.slaveAccountId, {
      ticket: link.slaveTicket!,
      symbol: link.slaveSymbol!,
      side: link.side,
      volume: link.filledVolume ?? FIXED_LOT,
      openPrice: link.filledPrice ?? 0,
      // Cost basis: the broker is the only source of truth for the exit.
      closePrice: 1.02,
      stopLoss: null,
      takeProfit: null,
      magic: link.magic ?? 0,
      comment: 'test',
      profit: 10,
      swap: -0.5,
      commission: -1.5,
      openedAt,
      closedAt: new Date().toISOString(),
    });

    const [reloaded] = await fixture.db.repos.engine.listLinksForFollower(fixture.followerId);
    // The link carries the *net* result: gross P/L minus swap and commission.
    expect(reloaded?.realizedProfit).toBeCloseTo(8, 6);

    const trades = await fixture.db.repos.engine.listClosedTrades(
      fixture.slaveAccountId,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(trades).toHaveLength(1);
    // The stored trade keeps the three components apart, exactly as the
    // terminal reports them, so a later re-attribution can be recomputed.
    expect(trades[0]?.profit).toBeCloseTo(10, 6);
    expect(trades[0]?.swap).toBeCloseTo(-0.5, 6);
    expect(trades[0]?.commission).toBeCloseTo(-1.5, 6);
  });

  it('leaves no commands stuck in the outbox', async () => {
    const depth = await fixture.db.repos.engine.queueDepth();
    expect(depth).toBe(0);
  });
});

function masterPosition(overrides: { volume: number; ticket?: string }): Position {
  return positionSchema.parse({
    ticket: overrides.ticket ?? 'master-1',
    symbol: MASTER_SYMBOL,
    side: 'buy',
    volume: overrides.volume,
    openPrice: 64_000,
    currentPrice: 64_120,
    stopLoss: 63_800,
    takeProfit: 65_000,
    magic: 0,
    comment: 'integration test',
    openedAt: new Date().toISOString(),
    profit: 120,
    swap: 0,
    commission: -2,
  });
}

function crypto(name: string) {
  return {
    name,
    canonical: 'BTCUSD',
    assetClass: 'crypto' as const,
    digits: 2,
    point: 0.01,
    // Crypto "pips" are conventional; the copier only uses them for slippage
    // and spread filters, which this fixture does not exercise.
    pipSize: 1,
    contractSize: 1,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    quoteCurrency: 'USD',
    tradeMode: 'full' as const,
  };
}
