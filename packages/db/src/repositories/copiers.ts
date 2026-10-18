import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_FOLLOWER_SETTINGS,
  followerSettingsSchema,
  symbolOverrideSchema,
  applySymbolOverride,
  type CopierStatus,
  type FollowerSettings,
  type RiskType,
  type SymbolOverride,
} from '@trade-copier/contracts';
import type { Database } from '../client.js';
import { id } from '../ids.js';
import { copierFollowers, copiers, followerSymbolOverrides, symbolMappings } from '../schema/tables.js';
import { fromNum, fromNumRequired, toNum, toNumOrNull } from '../values.js';

export interface CopierRecord {
  id: string;
  userId: string;
  name: string;
  masterAccountId: string;
  status: CopierStatus;
  pausedUntil: Date | null;
  masterBalanceAtCreation: number | null;
  copyExistingTradesRequested: boolean;
  lastReconciledAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowerRecord {
  id: string;
  copierId: string;
  accountId: string;
  enabled: boolean;
  riskType: RiskType;
  riskValue: number;
  settings: FollowerSettings;
  suffixPreference: string | null;
  pausedUntil: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowerWithOverrides extends FollowerRecord {
  overrides: Record<string, SymbolOverride>;
  mappings: Record<string, string>;
  /** Settings with the symbol override applied. */
  settingsFor(masterSymbol: string): FollowerSettings;
}

export class CopierRepository {
  constructor(private readonly db: Database) {}

  // --- copiers -------------------------------------------------------------

  async create(input: {
    userId: string;
    name: string;
    masterAccountId: string;
    status?: CopierStatus;
    masterBalanceAtCreation?: number | null;
    copyExistingTradesRequested?: boolean;
  }): Promise<CopierRecord> {
    const [row] = await this.db
      .insert(copiers)
      .values({
        id: id('copier'),
        userId: input.userId,
        name: input.name,
        masterAccountId: input.masterAccountId,
        status: input.status ?? 'disabled',
        masterBalanceAtCreation: fromNum(input.masterBalanceAtCreation ?? null),
        copyExistingTradesRequested: input.copyExistingTradesRequested ?? false,
      })
      .returning();
    return toCopierRecord(row!);
  }

  async findById(copierId: string): Promise<CopierRecord | null> {
    const [row] = await this.db
      .select()
      .from(copiers)
      .where(and(eq(copiers.id, copierId), isNull(copiers.deletedAt)))
      .limit(1);
    return row ? toCopierRecord(row) : null;
  }

  async listByUser(userId: string): Promise<CopierRecord[]> {
    const rows = await this.db
      .select()
      .from(copiers)
      .where(and(eq(copiers.userId, userId), isNull(copiers.deletedAt)))
      .orderBy(asc(copiers.createdAt));
    return rows.map(toCopierRecord);
  }

  /** Copiers whose master is one of the given accounts (the fan-out index). */
  async listActiveByMasterAccounts(accountIds: readonly string[]): Promise<CopierRecord[]> {
    if (accountIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(copiers)
      .where(
        and(
          inArray(copiers.masterAccountId, [...accountIds]),
          isNull(copiers.deletedAt),
          inArray(copiers.status, ['enabled', 'disabled_monitor_existing', 'paused']),
        ),
      );
    return rows.map(toCopierRecord);
  }

  async update(
    copierId: string,
    patch: Partial<{
      name: string;
      status: CopierStatus;
      pausedUntil: Date | null;
      masterBalanceAtCreation: number | null;
      lastReconciledAt: Date | null;
    }>,
  ): Promise<CopierRecord | null> {
    const { masterBalanceAtCreation, ...rest } = patch;
    const [row] = await this.db
      .update(copiers)
      .set({
        ...rest,
        ...(masterBalanceAtCreation !== undefined ? { masterBalanceAtCreation: fromNum(masterBalanceAtCreation) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(copiers.id, copierId))
      .returning();
    return row ? toCopierRecord(row) : null;
  }

  async softDelete(copierId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .update(copiers)
      .set({ deletedAt: new Date(), status: 'disabled', updatedAt: new Date() })
      .where(and(eq(copiers.id, copierId), eq(copiers.userId, userId), isNull(copiers.deletedAt)))
      .returning({ id: copiers.id });
    return rows.length > 0;
  }

  /** Copiers whose follower is the given account (used by Equity Protection). */
  async listByFollowerAccount(accountId: string): Promise<Array<{ copier: CopierRecord; followerId: string }>> {
    const rows = await this.db
      .select({ copier: copiers, followerId: copierFollowers.id })
      .from(copierFollowers)
      .innerJoin(copiers, eq(copiers.id, copierFollowers.copierId))
      .where(and(eq(copierFollowers.accountId, accountId), isNull(copiers.deletedAt)));
    return rows.map((row) => ({ copier: toCopierRecord(row.copier), followerId: row.followerId }));
  }

  // --- followers -----------------------------------------------------------

  /**
   * Every (copier, follower) pair that is currently allowed to copy, with the
   * owning user and the follower's account id. Used by the reconciler, which
   * has to check live slave positions without loading whole copiers.
   */
  async listActiveFollowerPairs(): Promise<
    Array<{ copierId: string; followerId: string; accountId: string; copierUserId: string }>
  > {
    const rows = await this.db
      .select({
        copierId: copierFollowers.copierId,
        followerId: copierFollowers.id,
        accountId: copierFollowers.accountId,
        copierUserId: copiers.userId,
      })
      .from(copierFollowers)
      .innerJoin(copiers, eq(copiers.id, copierFollowers.copierId))
      .where(and(eq(copierFollowers.enabled, true), isNull(copiers.deletedAt), ne(copiers.status, 'disabled')));
    return rows;
  }

  async addFollower(input: {
    copierId: string;
    accountId: string;
    settings?: Partial<FollowerSettings> | undefined;
    enabled?: boolean;
    suffixPreference?: string | null;
  }): Promise<FollowerRecord> {
    const settings = followerSettingsSchema.parse(input.settings ?? {});
    const [row] = await this.db
      .insert(copierFollowers)
      .values({
        id: id('follower'),
        copierId: input.copierId,
        accountId: input.accountId,
        enabled: input.enabled ?? settings.enabled,
        riskType: settings.riskType,
        riskValue: fromNumRequired(settings.riskValue),
        settings,
        suffixPreference: input.suffixPreference ?? null,
      })
      .returning();
    return toFollowerRecord(row!);
  }

  async findFollower(followerId: string): Promise<FollowerRecord | null> {
    const [row] = await this.db.select().from(copierFollowers).where(eq(copierFollowers.id, followerId)).limit(1);
    return row ? toFollowerRecord(row) : null;
  }

  async listFollowers(copierId: string): Promise<FollowerRecord[]> {
    const rows = await this.db
      .select()
      .from(copierFollowers)
      .where(eq(copierFollowers.copierId, copierId))
      .orderBy(asc(copierFollowers.createdAt));
    return rows.map(toFollowerRecord);
  }

  /** Followers with their overrides and mappings, plus a merge helper. */
  async listFollowersResolved(copierId: string): Promise<FollowerWithOverrides[]> {
    const followers = await this.listFollowers(copierId);
    if (followers.length === 0) return [];
    const followerIds = followers.map((follower) => follower.id);

    const overrideRows = await this.db
      .select()
      .from(followerSymbolOverrides)
      .where(inArray(followerSymbolOverrides.followerId, followerIds));
    const mappingRows = await this.db
      .select()
      .from(symbolMappings)
      .where(inArray(symbolMappings.followerId, followerIds));

    const overridesByFollower = new Map<string, Record<string, SymbolOverride>>();
    for (const row of overrideRows) {
      const parsed = symbolOverrideSchema.safeParse({ masterSymbol: row.masterSymbol, settings: row.settings });
      if (!parsed.success) continue;
      const bucket = overridesByFollower.get(row.followerId) ?? {};
      bucket[row.masterSymbol] = parsed.data;
      overridesByFollower.set(row.followerId, bucket);
    }

    const mappingsByFollower = new Map<string, Record<string, string>>();
    for (const row of mappingRows) {
      const bucket = mappingsByFollower.get(row.followerId) ?? {};
      bucket[row.masterSymbol] = row.slaveSymbol;
      mappingsByFollower.set(row.followerId, bucket);
    }

    return followers.map((follower) => {
      const overrides = overridesByFollower.get(follower.id) ?? {};
      return {
        ...follower,
        overrides,
        mappings: mappingsByFollower.get(follower.id) ?? {},
        settingsFor(masterSymbol: string): FollowerSettings {
          return applySymbolOverride(follower.settings, overrides[masterSymbol]);
        },
      };
    });
  }

  async updateFollower(
    followerId: string,
    patch: {
      settings?: Partial<FollowerSettings>;
      enabled?: boolean;
      suffixPreference?: string | null;
      pausedUntil?: Date | null;
      lastError?: { code: string; message: string } | null;
    },
  ): Promise<FollowerRecord | null> {
    const current = await this.findFollower(followerId);
    if (!current) return null;
    const mergedSettings = patch.settings
      ? followerSettingsSchema.parse({ ...current.settings, ...patch.settings })
      : current.settings;

    const [row] = await this.db
      .update(copierFollowers)
      .set({
        ...(patch.settings ? { settings: mergedSettings, riskType: mergedSettings.riskType, riskValue: fromNumRequired(mergedSettings.riskValue) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.suffixPreference !== undefined ? { suffixPreference: patch.suffixPreference } : {}),
        ...(patch.pausedUntil !== undefined ? { pausedUntil: patch.pausedUntil } : {}),
        ...(patch.lastError !== undefined
          ? { lastErrorCode: patch.lastError?.code ?? null, lastErrorMessage: patch.lastError?.message ?? null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(copierFollowers.id, followerId))
      .returning();
    return row ? toFollowerRecord(row) : null;
  }

  async removeFollower(followerId: string): Promise<boolean> {
    const rows = await this.db.delete(copierFollowers).where(eq(copierFollowers.id, followerId)).returning({ id: copierFollowers.id });
    return rows.length > 0;
  }

  async markFollowerEvent(followerId: string): Promise<void> {
    await this.db.update(copierFollowers).set({ lastEventAt: new Date() }).where(eq(copierFollowers.id, followerId));
  }

  // --- symbol mappings -----------------------------------------------------

  async upsertMapping(input: {
    followerId: string;
    masterSymbol: string;
    slaveSymbol: string;
    source?: 'auto' | 'manual';
    confidence?: number;
  }): Promise<void> {
    await this.db
      .insert(symbolMappings)
      .values({
        id: id('mapping'),
        followerId: input.followerId,
        masterSymbol: input.masterSymbol,
        slaveSymbol: input.slaveSymbol,
        source: input.source ?? 'manual',
        confidence: fromNumRequired(input.confidence ?? 1),
      })
      .onConflictDoUpdate({
        target: [symbolMappings.followerId, symbolMappings.masterSymbol],
        set: {
          slaveSymbol: input.slaveSymbol,
          source: input.source ?? 'manual',
          confidence: fromNumRequired(input.confidence ?? 1),
          updatedAt: new Date(),
        },
      });
  }

  async bulkUpsertMappings(
    followerId: string,
    mappings: ReadonlyArray<{ masterSymbol: string; slaveSymbol: string; source?: 'auto' | 'manual'; confidence?: number }>,
  ): Promise<number> {
    if (mappings.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      for (const mapping of mappings) {
        await tx
          .insert(symbolMappings)
          .values({
            id: id('mapping'),
            followerId,
            masterSymbol: mapping.masterSymbol,
            slaveSymbol: mapping.slaveSymbol,
            source: mapping.source ?? 'auto',
            confidence: fromNumRequired(mapping.confidence ?? 1),
          })
          .onConflictDoUpdate({
            target: [symbolMappings.followerId, symbolMappings.masterSymbol],
            set: {
              slaveSymbol: mapping.slaveSymbol,
              source: mapping.source ?? 'auto',
              confidence: fromNumRequired(mapping.confidence ?? 1),
              updatedAt: new Date(),
            },
          });
      }
      return mappings.length;
    });
  }

  async listMappings(followerId: string) {
    return this.db
      .select()
      .from(symbolMappings)
      .where(eq(symbolMappings.followerId, followerId))
      .orderBy(asc(symbolMappings.masterSymbol));
  }

  async deleteMapping(followerId: string, masterSymbol: string): Promise<boolean> {
    const rows = await this.db
      .delete(symbolMappings)
      .where(and(eq(symbolMappings.followerId, followerId), eq(symbolMappings.masterSymbol, masterSymbol)))
      .returning({ id: symbolMappings.id });
    return rows.length > 0;
  }

  /** "Delete all mapped symbols" — documented bulk action. */
  async deleteAllMappings(followerId: string): Promise<number> {
    const rows = await this.db
      .delete(symbolMappings)
      .where(eq(symbolMappings.followerId, followerId))
      .returning({ id: symbolMappings.id });
    return rows.length;
  }

  // --- per-symbol overrides ------------------------------------------------

  async upsertOverride(followerId: string, override: SymbolOverride): Promise<void> {
    await this.db
      .insert(followerSymbolOverrides)
      .values({
        id: id('override'),
        followerId,
        masterSymbol: override.masterSymbol,
        settings: override.settings as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [followerSymbolOverrides.followerId, followerSymbolOverrides.masterSymbol],
        set: { settings: override.settings as Record<string, unknown>, updatedAt: new Date() },
      });
  }

  async listOverrides(followerId: string): Promise<SymbolOverride[]> {
    const rows = await this.db
      .select()
      .from(followerSymbolOverrides)
      .where(eq(followerSymbolOverrides.followerId, followerId))
      .orderBy(asc(followerSymbolOverrides.masterSymbol));
    const out: SymbolOverride[] = [];
    for (const row of rows) {
      const parsed = symbolOverrideSchema.safeParse({ masterSymbol: row.masterSymbol, settings: row.settings });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async deleteOverride(followerId: string, masterSymbol: string): Promise<boolean> {
    const rows = await this.db
      .delete(followerSymbolOverrides)
      .where(and(eq(followerSymbolOverrides.followerId, followerId), eq(followerSymbolOverrides.masterSymbol, masterSymbol)))
      .returning({ id: followerSymbolOverrides.id });
    return rows.length > 0;
  }

  /** Counts copiers per user (entitlement checks). */
  async countByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(copiers)
      .where(and(eq(copiers.userId, userId), isNull(copiers.deletedAt)));
    return row?.count ?? 0;
  }
}

function toCopierRecord(row: typeof copiers.$inferSelect): CopierRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    masterAccountId: row.masterAccountId,
    status: row.status,
    pausedUntil: row.pausedUntil,
    masterBalanceAtCreation: toNumOrNull(row.masterBalanceAtCreation),
    copyExistingTradesRequested: row.copyExistingTradesRequested,
    lastReconciledAt: row.lastReconciledAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFollowerRecord(row: typeof copierFollowers.$inferSelect): FollowerRecord {
  const parsed = followerSettingsSchema.safeParse(row.settings);
  return {
    id: row.id,
    copierId: row.copierId,
    accountId: row.accountId,
    enabled: row.enabled,
    riskType: row.riskType,
    riskValue: toNum(row.riskValue, 100),
    settings: parsed.success ? parsed.data : DEFAULT_FOLLOWER_SETTINGS,
    suffixPreference: row.suffixPreference,
    pausedUntil: row.pausedUntil,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
