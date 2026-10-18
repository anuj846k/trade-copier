import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashToken } from '@trade-copier/db';
import { ApiError } from '../lib/errors.js';
import { hashPassword, passwordProblems, verifyPassword } from '../lib/passwords.js';
import { randomToken } from '../lib/crypto.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../lib/totp.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, accessCookieOptions, refreshCookieOptions } from '../plugins/auth.js';

/**
 * Authentication.
 *
 * Access tokens are short-lived JWTs (cookie or `Authorization: Bearer`);
 * refresh tokens are opaque, hashed at rest, rotated on every use and grouped
 * into a family so a replayed token invalidates the whole chain — the standard
 * defence against a stolen refresh token.
 */

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  timezone: z.string().min(1).max(60).default('UTC'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totp: z.string().min(6).max(8).optional(),
});

const codeSchema = z.object({ code: z.string().min(6).max(8) });

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { repos, env } = fastify;

  async function issueSession(
    user: { id: string; email: string },
    request: FastifyRequest,
    reply: FastifyReply,
    familyId = randomUUID(),
  ): Promise<void> {
    const sid = randomUUID();
    const access = fastify.jwt.sign({ sub: user.id, email: user.email, sid });
    const refresh = randomToken('rt');
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000);
    await repos.auth.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(refresh),
      familyId,
      expiresAt,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });
    reply
      .setCookie(ACCESS_COOKIE, access, accessCookieOptions(env))
      .setCookie(REFRESH_COOKIE, refresh, refreshCookieOptions(env));
  }

  async function completeLogin(user: { id: string; email: string; totpEnabled: boolean; totpSecret: string | null }, providedTotp: string | undefined, request: FastifyRequest, reply: FastifyReply) {
    if (user.totpEnabled) {
      if (!providedTotp) {
        throw new ApiError('VALIDATION', 'Two-factor code required', 401, { totpRequired: true });
      }
      if (!user.totpSecret || !verifyTotp(providedTotp, user.totpSecret)) {
        throw ApiError.unauthenticated('Invalid two-factor code');
      }
    }
    await repos.auth.updateUser(user.id, { lastLoginAt: new Date() });
    await issueSession(user, request, reply);
  }

  // -------------------------------------------------------------------------
  // registration / login
  // -------------------------------------------------------------------------

  fastify.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const problems = passwordProblems(body.password);
    if (problems.length > 0) throw ApiError.badRequest('Password is too weak', { problems });

    const limit = fastify.rateLimiter.consume(`register:${request.ip}`, 1);
    if (!limit.allowed) throw ApiError.rateLimited('Too many sign-up attempts, try again shortly');

    const existing = await repos.auth.findUserByEmail(body.email);
    if (existing) throw ApiError.conflict('An account with that email already exists');

    const user = await repos.auth.createUser({
      email: body.email,
      passwordHash: await hashPassword(body.password),
      firstName: body.firstName,
      lastName: body.lastName,
      timezone: body.timezone,
    });
    await issueSession(user, request, reply);
    return reply.status(201).send({
      user: publicUser(user),
      accessTokenExpiresIn: Math.floor(env.ACCESS_TOKEN_TTL / 1_000),
    });
  });

  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const limit = fastify.rateLimiter.consume(`login:${request.ip}:${body.email.toLowerCase()}`, 1);
    if (!limit.allowed) throw ApiError.rateLimited('Too many sign-in attempts, try again shortly');

    const user = await repos.auth.findUserByEmail(body.email);
    // Always run a verification so a missing user and a wrong password take the
    // same time (no account enumeration through timing).
    const valid = await verifyPassword(body.password, user?.passwordHash ?? null);
    if (!user || !valid) {
      await repos.platform.audit({
        userId: user?.id ?? null,
        action: 'user.login_failed',
        meta: { email: body.email },
        ip: request.ip,
      });
      throw ApiError.unauthenticated('Email or password is incorrect');
    }

    await completeLogin(user, body.totp, request, reply);
    await repos.platform.audit({ userId: user.id, action: 'user.login', ip: request.ip });
    return reply.send({
      user: publicUser(user),
      accessTokenExpiresIn: Math.floor(env.ACCESS_TOKEN_TTL / 1_000),
    });
  });

  fastify.post('/refresh', async (request, reply) => {
    const presented = request.cookies?.[REFRESH_COOKIE];
    if (!presented) throw ApiError.unauthenticated('No refresh token');

    const record = await repos.auth.findRefreshToken(hashToken(presented));
    if (!record) throw ApiError.unauthenticated('Refresh token is not recognised');
    if (record.revokedAt) {
      // Reuse of a rotated token: assume theft, drop the whole family.
      await repos.auth.revokeRefreshTokenFamily(record.familyId);
      await repos.platform.audit({
        userId: record.userId,
        action: 'user.refresh_reuse_detected',
        meta: { familyId: record.familyId },
        ip: request.ip,
      });
      throw ApiError.unauthenticated('Refresh token was already used; sign in again');
    }
    if (record.expiresAt.getTime() <= Date.now()) throw ApiError.unauthenticated('Refresh token expired');

    const user = await repos.auth.findUserById(record.userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');

    const replacement = randomToken('rt');
    await repos.auth.rotateRefreshToken(hashToken(presented), hashToken(replacement));
    const sid = randomUUID();
    const access = fastify.jwt.sign({ sub: user.id, email: user.email, sid });
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000);
    await repos.auth.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(replacement),
      familyId: record.familyId,
      expiresAt,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });

    reply
      .setCookie(ACCESS_COOKIE, access, accessCookieOptions(env))
      .setCookie(REFRESH_COOKIE, replacement, refreshCookieOptions(env));
    return reply.send({ user: publicUser(user), accessTokenExpiresIn: Math.floor(env.ACCESS_TOKEN_TTL / 1_000) });
  });

  fastify.post('/logout', async (request, reply) => {
    const presented = request.cookies?.[REFRESH_COOKIE];
    if (presented) {
      const record = await repos.auth.findRefreshToken(hashToken(presented));
      if (record) await repos.auth.revokeRefreshTokenFamily(record.familyId);
    }
    reply.clearCookie(ACCESS_COOKIE, { path: '/' }).clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return reply.send({ ok: true });
  });

  fastify.post('/logout-all', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    await repos.auth.revokeAllUserTokens(userId);
    reply.clearCookie(ACCESS_COOKIE, { path: '/' }).clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // profile
  // -------------------------------------------------------------------------

  fastify.get('/me', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const user = await repos.auth.findUserById(userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');
    const [accounts, copiers, subscription] = await Promise.all([
      repos.platform.countAccounts(userId),
      repos.copiers.countByUser(userId),
      repos.platform.getSubscription(userId),
    ]);
    return {
      user: publicUser(user),
      usage: { accounts, copiers },
      subscription: subscription
        ? { planCode: subscription.planCode, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null }
        : null,
    };
  });

  fastify.patch('/me', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const body = z
      .object({
        firstName: z.string().min(1).max(80).optional(),
        lastName: z.string().min(1).max(80).optional(),
        timezone: z.string().min(1).max(60).optional(),
      })
      .parse(request.body);
    const updated = await repos.auth.updateUser(userId, body);
    if (!updated) throw ApiError.notFound('Account no longer exists');
    return { user: publicUser(updated) };
  });

  fastify.post('/password', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = request.accessClaims!.sub;
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) })
      .parse(request.body);
    const user = await repos.auth.findUserById(userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw ApiError.forbidden('Current password is incorrect');
    }
    const problems = passwordProblems(body.newPassword);
    if (problems.length > 0) throw ApiError.badRequest('Password is too weak', { problems });

    await repos.auth.updateUser(userId, { passwordHash: await hashPassword(body.newPassword) });
    // Every session must re-authenticate after a credential change.
    await repos.auth.revokeAllUserTokens(userId);
    fastify.ui.disconnectUser(userId, 'password changed');
    await repos.platform.audit({ userId, action: 'user.password_changed', ip: request.ip });
    reply.clearCookie(ACCESS_COOKIE, { path: '/' }).clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return reply.send({ ok: true, message: 'Password changed. Sign in again on your devices.' });
  });

  // -------------------------------------------------------------------------
  // two-factor
  // -------------------------------------------------------------------------

  fastify.post('/2fa/setup', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const user = await repos.auth.findUserById(userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');
    if (user.totpEnabled) throw ApiError.conflict('Two-factor authentication is already enabled');

    const secret = generateTotpSecret();
    await repos.auth.setTotp(userId, secret, false);
    return { secret, uri: totpUri(secret, user.email) };
  });

  fastify.post('/2fa/enable', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { code } = codeSchema.parse(request.body);
    const user = await repos.auth.findUserById(userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');
    if (!user.totpSecret) throw ApiError.badRequest('Run 2FA setup first');
    if (!verifyTotp(code, user.totpSecret)) throw ApiError.badRequest('That code is not valid right now');
    await repos.auth.setTotp(userId, user.totpSecret, true);
    await repos.platform.audit({ userId, action: 'user.2fa_enabled' });
    return { enabled: true };
  });

  fastify.post('/2fa/disable', { preHandler: fastify.authenticate }, async (request) => {
    const userId = request.accessClaims!.sub;
    const { code } = codeSchema.parse(request.body);
    const user = await repos.auth.findUserById(userId);
    if (!user) throw ApiError.unauthenticated('Account no longer exists');
    if (!user.totpEnabled || !user.totpSecret) throw ApiError.badRequest('Two-factor authentication is not enabled');
    if (!verifyTotp(code, user.totpSecret)) throw ApiError.badRequest('That code is not valid right now');
    await repos.auth.setTotp(userId, null, false);
    await repos.platform.audit({ userId, action: 'user.2fa_disabled' });
    return { enabled: false };
  });
};

function publicUser(user: { id: string; email: string; firstName: string; lastName: string; timezone: string; role: string; totpEnabled: boolean; createdAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    timezone: user.timezone,
    role: user.role,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}
