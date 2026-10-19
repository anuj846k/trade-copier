import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Platform, SymbolInfo } from '@trade-copier/contracts';
import { equityProtectionSchema, platformSchema } from '@trade-copier/contracts';
import { autoMapSymbols, resolveSymbol, suggestCandidates } from '@trade-copier/domain';
import { ApiError } from '../lib/errors.js';
import type { AccountRecord } from '@trade-copier/db';

/**
 * Accounts, bridge agents, symbols, credentials, equity protection and sharing.
 *
 * The dashboard never sees broker secrets: passwords are encrypted (AES-256-GCM)
 * and only ever read back by the bridge agent path, while the API exposes a
 * fingerprint so the UI can show *which* credential is stored without
 * disclosing it.
 */

const createAccountSchema = z.object({
  label: z.string().min(1).max(120),
  platform: platformSchema,
  login: z.string().min(1).max(40),
  server: z.string().min(1).max(120),
  brokerName: z.string().max(120).optional(),
  currency: z.string().min(3).max(8).default('USD'),
  leverage: z.number().int().positive().nullable().default(null),
  kind: z.enum(['demo', 'live']).default('demo'),
  role: z.enum(['master', 'slave', 'both']).default('both'),
  agentId: z.string().nullable().default(null),
  password: z.string().max(200).optional(),
  investorPassword: z.string().max(200).optional(),
});

export const accountRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { repos, cipher } = fastify;

  // -------------------------------------------------------------------------
  // accounts
  // -------------------------------------------------------------------------

  fastify.get('/', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const accounts = await repos.accounts.listAccessible(userId);
    const agents = await repos.accounts.listAgents(userId);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return {
      accounts: accounts.map((account) => serializeAccount(account, {
        online: fastify.engine.hub.isAccountOnline(account.id),
        agent: account.agentId ? agentById.get(account.agentId) ?? null : null,
      })),
    };
  });

  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const body = createAccountSchema.parse(request.body);

    const duplicate = await repos.accounts.findByPlatformLogin(body.platform as Platform, body.login, body.server);
    if (duplicate && !duplicate.deletedAt) {
      throw ApiError.conflict('That account is already connected', { accountId: duplicate.id });
    }

    const account = await repos.accounts.create({
      userId,
      label: body.label,
      platform: body.platform as Platform,
      login: body.login,
      server: body.server,
      brokerName: body.brokerName ?? null,
      kind: body.kind,
      currency: body.currency,
      leverage: body.leverage,
      agentId: body.agentId,
      role: body.role,
    });

    if (body.password || body.investorPassword) {
      await repos.accounts.upsertCredentials({
        accountId: account.id,
        passwordEncrypted: body.password ? cipher.encrypt(body.password) : null,
        investorPasswordEncrypted: body.investorPassword ? cipher.encrypt(body.investorPassword) : null,
      });
    }

    await repos.platform.audit({
      userId,
      action: 'account.created',
      entityType: 'account',
      entityId: account.id,
      meta: { platform: body.platform, login: body.login, role: body.role },
      ip: request.ip,
    });
    await notify(fastify, userId, account.id, 'account_added', { label: account.label, platform: account.platform });

    return reply.status(201).send({ account: serializeAccount(account, { online: false, agent: null }) });
  });

  fastify.get('/:accountId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    const account = await requireAccount(fastify, userId, accountId);
    const [symbols, protection, credentials, agents] = await Promise.all([
      repos.accounts.listSymbols(accountId),
      repos.platform.getEquityProtection(accountId),
      repos.accounts.getCredentials(accountId),
      repos.accounts.listAgents(userId),
    ]);
    const agent = account.agentId ? agents.find((candidate) => candidate.id === account.agentId) ?? null : null;
    return {
      account: serializeAccount(account, { online: fastify.engine.hub.isAccountOnline(accountId), agent }),
      symbolCount: symbols.length,
      disabledSymbolCount: symbols.filter((symbol) => !symbol.enabled).length,
      equityProtection: protection ?? null,
      credentials: credentials
        ? {
            hasPassword: Boolean(credentials.passwordEncrypted),
            hasInvestorPassword: Boolean(credentials.investorPasswordEncrypted),
            updatedAt: credentials.updatedAt?.toISOString() ?? null,
          }
        : { hasPassword: false, hasInvestorPassword: false, updatedAt: null },
    };
  });

  fastify.patch('/:accountId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const body = z
      .object({
        label: z.string().min(1).max(120).optional(),
        enabled: z.boolean().optional(),
        brokerName: z.string().max(120).optional(),
      })
      .parse(request.body);
    const updated = await repos.accounts.update(accountId, body);
    if (!updated) throw ApiError.notFound('Account not found');
    if (body.enabled !== undefined) {
      await notify(fastify, userId, accountId, body.enabled ? 'account_enabled' : 'account_disabled', { label: updated.label });
    }
    return { account: serializeAccount(updated, { online: fastify.engine.hub.isAccountOnline(accountId), agent: null }) };
  });

  fastify.delete('/:accountId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    const account = await requireAccount(fastify, userId, accountId);
    const deleted = await repos.accounts.softDelete(accountId, userId);
    if (!deleted) throw ApiError.notFound('Account not found');
    await repos.platform.audit({ userId, action: 'account.deleted', entityType: 'account', entityId: accountId, ip: request.ip });
    await notify(fastify, userId, accountId, 'account_deleted', { label: account.label });
    return { ok: true };
  });

  /** Asks the connected agent to push fresh state (symbols, positions, snapshot). */
  fastify.post('/:accountId/refresh', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    if (!fastify.engine.hub.isAccountOnline(accountId)) {
      throw ApiError.fromCopierCode('AGENT_OFFLINE', 'The bridge agent for this account is not connected');
    }
    fastify.engine.hub.requestSnapshot(accountId, ['account', 'symbols', 'positions']);
    return { ok: true, requested: ['account', 'symbols', 'positions'] };
  });

  // -------------------------------------------------------------------------
  // credentials
  // -------------------------------------------------------------------------

  fastify.put('/:accountId/credentials', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const body = z
      .object({ password: z.string().max(200).optional(), investorPassword: z.string().max(200).optional() })
      .parse(request.body);
    if (!body.password && !body.investorPassword) throw ApiError.badRequest('Provide a password or an investor password');

    await repos.accounts.upsertCredentials({
      accountId,
      passwordEncrypted: body.password ? cipher.encrypt(body.password) : null,
      investorPasswordEncrypted: body.investorPassword ? cipher.encrypt(body.investorPassword) : null,
    });
    await repos.platform.audit({ userId, action: 'account.credentials_updated', entityType: 'account', entityId: accountId, ip: request.ip });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // symbols
  // -------------------------------------------------------------------------

  fastify.get('/:accountId/symbols', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const query = z
      .object({
        search: z.string().max(40).optional(),
        enabled: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const symbols = await repos.accounts.listSymbols(accountId);
    const filtered = symbols.filter((symbol) => {
      if (query.enabled === 'true' && !symbol.enabled) return false;
      if (query.enabled === 'false' && symbol.enabled) return false;
      if (query.search && !symbol.name.toUpperCase().includes(query.search.toUpperCase())) return false;
      return true;
    });
    return {
      total: filtered.length,
      symbols: filtered.slice(query.offset, query.offset + query.limit),
    };
  });

  fastify.patch('/:accountId/symbols/:name', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId, name } = request.params as { accountId: string; name: string };
    await requireAccount(fastify, userId, accountId);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const updated = await repos.accounts.setSymbolEnabled(accountId, name, body.enabled);
    if (!updated) throw ApiError.notFound(`Symbol ${name} not found on this account`);
    return { ok: true, name, enabled: body.enabled };
  });

  fastify.post('/:accountId/symbols/bulk', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const body = z
      .object({ names: z.array(z.string().min(1)).min(1).max(1_000), enabled: z.boolean() })
      .parse(request.body);
    const updated = await repos.accounts.setSymbolsEnabled(accountId, body.names, body.enabled);
    return { ok: true, updated };
  });

  // -------------------------------------------------------------------------
  // equity protection
  // -------------------------------------------------------------------------

  fastify.get('/:accountId/equity-protection', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const protection = await repos.platform.getEquityProtection(accountId);
    const events = await repos.platform.listEquityProtectionEvents(accountId, 25);
    return { protection: protection ?? null, events };
  });

  fastify.put('/:accountId/equity-protection', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const body = equityProtectionSchema.parse(request.body);
    const saved = await repos.platform.upsertEquityProtection(accountId, body);
    await repos.platform.audit({
      userId,
      action: 'equity_protection.updated',
      entityType: 'account',
      entityId: accountId,
      meta: { ...body },
      ip: request.ip,
    });
    return { protection: saved };
  });

  // -------------------------------------------------------------------------
  // closed trades + analytics-friendly views
  // -------------------------------------------------------------------------

  fastify.get('/:accountId/trades', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId);
    const query = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(1_000).default(200),
      })
      .parse(request.query);
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    const to = query.to ? new Date(query.to) : new Date();
    const trades = await repos.engine.listClosedTrades(accountId, from, to, query.limit);
    return { trades, from: from.toISOString(), to: to.toISOString() };
  });

  // -------------------------------------------------------------------------
  // sharing
  // -------------------------------------------------------------------------

  fastify.get('/:accountId/shares', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    await requireAccount(fastify, userId, accountId, { ownerOnly: true });
    return { shares: await repos.platform.listShares(accountId) };
  });

  fastify.post('/:accountId/shares', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const { accountId } = request.params as { accountId: string };
    const account = await requireAccount(fastify, userId, accountId, { ownerOnly: true });
    const body = z.object({ email: z.string().email(), role: z.enum(['viewer', 'manager', 'copier']).default('copier') }).parse(request.body);

    const grantee = await repos.auth.findUserByEmail(body.email);
    if (!grantee) throw ApiError.notFound('No Trade Copier account uses that email address');
    if (grantee.id === userId) throw ApiError.badRequest('You already own this account');

    await repos.platform.createShare({
      accountId,
      ownerUserId: userId,
      granteeUserId: grantee.id,
      role: body.role,
      permissions: { balance: true, equity: true, history: true, canCopy: body.role !== 'viewer' },
    });
    await repos.platform.audit({
      userId,
      action: 'account.shared',
      entityType: 'account',
      entityId: accountId,
      meta: { grantee: body.email, role: body.role },
      ip: request.ip,
    });
    void account;
    return reply.status(201).send({ ok: true, shares: await repos.platform.listShares(accountId) });
  });

  fastify.delete('/:accountId/shares/:shareId', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { accountId, shareId } = request.params as { accountId: string; shareId: string };
    await requireAccount(fastify, userId, accountId, { ownerOnly: true });
    const revoked = await repos.platform.revokeShare(userId, shareId);
    if (!revoked) throw ApiError.notFound('Share not found');
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // symbol mapping helpers
  // -------------------------------------------------------------------------

  fastify.post('/symbols/resolve', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const body = z
      .object({
        masterSymbols: z.array(z.string().min(1)).min(1).max(500),
        slaveAccountId: z.string().min(1),
        explicit: z.record(z.string()).optional(),
        suffixPreference: z.string().max(20).nullable().optional(),
      })
      .parse(request.body);
    await requireAccount(fastify, userId, body.slaveAccountId);

    const slaveSymbols = await repos.accounts.listSymbolNames(body.slaveAccountId);
    const resolutions = body.masterSymbols.map((masterSymbol) => {
      const resolution = resolveSymbol({
        masterSymbol,
        slaveSymbols,
        explicit: body.explicit,
        suffixPreference: body.suffixPreference ?? null,
      });
      return {
        masterSymbol,
        slaveSymbol: resolution.slaveSymbol,
        strategy: resolution.strategy,
        confidence: resolution.confidence,
        ambiguous: resolution.ambiguous,
        reason: resolution.reason ?? null,
        suggestions: suggestCandidates(masterSymbol, slaveSymbols, 5),
      };
    });
    const autoMapped = autoMapSymbols({
      masterSymbols: body.masterSymbols,
      slaveSymbols,
      existing: body.explicit,
      suffixPreference: body.suffixPreference ?? null,
    });
    return { resolutions, automap: autoMapped, slaveSymbolCount: slaveSymbols.length };
  });

  fastify.get('/symbols/master-catalog', { preHandler: fastify.authenticate }, async (request) => {
    const query = z.object({ accountId: z.string().min(1) }).parse(request.query);
    const userId = request.accessClaims!.sub;
    await requireAccount(fastify, userId, query.accountId);
    const symbols = await repos.accounts.listSymbols(query.accountId);
    return { symbols: dedupeByCanonical(symbols) };
  });
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export async function requireAccount(
  fastify: FastifyInstance,
  userId: string,
  accountId: string,
  options: { ownerOnly?: boolean } = {},
): Promise<AccountRecord> {
  const account = await fastify.repos.accounts.findById(accountId);
  if (!account || account.deletedAt) throw ApiError.notFound('Account not found');
  if (account.userId === userId) return account;
  if (options.ownerOnly) throw ApiError.forbidden('Only the account owner can do that');
  const share = await fastify.repos.platform.findShare(accountId, userId);
  if (!share) throw ApiError.forbidden('You do not have access to this account');
  return account;
}

function serializeAccount(
  account: AccountRecord,
  extra: { online: boolean; agent: { id: string; name: string; status?: string } | null },
) {
  return {
    id: account.id,
    label: account.label,
    platform: account.platform,
    login: account.login,
    server: account.server,
    brokerName: account.brokerName,
    kind: account.kind,
    // `role` decides which accounts the UI may offer as a master; the API
    // still refuses a follower-only account at copier creation time.
    role: account.role,
    currency: account.currency,
    leverage: account.leverage,
    status: account.status,
    online: extra.online,
    enabled: account.enabled,
    balance: account.balance,
    equity: account.equity,
    freeMargin: account.freeMargin,
    marginLevel: account.marginLevel,
    equityUpdatedAt: account.equityUpdatedAt?.toISOString() ?? null,
    lastHeartbeatAt: account.lastHeartbeatAt?.toISOString() ?? null,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
    agentId: account.agentId,
    agent: extra.agent,
    referenceBalance: account.referenceBalance,
    createdAt: account.createdAt.toISOString(),
  };
}

async function notify(
  fastify: FastifyInstance,
  userId: string,
  accountId: string,
  event: 'account_added' | 'account_deleted' | 'account_enabled' | 'account_disabled' | 'account_connected' | 'account_disconnected',
  payload: Record<string, unknown>,
): Promise<void> {
  const subscribers = await fastify.repos.platform.resolveSubscribers(event, { userId, accountId });
  for (const { channel } of subscribers) {
    await fastify.repos.platform.enqueueNotification({
      userId,
      channelId: channel.id,
      event,
      payload: { accountId, ...payload },
      dedupeKey: `${event}:${accountId}:${channel.id}:${new Date().toISOString().slice(0, 16)}`,
    });
  }
}

/** One row per canonical instrument — the picker the dashboard shows. */
function dedupeByCanonical(symbols: readonly SymbolInfo[]): SymbolInfo[] {
  const byCanonical = new Map<string, SymbolInfo>();
  for (const symbol of symbols) {
    const key = symbol.canonical.toUpperCase();
    const existing = byCanonical.get(key);
    if (!existing || (!existing.enabled && symbol.enabled)) byCanonical.set(key, symbol);
  }
  return [...byCanonical.values()];
}

export const __testables = { serializeAccount, dedupeByCanonical };
