import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

/**
 * A logger for the API test suite.
 *
 * `pino` is already a dependency of `apps/api` and `FastifyBaseLogger` is
 * pino's own type, so tests use the real thing at `silent` level instead of a
 * hand-rolled stub that could drift from what the engine actually calls.
 */
export const silentLogger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
