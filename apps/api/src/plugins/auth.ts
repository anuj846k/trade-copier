import jwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

/** Shared shape of the two request guards the plugin installs. */
type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const ACCESS_COOKIE = 'tc_access';
export const REFRESH_COOKIE = 'tc_refresh';

export interface AccessClaims {
  readonly sub: string;
  readonly email: string;
  readonly sid: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the access token from the cookie or the Authorization header. */
    authenticate: AuthHook;
    /** Same, but tolerates anonymous callers (request.user stays undefined). */
    optionalAuth: AuthHook;
  }
  interface FastifyRequest {
    accessClaims?: AccessClaims;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

export interface AuthPluginOptions {
  readonly env: Env;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (fastify, options) => {
    // The access token travels in a cookie when the caller is the dashboard and
    // in the `Authorization` header when it is tooling (the bridge agent, curl),
    // so both are read below.
    await fastify.register(jwt, {
      secret: options.env.JWT_SECRET,
      sign: { expiresIn: Math.floor(options.env.ACCESS_TOKEN_TTL / 1000) },
      cookie: { cookieName: ACCESS_COOKIE, signed: false },
    });

    fastify.decorateRequest('accessClaims', undefined);

    const verify = async (request: FastifyRequest): Promise<AccessClaims | null> => {
      const header = request.headers.authorization;
      const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
      const cookieToken = request.cookies?.[ACCESS_COOKIE] ?? null;
      const token = bearer ?? cookieToken;
      if (!token) return null;
      try {
        const claims = fastify.jwt.verify<AccessClaims>(token);
        request.accessClaims = claims;
        return claims;
      } catch {
        return null;
      }
    };

    fastify.decorate('authenticate', async (request: FastifyRequest) => {
      const claims = await verify(request);
      if (!claims) throw ApiError.unauthenticated();
    });

    fastify.decorate('optionalAuth', async (request: FastifyRequest) => {
      await verify(request);
    });
  },
  {
    name: 'auth',
    // `@fastify/cookie` is registered once by the server (see server.ts).
    // Registering it here as well throws "decorator 'serializeCookie' has
    // already been added" at boot, so this states the dependency instead.
    dependencies: ['@fastify/cookie'],
  },
);

/** Cookie options shared by login/refresh so the browser client behaves predictably. */
export function accessCookieOptions(env: Env) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(env.ACCESS_TOKEN_TTL / 1000),
  };
}

export function refreshCookieOptions(env: Env) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    // Only sent to the auth endpoints, so it never rides along with ordinary requests.
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  };
}
