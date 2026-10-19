import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Environment loading for the command-line tools.
 *
 * The API validates the *whole* environment at boot (`loadEnv` in
 * `apps/api/src/config/env.ts`), which is right for a server that needs every
 * secret to do its job. The tools do not: `db:seed` only needs `DATABASE_URL`,
 * and forcing a user to invent a valid `JWT_SECRET` before they can seed a
 * local database would be hostile. So the tools read the variables they
 * actually use, straight from `.env`.
 */

/** Loads `KEY=value` pairs from a dotenv file without overriding real env vars. */
export function loadEnvFile(file = '.env', cwd = process.cwd()): void {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    // A real environment variable always wins, which is what makes
    // `DATABASE_URL=… pnpm db:seed` work as expected.
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue);
  }
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Reads a required variable, loading `.env` first. */
export function requireEnv(name: string, hint?: string): string {
  loadEnvFile();
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set.${hint ? ` ${hint}` : ''} Copy .env.example to .env first.`);
  }
  return value;
}

/** The application database. */
export function databaseUrl(): string {
  return requireEnv('DATABASE_URL', 'Expected something like postgres://trade_copier:trade_copier@localhost:5432/trade_copier.');
}

/**
 * The database used by `pnpm test:integration`.
 *
 * Deliberately a separate variable: a mis-typed test run must not be able to
 * touch the development data.
 */
export function testDatabaseUrl(): string {
  return requireEnv('TEST_DATABASE_URL', 'The integration suite creates and drops tables, so it needs its own database.');
}
