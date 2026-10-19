import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { AccountKind, AccountSnapshot, AccountStatus, AssetClass, Platform, SymbolInfo } from '@trade-copier/contracts';
import { normalizeSymbol, classifyAssetClass, derivePipSize } from '@trade-copier/domain';
import type { Database } from '../client.js';
import { id, newToken } from '../ids.js';
import { accountCredentials, accountShares, accountSymbols, bridgeAgents, tradingAccounts } from '../schema/tables.js';
import { fromNum, toNum, toNumOrNull } from '../values.js';

export interface AccountRecord {
  id: string;
  userId: string;
  label: string;
  platform: Platform;
  login: string;
  server: string;
  brokerName: string | null;
  kind: AccountKind;
  /** master / slave / both — drives which pickers an account appears in. */
  role: 'master' | 'slave' | 'both';
  currency: string;
  leverage: number | null;
  status: AccountStatus;
  enabled: boolean;
  agentId: string | null;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  equityUpdatedAt: Date | null;
  referenceBalance: number | null;
  referenceBalanceAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  capabilities: Record<string, boolean>;
  metadata: Record<string, unknown>;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccountInput {
  userId: string;
  label: string;
  platform: Platform;
  login: string;
  server: string;
  brokerName?: string | null;
  kind?: AccountKind;
  currency?: string;
  leverage?: number | null;
  agentId?: string | null;
  role?: 'master' | 'slave' | 'both';
  capabilities?: Record<string, boolean>;
}

export interface SymbolUpsert {
  name: string;
  canonical: string;
  assetClass: string;
  digits: number;
  point: number;
  pipSize: number;
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  maxLotPerOrder?: number | null;
  quoteCurrency: string;
  tradeMode: string;
  swapLong?: number | null;
  swapShort?: number | null;
}

export class AccountRepository {
  constructor(private readonly db: Database) {}

  // --- accounts ------------------------------------------------------------

  async create(input: CreateAccountInput): Promise<AccountRecord> {
    const [row] = await this.db
      .insert(tradingAccounts)
      .values({
        id: id('account'),
        userId: input.userId,
        label: input.label,
        platform: input.platform,
        login: input.login,
        server: input.server,
        brokerName: input.brokerName ?? null,
        kind: input.kind ?? 'live',
        currency: input.currency ?? 'USD',
        leverage: input.leverage ?? null,
        agentId: input.agentId ?? null,
        role: input.role ?? 'both',
        capabilities: input.capabilities ?? {},
        status: 'connecting',
      })
      .returning();
    return toAccountRecord(row as RawAccount);
  }

  async findById(accountId: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.id, accountId), isNull(tradingAccounts.deletedAt)))
      .limit(1);
    return row ? toAccountRecord(row as RawAccount) : null;
  }

  async listByUser(userId: string): Promise<AccountRecord[]> {
    const rows = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.userId, userId), isNull(tradingAccounts.deletedAt)))
      .orderBy(asc(tradingAccounts.createdAt));
    return rows.map((row) => toAccountRecord(row as RawAccount));
  }

  /** Accounts this user can act on: owned plus shared with copier/manager rights. */
  async listAccessible(userId: string): Promise<AccountRecord[]> {
    const owned = await this.listByUser(userId);
    // Joined through the query builder rather than raw SQL: a raw `select a.*`
    // returns snake_case keys, and every `toAccountRecord` field would come
    // back undefined.
    const shared = await this.db
      .select({ account: tradingAccounts })
      .from(tradingAccounts)
      .innerJoin(accountShares, eq(accountShares.accountId, tradingAccounts.id))
      .where(
        and(
          eq(accountShares.granteeUserId, userId),
          eq(accountShares.status, 'active'),
          isNull(tradingAccounts.deletedAt),
        ),
      )
      .orderBy(asc(tradingAccounts.createdAt));

    const ownedIds = new Set(owned.map((account) => account.id));
    return [
      ...owned,
      ...shared.map((row) => toAccountRecord(row.account as RawAccount)).filter((account) => !ownedIds.has(account.id)),
    ];
  }

  async findByPlatformLogin(platform: Platform, login: string, server: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.platform, platform),
          eq(tradingAccounts.login, login),
          eq(tradingAccounts.server, server),
          isNull(tradingAccounts.deletedAt),
        ),
      )
      .limit(1);
    return row ? toAccountRecord(row as RawAccount) : null;
  }

  async update(
    accountId: string,
    patch: Partial<{
      label: string;
      enabled: boolean;
      status: AccountStatus;
      brokerName: string | null;
      currency: string;
      leverage: number | null;
      agentId: string | null;
      capabilities: Record<string, boolean>;
      metadata: Record<string, unknown>;
    }>,
  ): Promise<AccountRecord | null> {
    const [row] = await this.db
      .update(tradingAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tradingAccounts.id, accountId))
      .returning();
    return row ? toAccountRecord(row as RawAccount) : null;
  }

  async softDelete(accountId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .update(tradingAccounts)
      .set({ deletedAt: new Date(), status: 'disabled', enabled: false, updatedAt: new Date() })
      .where(and(eq(tradingAccounts.id, accountId), eq(tradingAccounts.userId, userId), isNull(tradingAccounts.deletedAt)))
      .returning({ id: tradingAccounts.id });
    return rows.length > 0;
  }

  async listByAgent(agentId: string): Promise<AccountRecord[]> {
    const rows = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.agentId, agentId), isNull(tradingAccounts.deletedAt)))
      .orderBy(asc(tradingAccounts.createdAt));
    return rows.map((row) => toAccountRecord(row as RawAccount));
  }

  async listAllConnected(): Promise<AccountRecord[]> {
    const rows = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.status, 'connected'), isNull(tradingAccounts.deletedAt)));
    return rows.map((row) => toAccountRecord(row as RawAccount));
  }

  /** Records a balance/equity tick coming from the bridge agent. */
  async applySnapshot(accountId: string, snapshot: AccountSnapshot): Promise<void> {
    await this.db
      .update(tradingAccounts)
      .set({
        balance: fromNum(snapshot.balance),
        equity: fromNum(snapshot.equity),
        margin: fromNum(snapshot.margin),
        freeMargin: fromNum(snapshot.freeMargin),
        marginLevel: fromNum(snapshot.marginLevel),
        currency: snapshot.currency,
        leverage: snapshot.leverage ?? null,
        equityUpdatedAt: new Date(snapshot.at),
        status: 'connected',
        lastHeartbeatAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(tradingAccounts.id, accountId));
  }

  async markStatus(
    accountId: string,
    status: AccountStatus,
    error?: { code: string | null; message: string | null },
  ): Promise<void> {
    await this.db
      .update(tradingAccounts)
      .set({
        status,
        lastErrorCode: error?.code ?? null,
        lastErrorMessage: error?.message ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tradingAccounts.id, accountId));
  }

  async touchHeartbeat(accountId: string, at = new Date()): Promise<void> {
    await this.db.update(tradingAccounts).set({ lastHeartbeatAt: at }).where(eq(tradingAccounts.id, accountId));
  }

  /** Accounts whose agent stopped reporting — used by the heartbeat monitor. */
  async findStale(thresholdMs: number): Promise<AccountRecord[]> {
    const rows = await this.db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.status, 'connected'),
          isNull(tradingAccounts.deletedAt),
          sql`(${tradingAccounts.lastHeartbeatAt} is null or ${tradingAccounts.lastHeartbeatAt} < now() - (${thresholdMs}::int * interval '1 millisecond'))`,
        ),
      );
    return rows.map((row) => toAccountRecord(row as RawAccount));
  }

  async setDailyReference(accountId: string, balance: number, at: Date): Promise<void> {
    await this.db
      .update(tradingAccounts)
      .set({ referenceBalance: fromNum(balance), referenceBalanceAt: at, updatedAt: new Date() })
      .where(eq(tradingAccounts.id, accountId));
  }

  // --- credentials ---------------------------------------------------------

  async upsertCredentials(input: {
    accountId: string;
    passwordEncrypted?: string | null;
    investorPasswordEncrypted?: string | null;
    apiTokenEncrypted?: string | null;
  }): Promise<void> {
    await this.db
      .insert(accountCredentials)
      .values({
        id: id('credential'),
        accountId: input.accountId,
        passwordEncrypted: input.passwordEncrypted ?? null,
        investorPasswordEncrypted: input.investorPasswordEncrypted ?? null,
        apiTokenEncrypted: input.apiTokenEncrypted ?? null,
      })
      .onConflictDoUpdate({
        target: accountCredentials.accountId,
        set: {
          ...(input.passwordEncrypted !== undefined ? { passwordEncrypted: input.passwordEncrypted } : {}),
          ...(input.investorPasswordEncrypted !== undefined
            ? { investorPasswordEncrypted: input.investorPasswordEncrypted }
            : {}),
          ...(input.apiTokenEncrypted !== undefined ? { apiTokenEncrypted: input.apiTokenEncrypted } : {}),
          updatedAt: new Date(),
        },
      });
  }

  async getCredentials(accountId: string) {
    const [row] = await this.db
      .select()
      .from(accountCredentials)
      .where(eq(accountCredentials.accountId, accountId))
      .limit(1);
    return row ?? null;
  }

  // --- symbols -------------------------------------------------------------

  /** Replaces the symbol catalogue for an account in one transaction. */
  async replaceSymbols(accountId: string, symbols: readonly SymbolUpsert[]): Promise<number> {
    if (symbols.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      const names = symbols.map((symbol) => symbol.name);
      // Preserve the enabled toggle for symbols that already exist.
      await tx
        .delete(accountSymbols)
        .where(and(eq(accountSymbols.accountId, accountId), notInArray(accountSymbols.name, names)));

      const existing = await tx
        .select({ name: accountSymbols.name, enabled: accountSymbols.enabled })
        .from(accountSymbols)
        .where(eq(accountSymbols.accountId, accountId));
      const enabledByName = new Map(existing.map((row) => [row.name, row.enabled]));

      const chunkSize = 500;
      for (let index = 0; index < symbols.length; index += chunkSize) {
        const chunk = symbols.slice(index, index + chunkSize);
        await tx
          .insert(accountSymbols)
          .values(
            chunk.map((symbol) => ({
              id: id('symbol'),
              accountId,
              name: symbol.name,
              canonical: symbol.canonical,
              assetClass: symbol.assetClass,
              digits: symbol.digits,
              point: fromNum(symbol.point) ?? '0',
              pipSize: fromNum(symbol.pipSize) ?? '0',
              contractSize: fromNum(symbol.contractSize) ?? '0',
              minLot: fromNum(symbol.minLot) ?? '0.01',
              maxLot: fromNum(symbol.maxLot) ?? '100',
              lotStep: fromNum(symbol.lotStep) ?? '0.01',
              maxLotPerOrder: fromNum(symbol.maxLotPerOrder ?? null),
              quoteCurrency: symbol.quoteCurrency,
              tradeMode: symbol.tradeMode,
              enabled: enabledByName.get(symbol.name) ?? true,
              swapLong: fromNum(symbol.swapLong ?? null),
              swapShort: fromNum(symbol.swapShort ?? null),
              updatedAt: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: [accountSymbols.accountId, accountSymbols.name],
            set: {
              canonical: sql`excluded.canonical`,
              assetClass: sql`excluded.asset_class`,
              digits: sql`excluded.digits`,
              point: sql`excluded.point`,
              pipSize: sql`excluded.pip_size`,
              contractSize: sql`excluded.contract_size`,
              minLot: sql`excluded.min_lot`,
              maxLot: sql`excluded.max_lot`,
              lotStep: sql`excluded.lot_step`,
              maxLotPerOrder: sql`excluded.max_lot_per_order`,
              quoteCurrency: sql`excluded.quote_currency`,
              tradeMode: sql`excluded.trade_mode`,
              swapLong: sql`excluded.swap_long`,
              swapShort: sql`excluded.swap_short`,
              updatedAt: new Date(),
            },
          });
      }
      return symbols.length;
    });
  }

  async listSymbols(accountId: string): Promise<SymbolInfo[]> {
    const rows = await this.db
      .select()
      .from(accountSymbols)
      .where(eq(accountSymbols.accountId, accountId))
      .orderBy(asc(accountSymbols.name));
    return rows.map(toSymbolInfo);
  }

  async findSymbol(accountId: string, name: string): Promise<SymbolInfo | null> {
    const [row] = await this.db
      .select()
      .from(accountSymbols)
      .where(and(eq(accountSymbols.accountId, accountId), eq(accountSymbols.name, name)))
      .limit(1);
    return row ? toSymbolInfo(row) : null;
  }

  async listSymbolNames(accountId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: accountSymbols.name })
      .from(accountSymbols)
      .where(eq(accountSymbols.accountId, accountId))
      .orderBy(asc(accountSymbols.name));
    return rows.map((row) => row.name);
  }

  async listDisabledSymbolNames(accountId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: accountSymbols.name })
      .from(accountSymbols)
      .where(and(eq(accountSymbols.accountId, accountId), eq(accountSymbols.enabled, false)));
    return rows.map((row) => row.name);
  }

  async setSymbolEnabled(accountId: string, name: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(accountSymbols)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(accountSymbols.accountId, accountId), eq(accountSymbols.name, name)))
      .returning({ id: accountSymbols.id });
    return rows.length > 0;
  }

  async setSymbolsEnabled(accountId: string, names: readonly string[], enabled: boolean): Promise<number> {
    if (names.length === 0) return 0;
    const rows = await this.db
      .update(accountSymbols)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(accountSymbols.accountId, accountId), inArray(accountSymbols.name, [...names])))
      .returning({ id: accountSymbols.id });
    return rows.length;
  }

  // --- agents --------------------------------------------------------------

  async createAgent(input: { userId: string; name: string }): Promise<{ id: string; secret: string }> {
    const secret = newToken('agent');
    const [row] = await this.db
      .insert(bridgeAgents)
      .values({
        id: id('agent'),
        userId: input.userId,
        name: input.name,
        tokenHash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
        status: 'disconnected',
      })
      .returning({ id: bridgeAgents.id });
    return { id: row!.id, secret };
  }

  async findAgentByToken(token: string) {
    const [row] = await this.db
      .select()
      .from(bridgeAgents)
      .where(and(eq(bridgeAgents.tokenHash, hashToken(token)), isNull(bridgeAgents.revokedAt)))
      .limit(1);
    return row ?? null;
  }

  async listAgents(userId: string) {
    return this.db
      .select({
        id: bridgeAgents.id,
        name: bridgeAgents.name,
        tokenPrefix: bridgeAgents.tokenPrefix,
        status: bridgeAgents.status,
        version: bridgeAgents.version,
        host: bridgeAgents.host,
        lastSeenAt: bridgeAgents.lastSeenAt,
        createdAt: bridgeAgents.createdAt,
      })
      .from(bridgeAgents)
      .where(and(eq(bridgeAgents.userId, userId), isNull(bridgeAgents.revokedAt)))
      .orderBy(desc(bridgeAgents.createdAt));
  }

  async markAgentConnected(agentId: string, info: { version?: string | null; host?: string | null; ip?: string | null }): Promise<void> {
    await this.db
      .update(bridgeAgents)
      .set({
        status: 'connected',
        version: info.version ?? null,
        host: info.host ?? null,
        lastIp: info.ip ?? null,
        connectedAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bridgeAgents.id, agentId));
  }

  async markAgentDisconnected(agentId: string): Promise<void> {
    await this.db
      .update(bridgeAgents)
      .set({ status: 'disconnected', lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(bridgeAgents.id, agentId));
  }

  async touchAgent(agentId: string, queueDepth: number, latencyMs: number | null): Promise<void> {
    await this.db
      .update(bridgeAgents)
      .set({ lastSeenAt: new Date(), queueDepth, latencyMs, updatedAt: new Date() })
      .where(eq(bridgeAgents.id, agentId));
  }

  async revokeAgent(userId: string, agentId: string): Promise<boolean> {
    const rows = await this.db
      .update(bridgeAgents)
      .set({ revokedAt: new Date(), status: 'revoked', updatedAt: new Date() })
      .where(and(eq(bridgeAgents.id, agentId), eq(bridgeAgents.userId, userId)))
      .returning({ id: bridgeAgents.id });
    return rows.length > 0;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface RawAccount {
  id: string;
  userId: string;
  label: string;
  platform: Platform;
  login: string;
  server: string;
  brokerName: string | null;
  kind: AccountKind;
  role: 'master' | 'slave' | 'both';
  currency: string;
  leverage: number | null;
  status: AccountStatus;
  enabled: boolean;
  agentId: string | null;
  balance: string | null;
  equity: string | null;
  margin: string | null;
  freeMargin: string | null;
  marginLevel: string | null;
  equityUpdatedAt: Date | null;
  referenceBalance: string | null;
  referenceBalanceAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  capabilities: Record<string, boolean> | null;
  metadata: Record<string, unknown> | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAccountRecord(row: RawAccount): AccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    platform: row.platform,
    login: row.login,
    server: row.server,
    brokerName: row.brokerName,
    kind: row.kind,
    role: row.role,
    currency: row.currency,
    leverage: row.leverage,
    status: row.status,
    enabled: row.enabled,
    agentId: row.agentId,
    balance: toNumOrNull(row.balance),
    equity: toNumOrNull(row.equity),
    margin: toNumOrNull(row.margin),
    freeMargin: toNumOrNull(row.freeMargin),
    marginLevel: toNumOrNull(row.marginLevel),
    equityUpdatedAt: row.equityUpdatedAt,
    referenceBalance: toNumOrNull(row.referenceBalance),
    referenceBalanceAt: row.referenceBalanceAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    capabilities: row.capabilities ?? {},
    metadata: row.metadata ?? {},
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface RawSymbol {
  name: string;
  canonical: string;
  assetClass: string;
  digits: number;
  point: string;
  pipSize: string;
  contractSize: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  maxLotPerOrder: string | null;
  quoteCurrency: string;
  tradeMode: string;
  enabled: boolean;
  swapLong: string | null;
  swapShort: string | null;
  updatedAt: Date;
}

function toSymbolInfo(row: RawSymbol): SymbolInfo {
  return {
    name: row.name,
    canonical: row.canonical,
    assetClass: (row.assetClass as AssetClass) ?? 'unknown',
    digits: row.digits,
    point: toNum(row.point, derivePipSize(row.digits) * 10),
    pipSize: toNum(row.pipSize, derivePipSize(row.digits)),
    contractSize: toNum(row.contractSize, 100_000),
    minLot: toNum(row.minLot, 0.01),
    maxLot: toNum(row.maxLot, 1000),
    lotStep: toNum(row.lotStep, 0.01),
    maxLotPerOrder: toNumOrNull(row.maxLotPerOrder),
    quoteCurrency: row.quoteCurrency,
    tradeMode: (row.tradeMode as SymbolInfo['tradeMode']) ?? 'full',
    enabled: row.enabled,
    swapLong: toNumOrNull(row.swapLong),
    swapShort: toNumOrNull(row.swapShort),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Builds the symbol upsert payload from a broker-reported SymbolInfo. */
export function toSymbolUpsert(symbol: SymbolInfo): SymbolUpsert {
  const normalized = normalizeSymbol(symbol.name);
  return {
    name: symbol.name,
    canonical: symbol.canonical || normalized.canonical,
    assetClass: symbol.assetClass !== 'unknown' ? symbol.assetClass : classifyAssetClass(normalized.canonical),
    digits: symbol.digits,
    point: symbol.point,
    pipSize: symbol.pipSize,
    contractSize: symbol.contractSize,
    minLot: symbol.minLot,
    maxLot: symbol.maxLot,
    lotStep: symbol.lotStep,
    maxLotPerOrder: symbol.maxLotPerOrder,
    quoteCurrency: symbol.quoteCurrency,
    tradeMode: symbol.tradeMode,
    swapLong: symbol.swapLong,
    swapShort: symbol.swapShort,
  };
}

/** Extracts rows from a raw `db.execute` result (pg driver shape). */
export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows: T[] }).rows ?? []) as T[];
  }
  return [];
}
