import { createDb, createRepositories, runMigrations, type DbHandle, type Repositories } from '@trade-copier/db';
import { testDatabaseUrl } from './env.js';

/**
 * Test database harness.
 *
 * The suite runs against a *separate* database (`TEST_DATABASE_URL`) and drops
 * the `public` schema between suites. Two guards protect the developer's data:
 *
 *   1. the variable must be set — otherwise the whole suite is skipped, so
 *      `pnpm test` is useful on a machine with no Postgres at all;
 *   2. the database name must end in `_test`, so a copy-paste of DATABASE_URL
 *      cannot drop a development or production schema.
 *
 * `tools/init-db.sql` creates `trade_copier_test` for the docker-compose
 * Postgres.
 */
export interface TestDatabase {
  readonly handle: DbHandle;
  readonly repos: Repositories;
}

export function hasTestDatabase(): boolean {
  return typeof testDatabaseUrl() === 'string' && testDatabaseUrl()!.length > 0;
}

/** Throws when the configured test database is not obviously a test database. */
function assertTestDatabaseName(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset "${name}": the test database name must end with "_test".`);
  }
}

/**
 * Opens the test database, drops and recreates the schema, applies every
 * migration and returns the handle. Call from `beforeAll`.
 */
export async function resetTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  assertTestDatabaseName(url);

  const handle = createDb({ connectionString: url, max: 4, applicationName: 'trade-copier-test' });
  // The `drizzle` schema holds the migration bookkeeping. Dropping only
  // `public` would leave that ledger saying "already applied", so the *second*
  // run of a suite would come up with no tables at all and fail in a way that
  // looks like a product bug.
  await handle.pool.query('drop schema if exists public cascade');
  await handle.pool.query('drop schema if exists drizzle cascade');
  await handle.pool.query('create schema if not exists public');
  await runMigrations(handle.db);

  return { handle, repos: createRepositories(handle.db) };
}

/** Truncates every table except the migration metadata. */
export async function truncateAll(handle: DbHandle): Promise<void> {
  const rows = await handle.pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_drizzle%'`,
  );
  const tables = rows.rows.map((row) => `"public"."${row.tablename}"`);
  if (tables.length === 0) return;
  await handle.pool.query(`truncate ${tables.join(', ')} cascade`);
}

/** Convenience: an exact row count, for assertions like "no duplicate links". */
export async function countRows(handle: DbHandle, table: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const result = await handle.pool.query<{ count: string }>(`select count(*)::text as count from "${table}"`);
  return Number(result.rows[0]?.count ?? 0);
}
