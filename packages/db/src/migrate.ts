import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the generated SQL migrations (drizzle-kit output). */
export const MIGRATIONS_FOLDER = path.resolve(here, '..', 'drizzle');

/**
 * Applies every pending migration. Safe to call at boot; drizzle records what
 * it has already applied in `drizzle.__drizzle_migrations`.
 */
export async function runMigrations(db: Database, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
