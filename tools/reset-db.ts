import { runMigrations } from '@trade-copier/db';
import { databaseUrl, withDatabase } from './db.js';
import { seedDemoData } from './demo-data.js';

/**
 * `pnpm db:reset [--keep-seed]`
 *
 * Drops and recreates the `public` schema, then replays every migration. This
 * is the "my local database is in a strange state" button.
 *
 * Guard rails, because this command deletes everything:
 *   · refuse to run when NODE_ENV=production
 *   · refuse to run when the URL looks like a hosted database unless
 *     `--force` is passed
 *   · never touch TEST_DATABASE_URL — the integration suite manages its own
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const url = databaseUrl();
  const host = safeHost(url);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run with NODE_ENV=production.');
  }

  if (!args.has('--force') && !isLocalHost(host)) {
    throw new Error(
      `DATABASE_URL points at "${host}", which is not localhost. Re-run as \`pnpm db:reset -- --force\` if that is really what you want.`,
    );
  }

  if (!args.has('--keep-seed') && !args.has('--seed')) {
    console.log('Resetting to an empty, fully-migrated database. Pass --seed to add the demo data afterwards.');
  }

  await withDatabase(
    async ({ handle }) => {
      console.log(`Dropping schema public on ${host} …`);
      await handle.pool.query('drop schema if exists public cascade');
      await handle.pool.query('create schema public');
      console.log('Replaying migrations …');
      await runMigrations(handle.db);
      console.log('Migrations applied.');
    },
    { migrate: false },
  );

  if (args.has('--seed')) {
    const summary = await withDatabase(seedDemoData, { migrate: false });
    console.log(`Demo data ready — sign in as the seeded user (copier ${summary.copierId}).`);
  } else {
    console.log('Empty database ready. Run `pnpm db:seed` when you want demo data.');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'host.docker.internal' || host === 'postgres';
}

main().catch((error: unknown) => {
  console.error('\nReset failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
