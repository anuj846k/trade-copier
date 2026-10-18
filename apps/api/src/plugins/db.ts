import fp from 'fastify-plugin';
import { createDb, createRepositories, type Database, type DbHandle, type Repositories } from '@trade-copier/db';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import { SecretCipher } from '../lib/crypto.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    dbHandle: DbHandle;
    repos: Repositories;
    cipher: SecretCipher;
    env: Env;
  }
}

export interface DbPluginOptions {
  readonly env: Env;
  /** Tests inject their own pool (e.g. a transaction-scoped handle). */
  readonly handle?: DbHandle | undefined;
}

/**
 * One pool per process for the API; the worker shares it (the pool is
 * concurrency-limited anyway) so a busy copy loop cannot exhaust connections
 * that the HTTP layer needs.
 */
export const dbPlugin = fp<DbPluginOptions>(async (fastify: FastifyInstance, options: DbPluginOptions) => {
  const handle =
    options.handle ??
    createDb({
      connectionString: options.env.DATABASE_URL,
      max: options.env.DB_POOL_SIZE,
      statementTimeoutMs: options.env.DB_STATEMENT_TIMEOUT_MS,
      applicationName: 'trade-copier-api',
    });

  fastify.decorate('env', options.env);
  fastify.decorate('dbHandle', handle);
  fastify.decorate('db', handle.db);
  fastify.decorate('cipher', new SecretCipher(options.env.ENCRYPTION_KEY));
  fastify.decorate('repos', createRepositories(handle.db));

  fastify.addHook('onClose', async () => {
    if (!options.handle) await handle.close();
  });
});
