import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { Env } from './config/env.js';
import { dbPlugin } from './plugins/db.js';
import { authPlugin } from './plugins/auth.js';
import { realtimePlugin } from './plugins/realtime.js';
import { enginePlugin } from './plugins/engine.js';
import { authRoutes } from './modules/auth.routes.js';
import { accountRoutes } from './modules/accounts.routes.js';
import { agentRoutes } from './modules/agents.routes.js';
import { copierRoutes } from './modules/copiers.routes.js';
import { insightRoutes } from './modules/insights.routes.js';
import { attachDashboardSocket, healthRoutes, realtimeRoutes } from './modules/realtime.routes.js';
import { toErrorBody } from './lib/errors.js';

/**
 * Server composition.
 *
 * Plugins are registered in dependency order (env/db → auth → realtime → engine
 * → transport → routes) so every route can rely on the decorations it needs.
 * The engine is the only stateful part; with `RUN_WORKER_IN_PROCESS=false` the
 * same binary runs as a stateless API in front of a separate worker.
 */
export interface BuildServerOptions {
  readonly env: Env;
  /** Override the in-process worker default (used by tests and split deployments). */
  readonly runWorker?: boolean | undefined;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env } = options;

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', colorize: true },
            },
          }
        : {}),
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: env.LOG_LEVEL !== 'debug' && env.LOG_LEVEL !== 'trace',
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.length === 0 ? true : env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['content-disposition'],
  });
  await app.register(cookie);
  await app.register(websocket, {
    options: {
      maxPayload: 8 * 1024 * 1024,
      // The bridge agent pushes whole position snapshots; a market with a few
      // hundred open tickets stays well below this.
      perMessageDeflate: false,
    },
  });

  await app.register(dbPlugin, { env });
  await app.register(authPlugin, { env });
  await app.register(realtimePlugin);
  await app.register(enginePlugin, { runInProcess: options.runWorker ?? env.RUN_WORKER_IN_PROCESS });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const body = {
        error: {
          code: 'VALIDATION',
          message: 'Request payload failed validation',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
      };
      void reply.status(400).send(body);
      return;
    }
    const { status, body } = toErrorBody(error);
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.debug({ err: error, status }, 'request rejected');
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url}`,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // routes
  // ---------------------------------------------------------------------------

  await app.register(async (api) => {
    api.get('/', async () => ({
      name: 'Trade Copier API',
      version: env.APP_VERSION,
      docs: '/docs/API.md',
      endpoints: [
        'POST /api/v1/auth/register',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/refresh',
        'GET  /api/v1/accounts',
        'GET  /api/v1/copiers',
        'POST /api/v1/realtime/ticket',
        'GET  /api/v1/ws?ticket=…',
        'GET  /bridge/agent (websocket)',
      ],
    }));
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(accountRoutes, { prefix: '/accounts' });
    await api.register(agentRoutes, { prefix: '/agents' });
    await api.register(copierRoutes, { prefix: '/copiers' });
    await api.register(insightRoutes);
    await api.register(realtimeRoutes);
    await api.register(healthRoutes);
    attachDashboardSocket(api);
  }, { prefix: '/api/v1' });

  // The bridge agent connects outside the versioned REST prefix: its URL is
  // baked into the agent's config and versioned by the protocol handshake.
  app.get('/bridge/agent', { websocket: true }, (socket, request) => {
    app.engine.hub.attach(socket, request.ip);
  });

  app.get('/', async () => ({
    service: 'trade-copier-api',
    version: env.APP_VERSION,
    health: '/api/v1/health',
  }));

  return app;
}
