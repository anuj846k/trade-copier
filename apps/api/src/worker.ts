#!/usr/bin/env node
import { createDb, AuthRepository, AccountRepository, CopierRepository, EngineRepository, PlatformRepository } from '@trade-copier/db';
import { loadEnv, EnvValidationError } from './config/env.js';
import { SecretCipher } from './lib/crypto.js';
import { RateLimiter } from './lib/ratelimit.js';
import { TicketStore } from './lib/tickets.js';
import { UiHub } from './realtime/hub.js';
import { createEngine } from './engine/worker.js';
import { pino } from 'pino';

/**
 * Standalone copy worker.
 *
 * Same engine as the API process, without HTTP. Run this with
 * `RUN_WORKER_IN_PROCESS=false` when you want to scale the API horizontally:
 * the two processes share only PostgreSQL, and every queue operation is claimed
 * with `FOR UPDATE SKIP LOCKED`, so any number of workers can run side by side.
 */
async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // eslint-disable-next-line no-console
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const log = pino({
    level: env.LOG_LEVEL,
    base: { component: 'worker' },
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', colorize: true } } }
      : {}),
  });

  const handle = createDb({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_SIZE,
    applicationName: 'trade-copier-worker',
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
  });

  const repos = {
    auth: new AuthRepository(handle.db),
    accounts: new AccountRepository(handle.db),
    copiers: new CopierRepository(handle.db),
    engine: new EngineRepository(handle.db),
    platform: new PlatformRepository(handle.db),
  };

  const ui = new UiHub();
  const rateLimiter = new RateLimiter(600, 60_000);
  const tickets = new TicketStore(env.REALTIME_TICKET_TTL_SECONDS * 1_000);
  const cipher = new SecretCipher(env.ENCRYPTION_KEY);
  void cipher;

  const engine = createEngine({ env, repos, ui, log, rateLimiter, tickets });
  engine.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    await engine.stop();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info({ pollIntervalMs: env.WORKER_POLL_INTERVAL_MS }, 'copy worker running (no HTTP surface)');
}

void main();
