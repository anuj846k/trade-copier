import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { realtimeTopicSchema, uiClientMessageSchema, type UiServerMessage } from '@trade-copier/contracts';
/**
 * Dashboard realtime.
 *
 * Browsers take a ticket (`POST /realtime/ticket`) and then open
 * `GET /ws?ticket=…`, because a WebSocket handshake cannot carry the httpOnly
 * auth cookie the same way a fetch can. The ticket is single-use, short-lived
 * and bound to the user that asked for it.
 */
export const realtimeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.post('/realtime/ticket', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const ticket = fastify.tickets.issue(userId);
    return {
      ticket: ticket.ticket,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      wsUrl: `/api/v1/ws?ticket=${encodeURIComponent(ticket.ticket)}`,
    };
  });
};

/** The websocket itself: registered as a raw ws route in server.ts. */
export function attachDashboardSocket(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (socket, request) => {
    const query = request.query as { ticket?: string } | undefined;
    const ticket = query?.ticket ?? null;
    const claim = ticket ? fastify.tickets.consume(ticket) : null;
    if (!claim) {
      socket.close(4401, 'ticket missing, expired or already used');
      return;
    }

    const client = fastify.ui.add({
      id: randomUUID(),
      userId: claim.userId,
      socket: {
        send: (data: string) => socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code, reason),
      },
    });

    const welcome: UiServerMessage = {
      type: 'hello',
      topics: realtimeTopicSchema.options.slice(),
      serverTime: new Date().toISOString(),
    };
    socket.send(JSON.stringify(welcome));

    socket.on('message', (raw) => {
      fastify.ui.touch(client.id);
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION', message: 'Malformed JSON frame' } satisfies UiServerMessage));
        return;
      }
      const frame = uiClientMessageSchema.safeParse(parsed);
      if (!frame.success) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'VALIDATION',
            message: `Unsupported frame: ${frame.error.issues.map((issue) => issue.message).join('; ')}`,
          } satisfies UiServerMessage),
        );
        return;
      }
      switch (frame.data.type) {
        case 'subscribe':
          fastify.ui.subscribe(client.id, frame.data.topics);
          break;
        case 'unsubscribe':
          fastify.ui.unsubscribe(client.id, frame.data.topics);
          break;
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() } satisfies UiServerMessage));
          break;
      }
    });

    socket.on('close', () => {
      fastify.ui.remove(client.id);
    });

    socket.on('error', () => {
      fastify.ui.remove(client.id);
    });
  });
}

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/health', async (_request, reply) => {
    const [diagnostics, queueDepth, oldestQueuedAgeMs] = await Promise.all([
      fastify.repos.platform.diagnostics().catch(() => null),
      fastify.repos.engine.queueDepth().catch(() => -1),
      fastify.repos.engine.oldestQueuedAgeMs().catch(() => null),
    ]);
    const dbUp = diagnostics !== null;
    return reply.status(dbUp ? 200 : 503).send({
      status: dbUp ? 'ok' : 'degraded',
      version: fastify.env.APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      database: dbUp ? 'up' : 'down',
      queue: { depth: queueDepth, oldestQueuedAgeMs },
      agents: fastify.engine.hub.stats(),
      realtime: fastify.ui.stats(),
      counters: diagnostics,
      now: new Date().toISOString(),
    });
  });

  fastify.get('/health/ready', async (_request, reply) => {
    const ok = await fastify.repos.platform
      .diagnostics()
      .then(() => true)
      .catch(() => false);
    return reply.status(ok ? 200 : 503).send({ ready: ok });
  });

  fastify.get('/version', async () => ({ version: fastify.env.APP_VERSION, node: process.version }));
};
