import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { UiHub } from '../realtime/hub.js';

/** Dashboard realtime hub, shared by the engine (publisher) and the ws route. */
export const realtimePlugin = fp(async (fastify: FastifyInstance) => {
  const ui = new UiHub();
  fastify.decorate('ui', ui);
});

declare module 'fastify' {
  interface FastifyInstance {
    ui: UiHub;
  }
}
