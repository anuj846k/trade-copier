import { randomBytes } from 'node:crypto';
import { loadEnv, type Env } from '../../src/config/env.js';

/**
 * Environment for the API test suite.
 *
 * `loadEnv` is deliberately reused instead of hand-rolling an object, so a new
 * required variable shows up as a test failure rather than as a runtime
 * surprise in production. `.env` is never read: tests must be reproducible
 * from the environment they are given.
 */

const SECRET = 'test-secret-value-that-is-long-enough-to-pass-validation';
/** A real 32-byte base64 key, generated once per process. */
const KEY = Buffer.alloc(32, 3).toString('base64');

export interface TestEnvOptions {
  readonly databaseUrl?: string | undefined;
  readonly overrides?: Record<string, string | undefined>;
}

export function testEnv(options: TestEnvOptions = {}): Env {
  const source: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: options.databaseUrl ?? 'postgres://localhost:5432/trade_copier_test',
    JWT_SECRET: SECRET,
    ENCRYPTION_KEY: KEY,
    // The engine must not run its own loops inside a test process; tests tick
    // it explicitly so there are no races with assertions.
    RUN_WORKER_IN_PROCESS: 'false',
    ...options.overrides,
  };
  return loadEnv({ loadDotEnv: false, source });
}

export function testDatabaseUrl(): string | undefined {
  return process.env['TEST_DATABASE_URL'];
}

/** Same shape `loadEnv` expects, useful for negative assertions. */
export const TEST_SECRET = SECRET;
export const TEST_ENCRYPTION_KEY = KEY;

export function randomEmail(prefix = 'trader'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.test`;
}
