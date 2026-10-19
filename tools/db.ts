import { createDb, createRepositories, runMigrations, type DbHandle, type Repositories } from '@trade-copier/db';
import { databaseUrl } from './env.js';

export interface ToolContext {
  readonly handle: DbHandle;
  readonly repos: Repositories;
}

/**
 * Opens the database, optionally applies pending migrations, runs `fn`, and
 * always closes the pool.
 *
 * Tools are short-lived processes; leaking a pool keeps `tsx` alive until the
 * idle timeout and makes scripts look hung in CI.
 */
export async function withDatabase<T>(fn: (context: ToolContext) => Promise<T>, options: { migrate?: boolean } = {}): Promise<T> {
  const connectionString = databaseUrl();
  const handle = createDb({ connectionString, max: 4, applicationName: 'trade-copier-tool' });
  try {
    if (options.migrate) await runMigrations(handle.db);
    const repos = createRepositories(handle.db);
    return await fn({ handle, repos });
  } finally {
    await handle.close();
  }
}

export { databaseUrl };
