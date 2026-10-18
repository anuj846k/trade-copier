#!/usr/bin/env node
import { loadEnv, EnvValidationError } from './config/env.js';
import { buildServer } from './server.js';

/**
 * API entry point.
 *
 * Boot order matters: the environment is validated (and explained) before
 * anything else starts, so a misconfigured deploy fails immediately with a list
 * of missing variables instead of a half-working process.
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

  const app = await buildServer({ env });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.log.info(
      { port: env.API_PORT, workerInProcess: env.RUN_WORKER_IN_PROCESS, env: env.NODE_ENV },
      'trade copier API listening',
    );
    if (!env.RUN_WORKER_IN_PROCESS) {
      app.log.warn('RUN_WORKER_IN_PROCESS=false: no copy engine runs in this process; start the worker separately');
    }
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
