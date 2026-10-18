import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_FOLLOWER_SETTINGS,
  applySymbolOverride,
  followerSettingsSchema,
  symbolOverrideSchema,
  type FollowerSettings,
  type SymbolOverride,
} from '@trade-copier/contracts';
import { autoMapSymbols, resolveSymbol } from '@trade-copier/domain';
import { ApiError } from '../lib/errors.js';
import type { CopierRecord, FollowerRecord, FollowerWithOverrides, MasterTradeRecord } from '@trade-copier/db';
import { requireAccount } from './accounts.routes.js';

/**
 * Copiers — the product's central object.
 *
 * A copier pairs one **master** account with N **follower** accounts. Each
 * follower carries its own settings snapshot, its own symbol mappings (the
 * "Symbol Mapping" tab) and its own per-symbol overrides (the "Overrides" tab),
 * so changing one follower's risk never touches another's.
 */

const createCopierSchema = z.object({
  name: z.string().min(1).max(120),
  masterAccountId: z.string().min(1),
  copyExistingTrades: z.boolean().default(false),
  status: z.enum(['enabled', 'disabled', 'disabled_monitor_existing', 'paused']).default('disabled'),
});

const followerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  suffixPreference: z.string().max(20).nullable().optional(),
  settings: followerSettingsSchema.partial().optional(),
});

export const copierRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { repos } = fastify;

  // -------------------------------------------------------------------------
  // copier CRUD
  // -------------------------------------------------------------------------

  fastify.get('/', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const copiers = await repos.copiers.listByUser(userId);
    const accounts = await repos.accounts.listByUser(userId);
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const detailed = await Promise.all(
      copiers.map(async (copier) => {
        const [followers, counts] = await Promise.all([
          repos.copiers.listFollowersResolved(copier.id),
          repos.engine.linkStateCounts(copier.id),
        ]);
        const master = accountById.get(copier.masterAccountId) ?? null;
        return {
          copier: serializeCopier(copier, master ? { label: master.label, status: master.status, online: fastify.engine.hub.isAccountOnline(master.id) } : null),
          followerCount: followers.length,
          enabledFollowerCount: followers.filter((follower) => follower.enabled).length,
          followers: followers.map((follower) => serializeFollowerSummary(follower, accountById.get(follower.accountId) ?? null, fastify.engine.hub.isAccountOnline(follower.accountId))),
          linkStateCounts: counts,
        };
      }),
    );

    return { copiers: detailed };
  });

  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const body = createCopierSchema.parse(request.body);
    const master = await requireAccount(fastify, userId, body.masterAccountId);

    if (master.role === 'slave') throw ApiError.badRequest('That account is configured as a follower-only account');

    const copier = await repos.copiers.create({
      userId,
      name: body.name,
      masterAccountId: body.masterAccountId,
      status: body.status,
      masterBalanceAtCreation: master.balance,
      copyExistingTradesRequested: body.copyExistingTrades,
    });
    if (body.copyExistingTrades) {
      fastify.engine.hub.requestSnapshot(body.masterAccountId, ['positions']);
    }
    await repos.platform.audit({
      userId,
      action: 'copier.created',
      entityType: 'copier',
      entityId: copier.id,
      meta: { masterAccountId: body.masterAccountId, copyExistingTrades: body.copyExistingTrades },
      ip: request.ip,
    });
    return reply.status(201).send({ copier: serializeCopier(copier, { label: master.label, status: master.status, online: fastify.engine.hub.isAccountOnline(master.id) }) });
  });

  fastify.get('/:copierId', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);

    const [followers, masterTrades, mappingsByFollower, accounts, logs] = await Promise.all([
      repos.copiers.listFollowersResolved(copierId),
      repos.engine.listMasterTradesForCopier(copierId, 200),
      Promise.all([repos.copiers.listFollowers(copierId)]).then(async ([list]) =>
        new Map(await Promise.all(list.map(async (follower) => [follower.id, await repos.copiers.listMappings(follower.id)] as const))),
      ),
      repos.accounts.listByUser(copier.userId),
      repos.engine.listLogs({ userId: copier.userId, copierId, limit: 50 }),
    ]);
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const master = accountById.get(copier.masterAccountId) ?? null;

    return {
      copier: serializeCopier(copier, master ? { label: master.label, status: master.status, online: fastify.engine.hub.isAccountOnline(master.id) } : null),
      followers: followers.map((follower) => {
        const account = accountById.get(follower.accountId) ?? null;
        return {
          ...serializeFollowerSummary(follower, account, fastify.engine.hub.isAccountOnline(follower.accountId)),
          settings: follower.settings,
          overrides: follower.overrides,
          mappings: mappingsByFollower.get(follower.id) ?? [],
        };
      }),
      masterTrades: masterTrades.map((trade) => serializeMasterTrade(trade, accountById.get(trade.accountId) ?? null)),
      logs,
      linkStateCounts: await repos.engine.linkStateCounts(copierId),
    };
  });

  fastify.patch('/:copierId', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        status: z.enum(['enabled', 'disabled', 'disabled_monitor_existing', 'paused']).optional(),
        pausedUntil: z.string().datetime().nullable().optional(),
        copyExistingTrades: z.boolean().optional(),
      })
      .parse(request.body);

    const updated = await repos.copiers.update(copierId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.pausedUntil !== undefined ? { pausedUntil: body.pausedUntil ? new Date(body.pausedUntil) : null } : {}),
      ...(body.copyExistingTrades !== undefined ? { copyExistingTradesRequested: body.copyExistingTrades } : {}),
    });
    if (!updated) throw ApiError.notFound('Copier not found');

    if (body.status && body.status !== copier.status) {
      await repos.engine.log({
        copierId,
        level: 'info',
        code: 'COPIER_STATUS_CHANGED',
        message:
          body.status === 'disabled_monitor_existing'
            ? 'Copier set to "Disabled – Monitor Existing": new trades are ignored, closes are still mirrored'
            : `Copier status changed to ${body.status}`,
        context: { from: copier.status, to: body.status },
      });
      if (body.status === 'enabled') fastify.engine.hub.requestSnapshot(copier.masterAccountId, ['positions']);
      publishCopierUpdate(fastify, copier.userId, copierId, body.status);
    }

    return { copier: serializeCopier(updated, null) };
  });

  fastify.delete('/:copierId', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const deleted = await repos.copiers.softDelete(copierId, copier.userId);
    if (!deleted) throw ApiError.notFound('Copier not found');
    await repos.platform.audit({ userId: copier.userId, action: 'copier.deleted', entityType: 'copier', entityId: copierId, ip: request.ip });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // followers
  // -------------------------------------------------------------------------

  fastify.post('/:copierId/followers', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, userId, copierId);
    const body = z
      .object({
        accountId: z.string().min(1),
        enabled: z.boolean().optional(),
        suffixPreference: z.string().max(20).nullable().optional(),
        settings: followerSettingsSchema.partial().optional(),
      })
      .parse(request.body);

    const account = await requireAccount(fastify, userId, body.accountId);
    if (account.id === copier.masterAccountId) {
      throw ApiError.badRequest('An account cannot follow itself');
    }
    const existing = await repos.copiers.listFollowers(copierId);
    if (existing.some((follower) => follower.accountId === account.id)) {
      throw ApiError.conflict('That account already follows this copier');
    }

    const follower = await repos.copiers.addFollower({
      copierId,
      accountId: account.id,
      settings: body.settings,
      enabled: body.enabled,
      suffixPreference: body.suffixPreference ?? null,
    });

    // Auto-map everything the slave already offers, using the same strategy
    // ladder the runtime resolver uses, then let the user fix the leftovers.
    const [masterSymbols, slaveSymbols, mappings] = await Promise.all([
      repos.accounts.listSymbolNames(copier.masterAccountId),
      repos.accounts.listSymbolNames(account.id),
      repos.copiers.listMappings(follower.id),
    ]);
    const existingMappings = Object.fromEntries(mappings.map((mapping) => [mapping.masterSymbol, mapping.slaveSymbol]));
    const autoMap = autoMapSymbols({
      masterSymbols,
      slaveSymbols,
      existing: existingMappings,
      suffixPreference: body.suffixPreference ?? null,
    });
    if (Object.keys(autoMap.mappings).length > 0) {
      await repos.copiers.bulkUpsertMappings(
        follower.id,
        Object.entries(autoMap.mappings).map(([masterSymbol, slaveSymbol]) => ({ masterSymbol, slaveSymbol, source: 'auto' as const })),
      );
    }

    await repos.engine.log({
      copierId,
      followerId: follower.id,
      accountId: account.id,
      level: 'info',
      code: 'FOLLOWER_ADDED',
      message: `${account.label} now follows this copier (auto-mapped ${Object.keys(autoMap.mappings).length}/${masterSymbols.length} symbols)`,
      context: { strategyStats: autoMap.stats, skipped: autoMap.skipped.length },
    });
    await repos.platform.audit({
      userId,
      action: 'follower.added',
      entityType: 'copier',
      entityId: copierId,
      meta: { accountId: account.id, autoMapped: Object.keys(autoMap.mappings).length, skipped: autoMap.skipped.length },
      ip: request.ip,
    });

    return reply.status(201).send({
      follower: serializeFollower(follower),
      automap: { mapped: Object.keys(autoMap.mappings).length, stats: autoMap.stats, skipped: autoMap.skipped, ambiguousGroups: autoMap.ambiguousGroups },
    });
  });

  fastify.patch('/:copierId/followers/:followerId', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const body = followerPatchSchema.parse(request.body);

    const updated = await repos.copiers.updateFollower(followerId, {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.suffixPreference !== undefined ? { suffixPreference: body.suffixPreference } : {}),
      ...(body.settings ? { settings: body.settings } : {}),
      lastError: null,
    });
    if (!updated) throw ApiError.notFound('Follower not found');

    const riskChanged =
      body.settings !== undefined &&
      (body.settings.riskType !== undefined || body.settings.riskValue !== undefined ||
        body.settings.fixedMasterBalance !== undefined ||
        body.settings.riskType === 'FIXED_PERCENT_RISK');

    if (body.enabled !== undefined || riskChanged) {
      await repos.engine.log({
        copierId,
        followerId,
        accountId: follower.accountId,
        level: 'info',
        code: riskChanged ? 'FOLLOWER_SETTINGS_CHANGED' : body.enabled ? 'FOLLOWER_ENABLED' : 'FOLLOWER_DISABLED',
        message: riskChanged
          ? `Risk settings updated to ${updated.settings.riskType} @ ${updated.settings.riskValue}%`
          : body.enabled
            ? 'Copying enabled for this account'
            : 'Copying disabled for this account',
        context: riskChanged ? { riskType: updated.settings.riskType, riskValue: updated.settings.riskValue } : {},
      });
    }
    return { follower: serializeFollower(updated) };
  });

  fastify.delete('/:copierId/followers/:followerId', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const removed = await repos.copiers.removeFollower(followerId);
    if (!removed) throw ApiError.notFound('Follower not found');
    await repos.engine.log({
      copierId,
      level: 'info',
      code: 'FOLLOWER_REMOVED',
      message: 'Follower removed from copier',
      context: { followerId, accountId: follower.accountId },
    });
    void copier;
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // symbol mappings
  // -------------------------------------------------------------------------

  fastify.get('/:copierId/followers/:followerId/mappings', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const [mappings, masterSymbols, slaveSymbols] = await Promise.all([
      repos.copiers.listMappings(followerId),
      repos.accounts.listSymbolNames(copier.masterAccountId),
      repos.accounts.listSymbolNames(follower.accountId),
    ]);
    const mapped = new Set(mappings.map((mapping) => mapping.masterSymbol));
    return {
      mappings,
      unmapped: masterSymbols.filter((symbol) => !mapped.has(symbol)),
      masterSymbolCount: masterSymbols.length,
      slaveSymbolCount: slaveSymbols.length,
    };
  });

  fastify.put('/:copierId/followers/:followerId/mappings', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const body = z
      .object({
        masterSymbol: z.string().min(1).max(40),
        slaveSymbol: z.string().min(1).max(40),
      })
      .parse(request.body);

    const slaveSymbols = await repos.accounts.listSymbolNames(follower.accountId);
    if (!slaveSymbols.includes(body.slaveSymbol)) {
      throw ApiError.badRequest(`${body.slaveSymbol} is not traded on the follower account`, {
        suggestions: autoMapSymbols({ masterSymbols: [body.masterSymbol], slaveSymbols }).skipped,
      });
    }
    await repos.copiers.upsertMapping({
      followerId,
      masterSymbol: body.masterSymbol,
      slaveSymbol: body.slaveSymbol,
      source: 'manual',
      confidence: 1,
    });
    void copier;
    return { ok: true, mapping: { masterSymbol: body.masterSymbol, slaveSymbol: body.slaveSymbol, source: 'manual' } };
  });

  fastify.post('/:copierId/followers/:followerId/mappings/auto', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const body = z
      .object({
        masterSymbols: z.array(z.string().min(1)).optional(),
        overwrite: z.boolean().default(false),
      })
      .parse(request.body ?? {});

    const [masterSymbols, slaveSymbols, existingRows] = await Promise.all([
      body.masterSymbols && body.masterSymbols.length > 0 ? body.masterSymbols : repos.accounts.listSymbolNames(copier.masterAccountId),
      repos.accounts.listSymbolNames(follower.accountId),
      repos.copiers.listMappings(followerId),
    ]);
    const existing = Object.fromEntries(existingRows.map((mapping) => [mapping.masterSymbol, mapping.slaveSymbol]));
    const result = autoMapSymbols({
      masterSymbols,
      slaveSymbols,
      existing,
      suffixPreference: follower.suffixPreference,
      overwrite: body.overwrite,
    });

    if (Object.keys(result.mappings).length > 0) {
      await repos.copiers.bulkUpsertMappings(
        followerId,
        Object.entries(result.mappings).map(([masterSymbol, slaveSymbol]) => ({ masterSymbol, slaveSymbol, source: 'auto' as const })),
      );
    }
    await repos.engine.log({
      copierId,
      followerId,
      accountId: follower.accountId,
      level: 'info',
      code: 'SYMBOL_AUTOMAP',
      message: `Auto-mapped ${result.stats.matched}/${result.stats.total} symbols`,
      context: { stats: result.stats, skipped: result.skipped.length, overwrite: body.overwrite },
    });
    return { automap: result };
  });

  fastify.delete('/:copierId/followers/:followerId/mappings/:masterSymbol', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId, masterSymbol } = request.params as { copierId: string; followerId: string; masterSymbol: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    await requireFollower(fastify, copierId, followerId);
    const deleted = await repos.copiers.deleteMapping(followerId, masterSymbol);
    if (!deleted) throw ApiError.notFound('Mapping not found');
    return { ok: true };
  });

  /** "Delete all mapped symbols" — documented bulk action. */
  fastify.delete('/:copierId/followers/:followerId/mappings', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    await requireFollower(fastify, copierId, followerId);
    const deleted = await repos.copiers.deleteAllMappings(followerId);
    return { ok: true, deleted };
  });

  // -------------------------------------------------------------------------
  // per-symbol overrides
  // -------------------------------------------------------------------------

  fastify.get('/:copierId/followers/:followerId/overrides', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const overrides = await repos.copiers.listOverrides(followerId);
    return {
      baseSettings: follower.settings,
      overrides,
      effective: Object.fromEntries(overrides.map((override) => [override.masterSymbol, mergeOverride(follower.settings, override)])),
    };
  });

  fastify.put('/:copierId/followers/:followerId/overrides', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId } = request.params as { copierId: string; followerId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const follower = await requireFollower(fastify, copierId, followerId);
    const body = symbolOverrideSchema.parse(request.body);

    const masterSymbols = await repos.accounts.listSymbolNames(copier.masterAccountId);
    if (!masterSymbols.includes(body.masterSymbol)) {
      throw ApiError.badRequest(`${body.masterSymbol} is not a symbol on the master account`, {
        suggestions: masterSymbols.filter((symbol) => symbol.toUpperCase().startsWith(body.masterSymbol.slice(0, 3).toUpperCase())).slice(0, 10),
      });
    }
    await repos.copiers.upsertOverride(followerId, body);
    await repos.engine.log({
      copierId,
      followerId,
      accountId: follower.accountId,
      level: 'info',
      code: 'SYMBOL_OVERRIDE',
      message: `Override saved for ${body.masterSymbol}`,
      context: { override: body },
    });
    return { ok: true, override: body };
  });

  fastify.delete('/:copierId/followers/:followerId/overrides/:masterSymbol', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId, followerId, masterSymbol } = request.params as { copierId: string; followerId: string; masterSymbol: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    await requireFollower(fastify, copierId, followerId);
    const deleted = await repos.copiers.deleteOverride(followerId, masterSymbol);
    if (!deleted) throw ApiError.notFound('Override not found');
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // trades + status
  // -------------------------------------------------------------------------

  fastify.get('/:copierId/trades', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const query = z
      .object({ state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);

    const trades = await repos.engine.listMasterTradesForCopier(copierId, query.limit);
    const filtered = query.state === 'all' ? trades : trades.filter((trade) => (query.state === 'open' ? trade.state === 'open' : trade.state !== 'open'));
    const followers = await repos.copiers.listFollowersResolved(copierId);
    const accounts = await repos.accounts.listByUser((await requireCopier(fastify, request.accessClaims!.sub, copierId)).userId);
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    return {
      trades: await Promise.all(
        filtered.map(async (trade) => {
          const links = await repos.engine.listLinksByMasterTrade(trade.id);
          return {
            ...serializeMasterTrade(trade, accountById.get(trade.accountId) ?? null),
            links: links
              .filter((link) => followers.some((follower) => follower.id === link.followerId))
              .map((link) => ({
                followerId: link.followerId,
                followerLabel: accountById.get(link.slaveAccountId)?.label ?? link.slaveAccountId,
                slaveSymbol: link.slaveSymbol,
                slaveTicket: link.slaveTicket,
                state: link.state,
                requestedVolume: link.requestedVolume,
                filledVolume: link.filledVolume,
                filledPrice: link.filledPrice,
                lastErrorCode: link.errorCode,
                lastErrorMessage: link.errorMessage,
                openedAt: link.openedAt?.toISOString() ?? null,
                closedAt: link.closedAt?.toISOString() ?? null,
              })),
          };
        }),
      ),
    };
  });

  /** The product's per-follower status light, computed instead of guessed. */
  fastify.get('/:copierId/status', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    const copier = await requireCopier(fastify, request.accessClaims!.sub, copierId);
    const followers = await repos.copiers.listFollowersResolved(copierId);
    const accounts = await repos.accounts.listByUser(copier.userId);
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const master = accountById.get(copier.masterAccountId) ?? null;
    const masterOnline = master ? fastify.engine.hub.isAccountOnline(master.id) : false;

    return {
      copierStatus: copier.status,
      master: master
        ? { accountId: master.id, label: master.label, online: fastify.engine.hub.isAccountOnline(master.id), lastErrorCode: master.lastErrorCode }
        : null,
      followers: followers.map((follower) => {
        const account = accountById.get(follower.accountId) ?? null;
        const online = fastify.engine.hub.isAccountOnline(follower.accountId);
        const blockedReason = describeBlockedReason(follower, copier, masterOnline, online);
        return {
          followerId: follower.id,
          accountId: follower.accountId,
          label: account?.label ?? follower.accountId,
          enabled: follower.enabled,
          effectiveStatus: blockedReason ? 'blocked' : follower.enabled && copier.status !== 'disabled' ? 'active' : 'inactive',
          blockedReason,
          lastErrorCode: follower.lastErrorCode,
          lastErrorMessage: follower.lastErrorMessage,
          lastEventAt: follower.lastEventAt?.toISOString() ?? null,
        };
      }),
    };
  });

  /** Queue an immediate reconciliation for this copier's followers. */
  fastify.post('/:copierId/reconcile', { preHandler: fastify.authenticate }, async (request) => {
    const { copierId } = request.params as { copierId: string };
    await requireCopier(fastify, request.accessClaims!.sub, copierId);
    await fastify.engine.jobs.schedule('reconcile', new Date(Date.now() + 500));
    return { ok: true, message: 'Reconciliation queued; results appear in the execution log.' };
  });
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export async function requireCopier(fastify: FastifyInstance, userId: string, copierId: string): Promise<CopierRecord> {
  const copier = await fastify.repos.copiers.findById(copierId);
  if (!copier) throw ApiError.notFound('Copier not found');
  if (copier.userId !== userId) throw ApiError.forbidden('You do not have access to this copier');
  return copier;
}

async function requireFollower(fastify: FastifyInstance, copierId: string, followerId: string): Promise<FollowerRecord> {
  const follower = await fastify.repos.copiers.findFollower(followerId);
  if (!follower || follower.copierId !== copierId) throw ApiError.notFound('Follower not found');
  return follower;
}

export function serializeCopier(
  copier: CopierRecord,
  master: { label: string; status: string; online: boolean } | null,
) {
  return {
    id: copier.id,
    name: copier.name,
    masterAccountId: copier.masterAccountId,
    master,
    status: copier.status,
    pausedUntil: copier.pausedUntil?.toISOString() ?? null,
    copyExistingTradesRequested: copier.copyExistingTradesRequested,
    lastReconciledAt: copier.lastReconciledAt?.toISOString() ?? null,
    createdAt: copier.createdAt.toISOString(),
    updatedAt: copier.updatedAt.toISOString(),
  };
}

export function serializeFollowerSummary(
  follower: FollowerWithOverrides | FollowerRecord,
  account: { id: string; label: string; login: string; server: string; currency: string; balance: number | null; equity: number | null } | null,
  online: boolean,
) {
  return {
    followerId: follower.id,
    accountId: follower.accountId,
    label: account?.label ?? follower.accountId,
    login: account?.login ?? null,
    server: account?.server ?? null,
    currency: account?.currency ?? null,
    balance: account?.balance ?? null,
    equity: account?.equity ?? null,
    online,
    enabled: follower.enabled,
    riskType: follower.settings.riskType,
    riskValue: follower.settings.riskValue,
    riskLabel: describeRisk(follower.settings),
    reverseTrade: follower.settings.reverseTrade,
    suffixPreference: follower.suffixPreference,
    lastErrorCode: follower.lastErrorCode,
    lastErrorMessage: follower.lastErrorMessage,
    lastEventAt: follower.lastEventAt?.toISOString() ?? null,
  };
}

export function serializeFollower(follower: FollowerRecord) {
  return {
    followerId: follower.id,
    copierId: follower.copierId,
    accountId: follower.accountId,
    enabled: follower.enabled,
    settings: follower.settings,
    riskLabel: describeRisk(follower.settings),
    suffixPreference: follower.suffixPreference,
    lastErrorCode: follower.lastErrorCode,
    lastErrorMessage: follower.lastErrorMessage,
    createdAt: follower.createdAt.toISOString(),
    updatedAt: follower.updatedAt.toISOString(),
  };
}

function serializeMasterTrade(trade: MasterTradeRecord, account: { label: string } | null) {
  return {
    ticket: trade.ticket,
    accountLabel: account?.label ?? null,
    symbol: trade.symbol,
    side: trade.side,
    volume: trade.volume,
    openPrice: trade.openPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    state: trade.state,
    comment: trade.comment,
    magic: trade.magic,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt?.toISOString() ?? null,
  };
}

export function describeRisk(settings: FollowerSettings): string {
  const percent = (value: number) => `${value}%`;
  switch (settings.riskType) {
    case 'LOT_MULTIPLIER':
      return `${settings.riskValue}× master lot`;
    case 'FIXED_LOT':
      return `${settings.riskValue} lots per trade`;
    case 'BALANCE_MULTIPLIER':
      return `${settings.riskValue}× balance ratio`;
    case 'FIXED_BALANCE_MULTIPLIER':
      return `ratio against fixed master balance${settings.fixedMasterBalance ? ` (${settings.fixedMasterBalance})` : ''}`;
    case 'FIXED_PERCENT_RISK':
      return settings.riskValue === 100 ? '1:1' : percent(settings.riskValue);
    default:
      return String(settings.riskType);
  }
}

function describeBlockedReason(
  follower: FollowerRecord,
  copier: CopierRecord,
  masterOnline: boolean,
  slaveOnline: boolean,
): string | null {
  if (copier.status === 'paused') return 'Copier is paused';
  if (copier.status === 'disabled_monitor_existing') return 'Monitoring existing trades only (new trades ignored)';
  if (copier.status === 'disabled') return 'Copier is disabled';
  if (!follower.enabled) return 'Copying is disabled for this account';
  if (!masterOnline) return 'Master account is offline';
  if (!slaveOnline) return 'Follower account is offline';
  if (follower.pausedUntil && follower.pausedUntil.getTime() > Date.now()) {
    return `Paused until ${follower.pausedUntil.toISOString()}`;
  }
  if (follower.lastErrorCode) return `Last error: ${follower.lastErrorCode}`;
  return null;
}

/** Settings a follower would actually run with for one master symbol. */
export function mergeOverride(base: FollowerSettings, override: SymbolOverride): FollowerSettings {
  return applySymbolOverride(base, override);
}

function publishCopierUpdate(fastify: FastifyInstance, userId: string, copierId: string, status: string): void {
  fastify.ui.publish(userId, 'copiers', {
    type: 'copier.updated',
    copierId,
    status: status as 'enabled' | 'disabled' | 'disabled_monitor_existing' | 'paused',
    followerStates: [],
    at: new Date().toISOString(),
  });
}

export const __testables = { describeRisk, describeBlockedReason, mergeOverride, DEFAULT_FOLLOWER_SETTINGS, resolveSymbol };
