import { defineWorkspace } from 'vitest/config';

/**
 * Vitest workspace.
 *
 *  - `domain`    pure logic (no I/O) — the copy planner, sizing, symbol maths.
 *  - `contracts` schema/parsing invariants.
 *  - `api`       integration tests; need a PostgreSQL instance and are skipped
 *                automatically when `DATABASE_URL` is not reachable.
 */
export default defineWorkspace([
  {
    test: {
      name: 'domain',
      root: 'packages/domain',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      reporters: process.env.CI ? ['default'] : ['default'],
    },
  },
  {
    test: {
      name: 'contracts',
      root: 'packages/contracts',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'api',
      root: 'apps/api',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
