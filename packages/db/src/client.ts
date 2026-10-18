import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either the pool-backed database or an open transaction. */
export type Executor = Database | Transaction;

export interface CreateDbOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

export interface DbHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Creates the Drizzle client. One pool per process; the worker and the API
 * intentionally use separate pools so a stuck worker cannot starve requests.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    application_name: options.applicationName ?? 'trade-copier',
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
  });

  // pg emits these on idle clients; a broken client must never crash the process.
  pool.on('error', (error) => {
    // eslint-disable-next-line no-console -- last-resort visibility before the logger exists
    console.error({ err: error }, 'postgres idle client error');
  });

  const db = drizzle(pool, { schema, logger: false });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}

/** Runs `fn` in a transaction; nested calls join the outer transaction. */
export async function withTransaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** True when we are already inside a transaction (i.e. not the pool client). */
export function isTransaction(executor: Executor): executor is Transaction {
  return typeof (executor as Transaction).rollback === 'function';
}
