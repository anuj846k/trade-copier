import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';

/**
 * Bridge agents.
 *
 * An agent is the machine running next to the trading terminal. Its secret is
 * shown exactly once (creation time) and stored hashed; the WebSocket bridge
 * authenticates with it in the `agent.hello` message.
 */
export const agentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { repos } = fastify;

  fastify.get('/', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accounts, ...agents } = await listAgents(fastify, userId);
    void agents;
    const byAgent = new Map<string, typeof accounts>();
    for (const account of accounts) {
      if (!account.agentId) continue;
      const list = byAgent.get(account.agentId);
      if (list) list.push(account);
      else byAgent.set(account.agentId, [account]);
    }
    return {
      agents: agents.list.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: fastify.engine.hub.isAgentOnline(agent.id) ? 'online' : agent.status,
        version: agent.version,
        host: agent.host,
        lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
        createdAt: agent.createdAt.toISOString(),
        accounts: byAgent.get(agent.id) ?? [],
      })),
      protocolVersion: 1,
      connectHint: 'Install the bridge agent next to your terminal and paste the token; see docs/BRIDGE.md.',
    };
  });

  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const agent = await repos.accounts.createAgent({ userId, name: body.name });
    await repos.platform.audit({
      userId,
      action: 'agent.created',
      entityType: 'agent',
      entityId: agent.id,
      ip: request.ip,
    });
    // The plaintext secret is returned exactly once.
    return reply.status(201).send({
      agent: { id: agent.id, name: body.name, createdAt: new Date().toISOString() },
      token: agent.secret,
      warning: 'Store this token now: it is hashed at rest and cannot be shown again.',
    });
  });

  fastify.delete('/:agentId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { agentId } = request.params as { agentId: string };
    const revoked = await repos.accounts.revokeAgent(userId, agentId);
    if (!revoked) throw ApiError.notFound('Agent not found');
    await repos.platform.audit({ userId, action: 'agent.revoked', entityType: 'agent', entityId: agentId, ip: request.ip });
    return { ok: true };
  });

  async function listAgents(fastifyInstance: FastifyInstance, userId: string) {
    const agents = await fastifyInstance.repos.accounts.listAgents(userId);
    const accounts = (await fastifyInstance.repos.accounts.listByUser(userId)).map((account) => ({
      id: account.id,
      label: account.label,
      login: account.login,
      server: account.server,
      agentId: account.agentId,
    }));
    return { list: agents, accounts };
  }
};
