import type { Position, TradeSide } from '@trade-copier/contracts';
import { positionSchema } from '@trade-copier/contracts';
import type { Repositories } from '@trade-copier/db';
import { loadEnv, type Env } from '../apps/api/src/config/env.js';
import { createEngine, type CopyEngine } from '../apps/api/src/engine/worker.js';
import { UiHub } from '../apps/api/src/realtime/hub.js';
import { withDatabase } from './db.js';
import { DEMO_EMAIL } from './demo-data.js';
import { loadEnvFile } from './env.js';
import { createConsoleLogger } from './logger.js';

/**
 * `pnpm sim [-- --symbols=3] [--verbose] [--keep-open]`
 *
 * Runs the real copy engine against a real database, but with **mock broker
 * connectors** instead of bridge agents. This is the end-to-end check that does
 * not need a terminal:
 *
 *   1. the master's positions are fed into the engine exactly as an agent
 *      would report them (`feedMasterPositions`);
 *   2. the engine appends commands to the durable outbox;
 *   3. the dispatcher is ticked until the outbox drains — the same code path
 *      the worker process runs;
 *   4. mock connectors fill the follower orders;
 *   5. the master position is closed and the follower legs close with it.
 *
 * Afterwards the rows it wrote are visible in the dashboard for the seeded
 * demo user, which is what makes this more useful than a unit test: it
 * exercises sizing, symbol mapping, the outbox and the UI's read models at
 * once.
 *
 * It writes to whatever `DATABASE_URL` points at, so it refuses a non-local
 * host unless `--force` is passed.
 */

const ENTRY_PRICES: Record<string, number> = {
  EURUSD: 1.085,
  GBPUSD: 1.265,
  AUDUSD: 0.658,
  NZDUSD: 0.604,
  USDCAD: 1.356,
  USDCHF: 0.882,
  USDJPY: 149.5,
  EURJPY: 162.2,
  EURGBP: 0.857,
  XAUUSD: 2_350,
  XAGUSD: 27.8,
  US30: 39_100,
  NAS100: 18_250,
  GER40: 18_100,
  BTCUSD: 64_000,
};

interface FollowerRef {
  readonly id: string;
  readonly accountId: string;
  readonly label: string;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const verbose = args.has('--verbose');
  const keepOpen = args.has('--keep-open');
  const symbolCount = readInt(args, '--symbols', 3);

  const { env, generated } = simulationEnv();
  const url = process.env['DATABASE_URL'] ?? '';
  if (!args.has('--force') && !/localhost|127\.0\.0\.1|host\.docker\.internal/.test(url)) {
    throw new Error('DATABASE_URL is not local. Re-run with `pnpm sim -- --force` if you really mean it.');
  }
  if (generated) {
    console.log('note: JWT_SECRET/ENCRYPTION_KEY were missing; using throwaway development values (nothing is signed or encrypted here).');
  }

  const log = createConsoleLogger({ level: verbose ? 'debug' : 'warn', prefix: 'engine' });

  await withDatabase(async ({ repos }) => {
    const user = await repos.auth.findUserByEmail(DEMO_EMAIL);
    if (!user) throw new Error('No demo user found. Run `pnpm db:seed` first.');

    const copier = (await repos.copiers.listByUser(user.id))[0];
    if (!copier) throw new Error('No copier found. Run `pnpm db:seed` first.');

    const master = await repos.accounts.findById(copier.masterAccountId);
    if (!master) throw new Error('The copier has no master account.');

    const followerRecords = await repos.copiers.listFollowers(copier.id);
    if (followerRecords.length === 0) throw new Error('The copier has no followers. Run `pnpm db:seed` first.');

    const followers: FollowerRef[] = [];
    for (const record of followerRecords) {
      const account = await repos.accounts.findById(record.accountId);
      followers.push({ id: record.id, accountId: record.accountId, label: account?.label ?? record.accountId });
    }

    // Each run starts clean. A previous run's links point at a mock instance
    // that no longer exists, so closing them would (correctly) fail with
    // TICKET_NOT_FOUND and bury the current result in noise. Configuration —
    // accounts, mappings, the copier itself — is left alone.
    const cleared = await repos.engine.clearCopierHistory(copier.id);
    const clearedTotal = Object.values(cleared).reduce((total, value) => total + value, 0);
    if (clearedTotal > 0) {
      console.log(
        `Cleared ${clearedTotal} row(s) left by earlier runs (${cleared.trades} master trades, ${cleared.links} links, ` +
          `${cleared.commands} commands, ${cleared.logs} logs, ${cleared.closedTrades} closed trades).`,
      );
    }

    const masterSymbols = await repos.accounts.listSymbols(master.id);
    const mapped = new Set<string>();
    for (const follower of followerRecords) {
      for (const mapping of await repos.copiers.listMappings(follower.id)) mapped.add(mapping.masterSymbol);
    }

    const chosen = masterSymbols.filter((symbol) => mapped.has(symbol.name)).slice(0, symbolCount);
    if (chosen.length === 0) throw new Error('No master symbol is mapped to a follower instrument; check the copier mappings.');

    const engine = createEngine({ env, repos, ui: new UiHub(), log });
    console.log(`\nSimulating ${chosen.length} master position(s) through copier "${copier.name}"`);
    console.log(`  master      ${master.label} (${master.platform} ${master.login})`);
    console.log(`  followers   ${followers.map((follower) => follower.label).join(', ')}`);
    console.log(`  instruments ${chosen.map((symbol) => symbol.name).join(', ')}\n`);

    // Mock connectors are seeded from the stored symbols and balance, so the
    // engine sees the same metadata a real agent would report.
    for (const accountId of [master.id, ...followers.map((follower) => follower.accountId)]) {
      const connector = await engine.registry.createMock(accountId);
      if (!connector) throw new Error(`Could not create a mock connector for ${accountId}.`);
    }

    const openedAt = new Date();
    const ticketPrefix = `sim-${openedAt.getTime()}-`;
    const positions = chosen.map((symbol, index) =>
      makePosition({
        ticket: `${ticketPrefix}${index}`,
        symbol: symbol.name,
        canonical: symbol.canonical,
        side: index % 2 === 0 ? 'buy' : 'sell',
        // Different master volumes per position so the follower sizing logic is
        // visible in the output instead of everything being 1.00 lot.
        volume: index === 0 ? 1 : index === 1 ? 0.5 : 2,
        at: openedAt,
      }),
    );

    console.log('→ master opens', positions.map((position) => `${position.side} ${position.volume} ${position.symbol}`).join(', '));
    await engine.feedMasterPositions(master.id, positions);
    const openCommands = await drain(engine);
    console.log(`  ${openCommands} command(s) dispatched\n`);
    // Only this run's rows are printed; the database may hold earlier
    // simulations, and a wall of stale tickets hides the result.
    await printState(repos, copier.id, followers, ticketPrefix);

    if (!keepOpen) {
      // One position stays open; the others close so a follow-up reconciliation
      // has something to compare against.
      const stillOpen = positions.slice(1);
      const closed = positions[0];
      console.log(
        `→ master closes ${closed ? `${closed.symbol} ${closed.ticket}` : '(nothing)'}${stillOpen.length > 0 ? ` and keeps ${stillOpen.length} open` : ''}`,
      );
      await engine.feedMasterPositions(master.id, stillOpen);
      const closeCommands = await drain(engine);
      console.log(`  ${closeCommands} command(s) dispatched\n`);

      // A broker-reported closed trade is the only source of realised P/L for a
      // follower leg, so report it exactly like an agent would: the P/L is
      // derived from the follower's own volume and the instrument's contract
      // size, and lands in the instrument's quote currency (as a terminal
      // would report it, without the copier's FX conversion).
      const contractSizes = new Map<string, number>();
      for (const follower of followers) {
        for (const symbol of await repos.accounts.listSymbols(follower.accountId)) {
          contractSizes.set(`${follower.accountId}:${symbol.name}`, symbol.contractSize);
        }
      }

      for (const follower of followers) {
        for (const link of await repos.engine.listLinksForFollower(follower.id, 10)) {
          if (link.state !== 'closed' || !link.slaveTicket) continue;
          const entry = link.filledPrice ?? ENTRY_PRICES[link.masterSymbol.toUpperCase()] ?? 100;
          const exit = link.side === 'buy' ? entry * 1.0021 : entry * 0.9979;
          const closePrice = Number(exit.toFixed(5));
          const volume = link.filledVolume ?? link.masterVolume;
          const contractSize = contractSizes.get(`${follower.accountId}:${link.slaveSymbol ?? ''}`) ?? 100_000;
          const move = (link.side === 'buy' ? 1 : -1) * (closePrice - entry);
          await engine.feedClosedTrade(follower.accountId, {
            ticket: link.slaveTicket,
            symbol: link.slaveSymbol ?? link.masterSymbol,
            side: link.side,
            volume,
            openPrice: entry,
            closePrice,
            stopLoss: link.side === 'buy' ? Number((entry * 0.997).toFixed(5)) : null,
            takeProfit: link.side === 'buy' ? Number((entry * 1.006).toFixed(5)) : null,
            magic: link.magic ?? 0,
            comment: 'simulation',
            profit: Number((move * contractSize * volume).toFixed(2)),
            swap: Number((-0.5 * volume).toFixed(2)),
            commission: Number((-7 * volume).toFixed(2)),
            openedAt: (link.openedAt ?? openedAt).toISOString(),
            closedAt: new Date(openedAt.getTime() + 90_000).toISOString(),
          });
          await drain(engine);
        }
      }

      await printState(repos, copier.id, followers, ticketPrefix);
    }

    await printLog(repos, user.id, copier.id);
    await engine.stop();
  });

  console.log('Done. Sign in as the demo user and open Copiers → Trades to see what the engine decided.\n');
}

/** Environment for the engine, tolerating a `.env` that only has DATABASE_URL. */
function simulationEnv(): { env: Env; generated: boolean } {
  loadEnvFile();
  const source: Record<string, string | undefined> = { ...process.env };
  let generated = false;
  if (!source['JWT_SECRET']) {
    source['JWT_SECRET'] = 'simulation-only-secret-value-not-used-for-anything';
    generated = true;
  }
  if (!source['ENCRYPTION_KEY']) {
    // Any 32-byte base64 value satisfies the schema's shape check.
    source['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    generated = true;
  }
  return { env: loadEnv({ loadDotEnv: false, source }), generated };
}

function makePosition(input: {
  ticket: string;
  symbol: string;
  canonical: string;
  side: TradeSide;
  volume: number;
  at: Date;
}): Position {
  const price = ENTRY_PRICES[input.canonical.toUpperCase()] ?? 100;
  const round = (value: number) => Number(value.toFixed(5));
  return positionSchema.parse({
    ticket: input.ticket,
    symbol: input.symbol,
    side: input.side,
    volume: input.volume,
    openPrice: round(price),
    // A move in the position's favour, so floating P/L is not zero.
    currentPrice: round(input.side === 'buy' ? price * 1.0012 : price * 0.9988),
    stopLoss: round(input.side === 'buy' ? price * 0.997 : price * 1.003),
    takeProfit: round(input.side === 'buy' ? price * 1.006 : price * 0.994),
    magic: 20261019,
    comment: 'simulation',
    openedAt: input.at.toISOString(),
    updatedAt: input.at.toISOString(),
    profit: input.side === 'buy' ? 137.4 : -52.1,
    swap: -0.35,
    commission: -7,
  });
}

/** Runs claim/execute cycles until the outbox is empty. */
async function drain(engine: CopyEngine): Promise<number> {
  let total = 0;
  for (let round = 0; round < 25; round += 1) {
    const processed = await engine.dispatcher.tick(50);
    if (processed === 0) break;
    total += processed;
  }
  return total;
}

async function printState(
  repos: Repositories,
  copierId: string,
  followers: readonly FollowerRef[],
  ticketPrefix: string,
): Promise<void> {
  const allTrades = await repos.engine.listMasterTradesForCopier(copierId, 200);
  const masterTrades = allTrades.filter((trade) => trade.ticket.startsWith(ticketPrefix));
  const runTradeIds = new Set(masterTrades.map((trade) => trade.id));
  console.log('  master trades');
  for (const trade of masterTrades) {
    console.log(
      `    ${trade.ticket.padEnd(26)} ${trade.side.padEnd(4)} ${trade.volume.toFixed(2).padStart(5)} ${trade.symbol.padEnd(8)} ${trade.state}`,
    );
  }

  console.log('  follower legs');
  for (const follower of followers) {
    const links = (await repos.engine.listLinksForFollower(follower.id, 200)).filter((link) =>
      runTradeIds.has(link.masterTradeId),
    );
    if (links.length === 0) {
      console.log(`    ${follower.label}: no legs yet`);
      continue;
    }
    for (const link of links) {
      const sizing =
        link.filledVolume === null
          ? `requested ${link.requestedVolume?.toFixed(2) ?? '—'} lots`
          : `${link.filledVolume.toFixed(2)} lots @ ${link.filledPrice?.toFixed(5) ?? '—'}`;
      const pnl = link.realizedProfit === null ? '' : `  P/L ${link.realizedProfit.toFixed(2)}`;
      console.log(
        `    ${follower.label.padEnd(24)} ${link.masterSymbol.padEnd(8)} → ${(link.slaveSymbol ?? '—').padEnd(12)} ${link.state.padEnd(7)} ${sizing}${pnl}${link.errorCode ? `  ${link.errorCode}` : ''}`,
      );
    }
  }
  console.log('');
}

async function printLog(repos: Repositories, userId: string, copierId: string): Promise<void> {
  const { rows, total } = await repos.engine.listLogs({ userId, copierId, limit: 25 });
  if (total === 0) {
    console.log('  No engine log entries were written. If the FX market is closed the engine skips every decision with MARKET_CLOSED.');
    return;
  }
  console.log(`  engine log (newest first, ${total} row(s) for this copier)`);
  for (const row of rows) {
    console.log(`    ${row.level.padEnd(5)} ${row.code.padEnd(26)} ${row.message}`);
  }
  console.log('');
}

function readInt(args: Set<string>, name: string, fallback: number): number {
  for (const arg of args) {
    if (arg.startsWith(`${name}=`)) {
      const value = Number(arg.slice(name.length + 1));
      if (Number.isFinite(value) && value > 0) return Math.min(10, Math.floor(value));
    }
  }
  return fallback;
}

main().catch((error: unknown) => {
  console.error('\nSimulation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
