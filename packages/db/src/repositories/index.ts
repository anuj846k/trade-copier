import type { Database } from '../client.js';
import { AccountRepository } from './accounts.js';
import { AuthRepository } from './auth.js';
import { CopierRepository } from './copiers.js';
import { EngineRepository } from './engine.js';
import { PlatformRepository } from './platform.js';

/**
 * The full repository set every process needs.
 *
 * Handlers take this bundle rather than five separate arguments, which keeps the
 * wiring in `plugins/db.ts` (and the standalone worker) to a single object and
 * makes the engine's dependencies obvious in one place.
 */
export interface Repositories {
  readonly auth: AuthRepository;
  readonly accounts: AccountRepository;
  readonly copiers: CopierRepository;
  readonly engine: EngineRepository;
  readonly platform: PlatformRepository;
}

/** Builds the bundle around one connection pool. */
export function createRepositories(db: Database): Repositories {
  return {
    auth: new AuthRepository(db),
    accounts: new AccountRepository(db),
    copiers: new CopierRepository(db),
    engine: new EngineRepository(db),
    platform: new PlatformRepository(db),
  };
}
