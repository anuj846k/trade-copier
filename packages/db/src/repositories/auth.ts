import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { UserRole } from '@trade-copier/contracts';
import type { Database } from '../client.js';
import { id, newToken } from '../ids.js';
import { apiKeys, refreshTokens, users } from '../schema/tables.js';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  timezone: string;
  role: UserRole;
  totpSecret: string | null;
  totpEnabled: boolean;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  timezone?: string;
  role?: UserRole;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return (row as UserRecord | undefined) ?? null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return (row as UserRecord | undefined) ?? null;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const [row] = await this.db
      .insert(users)
      .values({
        id: id('user'),
        email: input.email,
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        timezone: input.timezone ?? 'UTC',
        role: input.role ?? 'user',
      })
      .returning();
    return row as UserRecord;
  }

  async updateUser(
    userId: string,
    patch: Partial<Pick<UserRecord, 'firstName' | 'lastName' | 'timezone' | 'passwordHash' | 'lastLoginAt' | 'emailVerifiedAt'>>,
  ): Promise<UserRecord | null> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return (row as UserRecord | undefined) ?? null;
  }

  async setTotp(userId: string, secret: string | null, enabled: boolean): Promise<void> {
    await this.db.update(users).set({ totpSecret: secret, totpEnabled: enabled, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  // --- refresh tokens ------------------------------------------------------

  async createRefreshToken(input: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<void> {
    await this.db.insert(refreshTokens).values({
      id: id('refreshToken'),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    });
  }

  async findRefreshToken(tokenHash: string) {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  }

  /** Rotation: mark the old token used and link it to its replacement. */
  async rotateRefreshToken(oldHash: string, replacementHash: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedByTokenHash: replacementHash })
      .where(eq(refreshTokens.tokenHash, oldHash));
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  async countActiveSessions(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
    return row?.count ?? 0;
  }

  // --- api keys ------------------------------------------------------------

  async createApiKey(input: { userId: string; name: string; expiresAt?: Date | null }): Promise<{
    id: string;
    name: string;
    prefix: string;
    secret: string;
    expiresAt: Date | null;
    createdAt: Date;
  }> {
    const secret = newToken('tc');
    const prefix = secret.slice(0, 11);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        id: id('apiKey'),
        userId: input.userId,
        name: input.name,
        prefix,
        keyHash: hashApiKey(secret),
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return { id: row!.id, name: row!.name, prefix: row!.prefix, secret, expiresAt: row!.expiresAt, createdAt: row!.createdAt };
  }

  async findApiKeyByHash(keyHash: string) {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row ?? null;
  }

  async touchApiKey(keyId: string): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
  }

  async listApiKeys(userId: string) {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }
}

/** API keys are stored as SHA-256 (they are high-entropy, so no KDF needed). */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
