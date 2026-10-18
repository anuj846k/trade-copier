import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { CopyEngine } from '../engine/worker.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { TicketStore } from '../lib/tickets.js';

/**
 * Engine + ephemeral state.
 *
 * The engine is attached to the Fastify instance so routes can feed it (symbol
 * refresh, manual reconcile) and so the process lifecycle owns it: `onClose`
 * stops every loop and releases the queued commands it claimed.
 */
export interface EnginePluginOptions {
  /** Set to false when the worker runs as its own process. */
  readonly runInProcess?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    engine: CopyEngine;
    rateLimiter: RateLimiter;
    tickets: TicketStore;
  }
}

export const enginePlugin = fp<EnginePluginOptions>(async (fastify: FastifyInstance, options: EnginePluginOptions) => {
  const limiter = new RateLimiter(60, 60_000);
  const tickets = new TicketStore(fastify.env.REALTIME_TICKET_TTL_SECONDS * 1_000);
  fastify.decorate('rateLimiter', limiter);
  fastify.decorate('tickets', tickets);

  const engine = new CopyEngine({
    env: fastify.env,
    repos: fastify.repos,
    ui: fastify.ui,
    log: fastify.log,
    rateLimiter: limiter,
    tickets,
  });
  fastify.decorate('engine', engine);

  if (options.runInProcess !== false) engine.start();

  fastify.addHook('onClose', async () => {
    await engine.stop();
  });
});
